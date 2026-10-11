'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, SHA, ciProof } = require('./helpers/deployment-sandbox');
const { githubFixture } = require('./helpers/update-github-fixture');
const { masterHead, verifyCi, createGitHubClient } = require('../scripts/deploy/github');
const { acquireLock } = require('../scripts/deploy/process');
const { atomicJson, readJson, pointer } = require('../scripts/deploy/fs-safety');
const { parseArguments } = require('../scripts/deploy/config');
const { MAX_AGE_MS } = require('../scripts/deploy/updates');
const { REPOSITORY } = require('../scripts/deploy/constants');

async function fixture(t) {
  const ctx = sandbox(t); await ctx.seed();
  const github = githubFixture(SHA[1]);
  ctx.deps.masterHead = () => masterHead(github.getJson);
  ctx.deps.verifyCi = commit => verifyCi(commit, github.getJson);
  const initialNpm = ctx.state.npm.length;
  ctx.deps.service.restart = async () => { assert.fail('Update check attempted to restart the game service.'); };
  ctx.deps.service.drain = async () => { assert.fail('Update check attempted to modify room admission.'); };
  const sourceResolve = ctx.deps.source.resolve;
  let sourceCalls = 0;
  ctx.deps.source.resolve = (...args) => { sourceCalls++; return sourceResolve(...args); };
  const currentLink = fs.readlinkSync(path.join(ctx.root, 'current'));
  return { ...ctx, github, file: path.join(ctx.root, 'state/updates/status.json'),
    unchanged() {
      assert.equal(pointer(ctx.root, 'current'), SHA[0]);
      assert.equal(fs.readlinkSync(path.join(ctx.root, 'current')), currentLink);
      assert.equal(ctx.state.npm.length, initialNpm); assert.equal(ctx.state.restarts, 0); assert.equal(sourceCalls, 0);
      assert.deepEqual(fs.readdirSync(path.join(ctx.root, 'state/candidates')), []);
      assert.equal(fs.existsSync(path.join(ctx.root, 'releases', SHA[1])), false);
      ctx.controller.release(SHA[0]);
    } };
}

test('same verified running SHA records no-update without querying unrelated CI', async t => {
  const ctx = await fixture(t); ctx.github.state.remoteSha = SHA[0];
  const result = await ctx.controller.checkUpdates();
  assert.equal(result.status, 'up-to-date'); assert.equal(result.result, 'no-update'); assert.equal(result.persisted, true);
  assert.equal(result.ci.state, 'not-checked'); assert.equal(ctx.github.state.calls.some(url => url.includes('/actions/')), false);
  assert.equal(readJson(ctx.file).status, 'up-to-date'); ctx.unchanged();
});

test('new master SHA is available only after exact CI jobs and steps pass; prepare remains manual', async t => {
  const ctx = await fixture(t);
  const result = await ctx.controller.checkUpdates();
  assert.equal(result.status, 'update-available'); assert.equal(result.remoteSha, SHA[1]);
  assert.equal(result.ci.proof.headSha, SHA[1]); assert.equal(result.ci.proof.runAttempt, 1);
  assert.equal(result.releaseStatus, 'NEEDS_PREPARE'); assert.equal(result.automaticDeploy, false);
  assert.equal(fs.statSync(ctx.file).mode & 0o777, 0o600); ctx.unchanged();
});

for (const conclusion of ['failure', 'cancelled', 'timed_out']) test(`latest CI ${conclusion} is ci-failed and cannot reuse an older green run`, async t => {
  const ctx = await fixture(t), gh = ctx.github.state;
  gh.runs = [{ ...gh.run, id: 100 }, gh.run]; gh.run.conclusion = conclusion;
  const result = await ctx.controller.checkUpdates();
  assert.equal(result.status, 'ci-failed'); assert.equal(result.ci.conclusion, conclusion);
  assert.equal(result.releaseStatus, 'REJECTED');
  assert.equal((await ctx.controller.status()).releaseStatus, 'REJECTED'); ctx.unchanged();
});

