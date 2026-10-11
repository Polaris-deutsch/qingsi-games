'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyCi, createGitHubClient } = require('../scripts/deploy/github');
const { REPOSITORY, WORKFLOW, REQUIRED_JOBS } = require('../scripts/deploy/constants');
const COMMIT = 'a'.repeat(40);

function fixture() {
  const workflow = { id: 5, path: WORKFLOW, state: 'active' };
  const run = { id: 101, workflow_id: 5, path: WORKFLOW, head_sha: COMMIT, head_branch: 'master', event: 'push',
    repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, run_attempt: 1, status: 'completed', conclusion: 'success' };
  const jobs = REQUIRED_JOBS.map(name => ({ name, run_id: 101, head_sha: COMMIT, status: 'completed', conclusion: 'success', steps:
    (name.startsWith('Checks (') ? ['Install dependencies', 'Identify the tested commit', 'Syntax check', 'Test']
      : name.startsWith('Security audit') ? ['Install dependencies', 'Audit production dependencies']
        : ['Require every critical check to succeed', 'Record the verified commit', 'Save version metadata'])
      .map(name => ({ name, status: 'completed', conclusion: 'success' })) }));
  const state = { workflow, run, jobs, runs: [run], calls: [], reads: 0 };
  const getJson = async endpoint => {
    state.calls.push(endpoint);
    const url = new URL(endpoint, 'https://api.github.com');
    if (url.pathname.endsWith('/workflows/ci.yml')) return structuredClone(workflow);
    if (url.pathname.endsWith('/workflows/5/runs')) {
      assert.equal(url.searchParams.get('head_sha'), COMMIT);
      assert.equal(url.searchParams.get('event'), 'push'); assert.equal(url.searchParams.get('branch'), 'master');
      assert.equal(url.searchParams.has('status'), false);
      const page = Number(url.searchParams.get('page'));
      return { total_count: state.runs.length, workflow_runs: structuredClone(state.runs.slice((page - 1) * 100, page * 100)) };
    }
    if (/\/runs\/\d+\/attempts\/\d+\/jobs$/.test(url.pathname)) return { total_count: jobs.length, jobs: structuredClone(jobs) };
    if (/\/runs\/\d+$/.test(url.pathname)) {
      state.reads++;
      return structuredClone({ ...run, ...(state.changeAttempt && state.reads > 1 ? { run_attempt: 2 } : {}) });
    }
    throw new Error('Unexpected fixture endpoint.');
  };
  return { state, getJson };
}

test('CI verifies the precise workflow, full SHA, run attempt, six jobs and required steps', async () => {
  const { getJson } = fixture();
  const proof = await verifyCi(COMMIT, getJson);
  assert.equal(proof.headSha, COMMIT); assert.equal(proof.workflowId, 5); assert.equal(proof.runAttempt, 1);
});

test('a newer failed or cancelled run cannot be hidden by an older green run', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'neutral']) {
    const { state, getJson } = fixture();
    state.runs = [{ ...state.run, id: 100 }, state.run]; state.run.conclusion = conclusion;
    await assert.rejects(verifyCi(COMMIT, getJson), { code: 'CI_NOT_PASSED' });
  }
});

test('queued, running and missing CI are not deployable', async () => {
  for (const status of ['queued', 'in_progress', 'waiting']) {
    const { state, getJson } = fixture(); state.run.status = status; state.run.conclusion = null;
    await assert.rejects(verifyCi(COMMIT, getJson), { code: 'CI_NOT_PASSED' });
  }
  const { state, getJson } = fixture(); state.runs = [];
  await assert.rejects(verifyCi(COMMIT, getJson), { code: 'CI_UNVERIFIED' });
});

test('wrong commit, repository, PR event, branch or workflow identity is rejected', async () => {
  for (const value of [{ head_sha: 'b'.repeat(40) }, { repository: { full_name: 'untrusted/repo' } },
    { head_repository: { full_name: 'untrusted/repo' } }, { event: 'pull_request' }, { head_branch: 'main' }, { path: '.github/workflows/release.yml' }]) {
    const { state, getJson } = fixture(); Object.assign(state.run, value);
    await assert.rejects(verifyCi(COMMIT, getJson), { code: 'CI_UNVERIFIED' });
  }
});

test('a green workflow with a missing, duplicated or skipped required job is rejected', async () => {
  for (const mutation of [jobs => jobs.pop(), jobs => jobs.push({ ...jobs[0] }), jobs => { jobs[0].conclusion = 'skipped'; },
    jobs => { jobs[0].head_sha = 'b'.repeat(40); }, jobs => { jobs[0].steps[0].conclusion = 'failure'; }, jobs => { jobs[0].steps.pop(); }]) {
    const { state, getJson } = fixture(); mutation(state.jobs);
    await assert.rejects(verifyCi(COMMIT, getJson));
  }
});

test('reruns that start during CI verification revoke the approval', async () => {
  const { state, getJson } = fixture(); state.changeAttempt = true;
  await assert.rejects(verifyCi(COMMIT, getJson), { code: 'CI_UNVERIFIED' });
  const second = fixture(); let lists = 0;
  const lateChange = async endpoint => {
    const response = await second.getJson(endpoint);
    if (endpoint.includes('/workflows/5/runs') && ++lists > 1) Object.assign(response.workflow_runs[0], { run_attempt: 2, status: 'in_progress', conclusion: null });
    return response;
  };
  await assert.rejects(verifyCi(COMMIT, lateChange), { code: 'CI_UNVERIFIED' });
});

test('CI consumes pagination and does not accept incomplete response totals', async () => {
  const { state, getJson } = fixture();
  state.runs = Array.from({ length: 101 }, (_, index) => ({ ...state.run, id: index + 1 }));
  assert.equal((await verifyCi(COMMIT, getJson)).runId, 101);
  assert.ok(state.calls.some(url => url.includes('page=2')));
  const broken = async endpoint => {
    const response = await getJson(endpoint);
    if (endpoint.includes('/workflows/5/runs')) response.total_count++;
    return response;
  };
  await assert.rejects(verifyCi(COMMIT, broken), { code: 'CI_UNVERIFIED' });
});

test('GitHub client rejects network failures and HTTP errors without logging its token', async t => {
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  const secret = 'test-secret-must-not-appear';
  const client = createGitHubClient({ token: secret });
  global.fetch = async () => { throw new Error(secret); };
  await assert.rejects(client(`/repos/${REPOSITORY}/actions/workflows/ci.yml`), error => error.code === 'CI_UNVERIFIED' && !error.message.includes(secret));
  global.fetch = async () => ({ status: 503 });
  await assert.rejects(client(`/repos/${REPOSITORY}/actions/workflows/ci.yml`), /HTTP 503/);
  await assert.rejects(client('/repos/untrusted/repo/actions/runs'), /Unapproved/);
});
