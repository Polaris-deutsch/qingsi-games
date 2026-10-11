'use strict';

const assert = require('node:assert/strict');
const { REPOSITORY, REPOSITORY_URL, WORKFLOW, REQUIRED_JOBS } = require('../../scripts/deploy/constants');

function githubFixture(commit) {
  const workflow = { id: 5, path: WORKFLOW, state: 'active' };
  const run = { id: 101, workflow_id: 5, path: WORKFLOW, head_sha: commit, head_branch: 'master', event: 'push',
    repository: { full_name: REPOSITORY }, head_repository: { full_name: REPOSITORY }, run_attempt: 1, status: 'completed', conclusion: 'success' };
  const jobs = REQUIRED_JOBS.map(name => ({ name, run_id: 101, head_sha: commit, status: 'completed', conclusion: 'success', steps:
    (name.startsWith('Checks (') ? ['Install dependencies', 'Identify the tested commit', 'Syntax check', 'Test']
      : name.startsWith('Security audit') ? ['Install dependencies', 'Audit production dependencies']
        : ['Require every critical check to succeed', 'Record the verified commit', 'Save version metadata'])
      .map(name => ({ name, status: 'completed', conclusion: 'success' })) }));
  const state = { workflow, run, jobs, runs: [run], calls: [], reads: 0, remoteSha: commit, branch: 'master',
    repository: { full_name: REPOSITORY, html_url: REPOSITORY_URL, default_branch: 'master' } };
  async function getJson(endpoint) {
    state.calls.push(endpoint);
    const url = new URL(endpoint, 'https://api.github.com');
    if (url.pathname === `/repos/${REPOSITORY}`) return structuredClone(state.repository);
    if (url.pathname === `/repos/${REPOSITORY}/branches/master`) return { name: state.branch,
      commit: { sha: state.remoteSha, url: `https://api.github.com/repos/${REPOSITORY}/commits/${state.remoteSha}` } };
    if (url.pathname.endsWith('/workflows/ci.yml')) return structuredClone(workflow);
    if (url.pathname.endsWith('/workflows/5/runs')) {
      assert.equal(url.searchParams.get('head_sha'), commit);
      assert.equal(url.searchParams.get('event'), 'push'); assert.equal(url.searchParams.get('branch'), 'master');
      assert.equal(url.searchParams.has('status'), false);
      const page = Number(url.searchParams.get('page'));
      return { total_count: state.runs.length, workflow_runs: structuredClone(state.runs.slice((page - 1) * 100, page * 100)) };
    }
    if (/\/runs\/\d+\/attempts\/\d+\/jobs$/.test(url.pathname)) return { total_count: jobs.length, jobs: structuredClone(jobs) };
    if (/\/runs\/\d+$/.test(url.pathname)) { state.reads++; return structuredClone(run); }
    throw new Error('Unexpected fixture endpoint.');
  }
  return { state, getJson };
}

module.exports = { githubFixture };