for (const status of ['queued', 'in_progress', 'waiting']) test(`CI ${status} is pending and never an available update`, async t => {
  const ctx = await fixture(t); ctx.github.state.run.status = status; ctx.github.state.run.conclusion = null;
  const result = await ctx.controller.checkUpdates();
  assert.equal(result.status, 'ci-pending'); assert.equal(result.ci.state, 'pending');
  assert.equal(result.releaseStatus, 'PENDING');
  assert.equal((await ctx.controller.status()).releaseStatus, 'PENDING'); ctx.unchanged();
});

test('missing exact-SHA CI is explicitly NO_CI_RUN; incomplete successful checks remain unverified', async t => {
  const ctx = await fixture(t); ctx.github.state.runs = [];
  const missing = await ctx.controller.checkUpdates();
  assert.equal(missing.status, 'ci-pending'); assert.equal(missing.ci.reason, 'NO_CI_RUN');
  assert.equal(missing.releaseStatus, 'NO_CI_RUN');
  assert.equal((await ctx.controller.status()).releaseStatus, 'NO_CI_RUN');
  ctx.github.state.runs = [ctx.github.state.run]; ctx.github.state.jobs.pop();
  const incomplete = await ctx.controller.checkUpdates();
  assert.equal(incomplete.status, 'check-failed'); assert.equal(incomplete.releaseStatus, 'CHECK_FAILED'); ctx.unchanged();
});

test('GitHub timeout and DNS failure replace previous availability with check-failed', async t => {
  const ctx = await fixture(t);
  await ctx.controller.checkUpdates();
  for (const reason of ['GITHUB_TIMEOUT', 'GITHUB_NETWORK_OR_RESPONSE']) {
    ctx.deps.masterHead = async () => { throw Object.assign(new Error('private failure text'), { code: 'CI_UNVERIFIED', failureReason: reason }); };
    const result = await ctx.controller.checkUpdates();
    assert.equal(result.status, 'check-failed'); assert.equal(result.error, reason);
    assert.equal(readJson(ctx.file).status, 'check-failed');
    assert.equal((await ctx.controller.status()).releaseStatus, 'CHECK_FAILED');
    assert.equal(JSON.stringify(ctx.state.events).includes('private failure text'), false);
  }
  ctx.unchanged();
});

test('real GitHub client timeout is bounded and an optional token never reaches logs', async t => {
  const ctx = await fixture(t), original = global.fetch, token = 'private-test-token';
  t.after(() => { global.fetch = original; });
  global.fetch = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error(token)), { once: true }));
  };
  const client = createGitHubClient({ token, timeoutMs: 15 });
  ctx.deps.masterHead = () => masterHead(client);
  const result = await ctx.controller.checkUpdates();
  assert.equal(result.status, 'check-failed'); assert.equal(result.error, 'GITHUB_TIMEOUT');
  assert.equal(JSON.stringify(ctx.state.events).includes(token), false); assert.equal(fs.readFileSync(ctx.file, 'utf8').includes(token), false);
  ctx.unchanged();
});

test('rate limits and inaccessible repository responses are check-failed without automatic retries', async t => {
  const ctx = await fixture(t), original = global.fetch;
  t.after(() => { global.fetch = original; });
  for (const status of [429, 403, 404, 503]) {
    let calls = 0;
    global.fetch = async (url, options) => {
      calls++; assert.equal(options.headers.Authorization, undefined);
      return { status, headers: new Headers(status === 403 ? { 'x-ratelimit-remaining': '0' } : {}) };
    };
    ctx.deps.masterHead = () => masterHead(createGitHubClient());
    const result = await ctx.controller.checkUpdates();
    assert.equal(result.status, 'check-failed'); assert.equal(calls, 1);
    assert.equal(result.error, status === 429 || status === 403 ? 'GITHUB_RATE_LIMIT' : `GITHUB_HTTP_${status}`);
  }
  ctx.unchanged();
});

