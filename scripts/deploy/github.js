'use strict';

const { REPOSITORY, REPOSITORY_URL, WORKFLOW, REQUIRED_JOBS } = require('./constants');
const { sha, fail } = require('./fs-safety');

function createGitHubClient({ token, signal, timeoutMs = 10000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('Invalid GitHub request timeout.');
  return async function getJson(endpoint) {
    const base = `/repos/${REPOSITORY}`;
    if (!(endpoint === base || endpoint === `${base}/branches/master` || endpoint.startsWith(`${base}/actions/`)) ||
        /[\s\\#%]/.test(endpoint) || endpoint.split(/[/?]/).some(part => part === '.' || part === '..')) fail('Unapproved GitHub API endpoint.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    try {
      if (signal?.aborted) fail('Operation cancelled.', 'CANCELLED');
      const response = await fetch(`https://api.github.com${endpoint}`, {
        signal: controller.signal, redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'QingSi-Games-Deploy', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (response.status !== 200) {
        const error = new Error(`GitHub verification failed: HTTP ${response.status}.`);
        error.code = 'CI_UNVERIFIED'; error.httpStatus = response.status;
        error.failureReason = response.status === 429 || response.status === 403 && response.headers?.get('x-ratelimit-remaining') === '0'
          ? 'GITHUB_RATE_LIMIT' : `GITHUB_HTTP_${response.status}`;
        throw error;
      }
      const reader = response.body.getReader();
      const chunks = [];
      let bytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) { await reader.cancel(); fail('GitHub response exceeded its size limit.', 'CI_UNVERIFIED'); }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error.code === 'CI_UNVERIFIED' || error.code === 'CANCELLED') throw error;
      // Avoid logging request headers, tokens, or a remote error body.
      const safe = new Error('GitHub result could not be verified (network, timeout or invalid response).');
      safe.code = signal?.aborted ? 'CANCELLED' : 'CI_UNVERIFIED';
      safe.failureReason = signal?.aborted ? 'CANCELLED' : timedOut ? 'GITHUB_TIMEOUT' : 'GITHUB_NETWORK_OR_RESPONSE';
      throw safe;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
}

function positive(value) { return Number.isSafeInteger(value) && value > 0; }

async function masterHead(getJson) {
  const base = `/repos/${REPOSITORY}`;
  const repository = await getJson(base);
  if (repository?.full_name !== REPOSITORY || repository.html_url !== REPOSITORY_URL || repository.default_branch !== 'master') {
    fail('Remote repository identity or approved default branch changed.', 'SOURCE_UNTRUSTED');
  }
  const branch = await getJson(`${base}/branches/master`);
  if (branch?.name !== 'master' || branch.commit?.url !== `https://api.github.com${base}/commits/${branch.commit?.sha}`) {
    fail('Remote branch identity is not the approved master.', 'SOURCE_UNTRUSTED');
  }
  return { repository: REPOSITORY, branch: 'master', commitSha: sha(branch.commit.sha) };
}

function ciNotPassed(run, message = 'CI has not passed.') {
  const error = new Error(message);
  error.code = 'CI_NOT_PASSED';
  error.ciState = ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status) && run.conclusion == null
    ? 'pending' : run.status === 'completed' && ['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'skipped', 'neutral', 'stale'].includes(run.conclusion)
      ? 'failed' : 'unknown';
  error.ciStatus = run.status; error.ciConclusion = run.conclusion;
  error.runId = run.id; error.runAttempt = run.run_attempt;
  throw error;
}

function validateRun(run, commit, workflowId) {
  if (!run || !positive(run.id) || !positive(run.run_attempt) || run.head_sha !== commit ||
      run.event !== 'push' || run.head_branch !== 'master' || run.workflow_id !== workflowId ||
      run.repository?.full_name !== REPOSITORY || run.head_repository?.full_name !== REPOSITORY ||
      typeof run.path !== 'string' || run.path.split('@')[0] !== WORKFLOW) {
    fail('CI run identity does not match the approved repository, workflow, branch and SHA.', 'CI_UNVERIFIED');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    ciNotPassed(run, `CI has not passed: ${run.status || 'unknown'}/${run.conclusion || 'no conclusion'}.`);
  }
}

async function pages(getJson, endpoint, field) {
  const result = [];
  let expected;
  for (let page = 1; page <= 10; page++) {
    const data = await getJson(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Number.isSafeInteger(data?.total_count) || data.total_count < 0 || data.total_count > 1000 || !Array.isArray(data[field])) {
      fail('CI pagination is incomplete or invalid.', 'CI_UNVERIFIED');
    }
    if (expected !== undefined && data.total_count !== expected) fail('CI results changed during pagination.', 'CI_UNVERIFIED');
    expected = data.total_count;
    result.push(...data[field]);
    if (result.length === expected) return result;
    if (result.length > expected || data[field].length === 0) break;
  }
  fail('CI pagination could not be completed.', 'CI_UNVERIFIED');
}

async function latestRun(getJson, commit, workflowId) {
  const runs = await pages(getJson, `/repos/${REPOSITORY}/actions/workflows/${workflowId}/runs?head_sha=${commit}&event=push&branch=master`, 'workflow_runs');
  if (runs.length === 0) {
    const error = new Error('No CI push run exists for the exact master SHA.');
    error.code = 'CI_UNVERIFIED'; error.ciState = 'pending'; error.failureReason = 'NO_CI_RUN';
    throw error;
  }
  const ids = new Set();
  for (const run of runs) {
    if (!positive(run.id) || ids.has(run.id) || run.head_sha !== commit || run.workflow_id !== workflowId ||
        run.event !== 'push' || run.head_branch !== 'master') fail('Unexpected CI run in exact-SHA query.', 'CI_UNVERIFIED');
    ids.add(run.id);
  }
  return runs.sort((a, b) => b.id - a.id)[0];
}

async function verifyCi(commit, getJson) {
  sha(commit);
  const base = `/repos/${REPOSITORY}/actions`;
  const workflow = await getJson(`${base}/workflows/ci.yml`);
  if (!positive(workflow?.id) || workflow.path !== WORKFLOW || workflow.state !== 'active') fail('Approved CI workflow is unavailable.', 'CI_UNVERIFIED');
  const latest = await latestRun(getJson, commit, workflow.id);
  const run = await getJson(`${base}/runs/${latest.id}`);
  validateRun(run, commit, workflow.id);
  const jobs = await pages(getJson, `${base}/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs');
  for (const name of REQUIRED_JOBS) {
    const matching = jobs.filter(job => job.name === name);
    if (matching.length !== 1) fail(`Required CI job is missing or ambiguous: ${name}.`, 'CI_UNVERIFIED');
    const job = matching[0];
    if (job.run_id !== run.id || job.head_sha !== commit) fail('Required CI job belongs to a different run or SHA.', 'CI_UNVERIFIED');
    if (job.status !== 'completed' || job.conclusion !== 'success') ciNotPassed({ ...run, status: job.status, conclusion: job.conclusion }, `Required CI job did not pass for this SHA: ${name}.`);
    const requiredSteps = name.startsWith('Checks (')
      ? ['Install dependencies', 'Identify the tested commit', 'Syntax check', 'Test']
      : name.startsWith('Security audit') ? ['Install dependencies', 'Audit production dependencies']
        : ['Require every critical check to succeed', 'Record the verified commit', 'Save version metadata'];
    for (const stepName of requiredSteps) {
      const steps = job.steps?.filter(step => step.name === stepName);
      if (steps?.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') {
        fail(`Required CI step is missing or did not pass: ${name}/${stepName}.`, 'CI_NOT_PASSED');
      }
    }
  }
  const after = await getJson(`${base}/runs/${run.id}`);
  validateRun(after, commit, workflow.id);
  const newest = await latestRun(getJson, commit, workflow.id);
  if (after.run_attempt !== run.run_attempt || newest.id !== run.id || newest.run_attempt !== run.run_attempt ||
      newest.status !== 'completed' || newest.conclusion !== 'success') fail('CI changed while verifying; no approval was issued.', 'CI_UNVERIFIED');
  return { repository: REPOSITORY, workflowId: workflow.id, workflowPath: WORKFLOW, headSha: commit,
    runId: run.id, runAttempt: run.run_attempt, verifiedAt: new Date().toISOString(),
    url: `https://github.com/${REPOSITORY}/actions/runs/${run.id}`, conclusion: 'success' };
}

module.exports = { createGitHubClient, verifyCi, masterHead, pages };