test('wrong repository, non-master branch, invalid SHA and CI from another branch are rejected', async t => {
  for (const mutate of [gh => { gh.repository.full_name = 'evil/repo'; }, gh => { gh.branch = 'develop'; },
    gh => { gh.remoteSha = 'short'; }, gh => { gh.run.head_branch = 'develop'; }, gh => { gh.run.head_sha = SHA[2]; }]) {
    const ctx = await fixture(t); mutate(ctx.github.state);
    assert.equal((await ctx.controller.checkUpdates()).status, 'check-failed'); ctx.unchanged();
  }
  const client = createGitHubClient();
  for (const endpoint of ['/repos/evil/repo', `/repos/${REPOSITORY}/branches/develop`, `/repos/${REPOSITORY}/actions/../../evil`, `/repos/${REPOSITORY}/actions/%2e%2e/evil`]) {
    await assert.rejects(client(endpoint), /Unapproved/);
  }
});

test('master moving during CI verification fails without following the new commit', async t => {
  const ctx = await fixture(t); let reads = 0;
  ctx.deps.masterHead = async () => ({ repository: REPOSITORY, branch: 'master', commitSha: ++reads === 1 ? SHA[1] : SHA[2] });
  const result = await ctx.controller.checkUpdates();
  assert.equal(result.status, 'check-failed'); assert.equal(result.error, 'REMOTE_CHANGED'); assert.equal(result.remoteSha, SHA[1]); ctx.unchanged();
});

test('repeated checks keep a bounded history, do not repeat notifications or accumulate candidates', async t => {
  const ctx = await fixture(t); const notices = [];
  ctx.deps.notifyUpdate = async value => notices.push(value.remoteSha);
  for (let index = 0; index < 26; index++) assert.equal((await ctx.controller.checkUpdates()).status, 'update-available');
  const stored = readJson(ctx.file);
  assert.equal(stored.recentChecks.length, 24); assert.ok(fs.statSync(ctx.file).size < 65536);
  assert.deepEqual(notices, [SHA[1]]); ctx.unchanged();
});

test('concurrent update checks use real flock; the rejected check cannot overwrite the owner state', async t => {
  const ctx = await fixture(t);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; }); t.after(release);
  const original = ctx.deps.masterHead; let blocked = false;
  ctx.deps.masterHead = async () => { if (!blocked) { blocked = true; entered(); await gate; } return original(); };
  const first = ctx.controller.checkUpdates(); await ready;
  const second = await ctx.controller.checkUpdates();
  assert.equal(second.status, 'check-failed'); assert.equal(second.error, 'LOCKED'); assert.equal(second.persisted, false);
  assert.equal(fs.existsSync(ctx.file), false);
  release(); assert.equal((await first).status, 'update-available'); ctx.unchanged();
});

test('a deployment lock and an interrupted deployment both block checks without service changes', async t => {
  const ctx = await fixture(t); const unlock = await acquireLock(ctx.controller.state);
  try { assert.equal((await ctx.controller.checkUpdates()).error, 'LOCKED'); } finally { await unlock(); }
  atomicJson(path.join(ctx.controller.state, 'transaction.json'), { schemaVersion: 1, oldSha: SHA[0], targetSha: SHA[1] });
  assert.equal((await ctx.controller.checkUpdates()).error, 'RECOVERY_REQUIRED'); ctx.unchanged();
});

test('manual prepare failure leaves detected update informational and current running version intact', async t => {
  const ctx = await fixture(t); await ctx.controller.checkUpdates(); ctx.state.failNpm = 'ci';
  await assert.rejects(ctx.controller.prepare(SHA[1]), { code: 'COMMAND_FAILED' });
  const status = await ctx.controller.status();
  assert.equal(status.updates.status, 'update-available'); assert.equal(status.releaseStatus, 'NEEDS_PREPARE');
  assert.equal(status.latestPreparation.result, 'failed'); assert.equal(pointer(ctx.root, 'current'), SHA[0]);
  assert.equal(ctx.state.restarts, 0); assert.deepEqual(fs.readdirSync(path.join(ctx.root, 'state/candidates')), []);
});

test('manual deploy revalidates CI even when the update cache and candidate were READY', async t => {
  const ctx = await fixture(t); await ctx.controller.prepare(SHA[1]); await ctx.controller.checkUpdates();
  assert.equal((await ctx.controller.status()).releaseStatus, 'READY');
  ctx.github.state.run.status = 'in_progress'; ctx.github.state.run.conclusion = null;
  await assert.rejects(ctx.controller.deploy(SHA[1], { yes: true }), { code: 'CI_NOT_PASSED' });
  assert.equal(pointer(ctx.root, 'current'), SHA[0]); assert.equal(ctx.state.restarts, 0);
});

test('ENOSPC during manual preparation removes only the candidate and preserves current', async t => {
  const ctx = await fixture(t); await ctx.controller.checkUpdates();
  ctx.deps.npm = async () => { throw Object.assign(new Error('No disk space'), { code: 'ENOSPC' }); };
  await assert.rejects(ctx.controller.prepare(SHA[1]), { code: 'ENOSPC' });
  assert.equal(pointer(ctx.root, 'current'), SHA[0]); assert.equal(ctx.state.restarts, 0);
  assert.deepEqual(fs.readdirSync(path.join(ctx.root, 'state/candidates')), []);
  assert.equal((await ctx.controller.status()).latestPreparation.reason, 'ENOSPC');
});

test('ENOSPC writing update state fails closed, cleans its temporary file and keeps the prior timestamp', async t => {
  const ctx = await fixture(t); await ctx.controller.checkUpdates();
  const original = fs.writeFileSync, before = fs.readFileSync(ctx.file, 'utf8');
  t.after(() => { fs.writeFileSync = original; });
  fs.writeFileSync = function (file, ...args) {
    if (typeof file === 'number' && fs.readlinkSync(`/proc/self/fd/${file}`).startsWith(`${ctx.file}.`)) {
      throw Object.assign(new Error('Full disk'), { code: 'ENOSPC' });
    }
    return original.call(this, file, ...args);
  };
  const result = await ctx.controller.checkUpdates();
  assert.equal(result.status, 'check-failed'); assert.equal(result.error, 'ENOSPC'); assert.equal(result.persisted, false);
  assert.equal(fs.readFileSync(ctx.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.dirname(ctx.file)), ['status.json']); ctx.unchanged();
});

test('interrupted checks record cancelled and release their lock without preparing or restarting', async t => {
  const ctx = await fixture(t), abort = new AbortController();
  ctx.deps.signal = abort.signal;
  const original = ctx.deps.masterHead;
  ctx.deps.masterHead = async () => { const result = await original(); abort.abort(); return result; };
  const result = await ctx.controller.checkUpdates();
  assert.equal(result.status, 'check-failed'); assert.equal(result.error, 'CANCELLED'); assert.equal(result.persisted, true);
  const unlock = await acquireLock(ctx.controller.state); await unlock(); ctx.unchanged();
});

for (const kind of ['active', 'unknown']) test(`${kind} rooms never become READY even when a candidate and CI are ready`, async t => {
  const ctx = await fixture(t); await ctx.controller.prepare(SHA[1]);
  if (kind === 'active') ctx.state.rooms = 1; else ctx.state.roomsUnknown = true;
  const result = await ctx.controller.checkUpdates(), status = await ctx.controller.status();
  assert.equal(result.status, 'update-available'); assert.equal(status.roomStatus, kind === 'active' ? 'ACTIVE' : 'UNKNOWN');
  assert.equal(status.blockingRooms, kind === 'active' ? 1 : null);
  assert.equal(status.releaseStatus, kind === 'active' ? 'WAITING_FOR_ROOMS' : 'ROOMS_UNKNOWN');
  assert.equal(ctx.state.restarts, 0); assert.equal(pointer(ctx.root, 'current'), SHA[0]);
});

test('status combines real candidate and deployment history while stale or mismatched caches never become READY', async t => {
  const ctx = await fixture(t); await ctx.controller.prepare(SHA[1]); await ctx.controller.checkUpdates();
  let status = await ctx.controller.status();
  assert.equal(status.releaseStatus, 'READY'); assert.equal(status.latestCandidate.commitSha, SHA[1]); assert.equal(status.latestDeployment, null);
  ctx.controller.record({ action: 'deploy', deployedSha: SHA[0], previousSha: null, result: 'success', triggerMethod: 'sandbox' });
  const value = readJson(ctx.file); value.checkedAt = new Date(Date.now() - MAX_AGE_MS - 1).toISOString(); atomicJson(ctx.file, value);
  status = await ctx.controller.status(); assert.equal(status.updates.stale, true); assert.equal(status.releaseStatus, 'CHECK_REQUIRED');
  assert.equal(status.latestDeployment.commitSha, SHA[0]);
  value.checkedAt = new Date().toISOString(); value.currentSha = SHA[2]; atomicJson(ctx.file, value);
  assert.equal((await ctx.controller.status()).releaseStatus, 'CHECK_REQUIRED');
});

test('unverified running identity and corrupt cache cannot report up-to-date or READY', async t => {
  const ctx = await fixture(t); ctx.github.state.remoteSha = SHA[0]; ctx.state.failHealth.add(SHA[0]);
  ctx.deps.verifyCi = async commit => ciProof(commit);
  const result = await ctx.controller.checkUpdates();
  assert.equal(result.status, 'check-failed'); assert.equal(result.error, 'CURRENT_UNVERIFIED');
  fs.writeFileSync(ctx.file, '{broken', { mode: 0o600 });
  const status = await ctx.controller.status(); assert.equal(status.updates.status, 'check-failed'); assert.notEqual(status.releaseStatus, 'READY');
});

test('notifier errors are sanitized and cannot change the recorded check result', async t => {
  const ctx = await fixture(t); ctx.deps.notifyUpdate = async () => { throw new Error('notifier-secret'); };
  assert.equal((await ctx.controller.checkUpdates()).status, 'update-available');
  assert.equal(readJson(ctx.file).status, 'update-available'); assert.ok(ctx.state.events.some(value => value.action === 'notifier-failed'));
  assert.equal(JSON.stringify(ctx.state.events).includes('notifier-secret'), false); ctx.unchanged();
});

test('update command forbids implicit approval, URL arguments and automatic preparation switches', () => {
  assert.equal(parseArguments(['check-updates']).command, 'check-updates');
  for (const argument of ['--yes', '--force-active', '--prepare', '--repository', SHA[1]]) assert.throws(() => parseArguments(['check-updates', argument]));
});

test('timer template is hourly with randomized persistent catch-up and a bounded check-only oneshot', () => {
  const folder = path.join(__dirname, '../scripts/deploy');
  const service = fs.readFileSync(path.join(folder, 'qingsi-games-update-check.service'), 'utf8');
  const timer = fs.readFileSync(path.join(folder, 'qingsi-games-update-check.timer'), 'utf8');
  assert.match(service, /^Type=oneshot$/m); assert.match(service, /^Restart=no$/m); assert.match(service, /^TimeoutStartSec=75$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/opt\/qingsi-games-deploy\/cli.js check-updates$/m);
  assert.match(service, /^NoNewPrivileges=yes$/m); assert.match(service, /^ProtectSystem=strict$/m);
  assert.match(service, /^ReadWritePaths=\/srv\/qingsi-games\/state\/updates \/srv\/qingsi-games\/state\/deploy.lock$/m);
  assert.doesNotMatch(service, /systemctl|sudo|git reset|ExecStartPost|Requires=qingsi-games/);
  assert.match(timer, /^OnCalendar=hourly$/m); assert.match(timer, /^RandomizedDelaySec=10m$/m); assert.match(timer, /^Persistent=true$/m);
  assert.match(timer, /^Unit=qingsi-games-update-check\.service$/m);
});
