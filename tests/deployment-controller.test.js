'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox, SHA } = require('./helpers/deployment-sandbox');
const { pointer, setPointer, readJson, atomicJson, removeTree } = require('../scripts/deploy/fs-safety');
const { acquireLock } = require('../scripts/deploy/process');
const { parseArguments } = require('../scripts/deploy/config');
const { validateTreeListing } = require('../scripts/deploy/release');

test('prepare creates sealed independent releases for exact SHAs without restarting production', async t => {
  const { controller, root, state } = sandbox(t);
  await controller.prepare(SHA[0]); await controller.prepare(SHA[1]);
  const first = controller.release(SHA[0]), second = controller.release(SHA[1]);
  assert.equal(first.manifest.commitSha, SHA[0]);
  assert.notEqual(fs.realpathSync(path.join(first.directory, 'node_modules')), fs.realpathSync(path.join(second.directory, 'node_modules')));
  assert.equal(fs.statSync(path.join(first.directory, 'server.js')).mode & 0o222, 0);
  assert.equal(fs.readdirSync(path.join(root, 'state/candidates')).length, 0);
  assert.equal(state.restarts, 0);
  assert.deepEqual(state.npm.map(value => value.stage), ['ci', 'check', 'audit', 'ci', 'check', 'audit']);
});

test('prepare rejects invalid or abbreviated SHAs before executing any checks', async t => {
  const { controller, state } = sandbox(t);
  for (const value of ['master', '../escape', SHA[0].slice(0, 7), 'A'.repeat(40), `${SHA[0]};id`, undefined]) await assert.rejects(controller.prepare(value), /full lowercase/);
  assert.equal(state.npm.length, 0);
});

test('prepare rejects failed, cancelled and still-running CI proofs', async t => {
  const { controller, state } = sandbox(t);
  for (const conclusion of ['failure', 'cancelled', 'in_progress', null]) {
    state.ciOverride = { conclusion };
    await assert.rejects(controller.prepare(SHA[0]), { code: 'CI_UNVERIFIED' });
  }
  assert.equal(state.npm.length, 0);
});

test('prepare fails closed when CI cannot be queried or belongs to another SHA', async t => {
  const { controller, state } = sandbox(t);
  state.ciError = 'CI_UNVERIFIED';
  await assert.rejects(controller.prepare(SHA[0]), { code: 'CI_UNVERIFIED' });
  state.ciError = null; state.ciOverride = { headSha: SHA[1] };
  await assert.rejects(controller.prepare(SHA[0]), { code: 'CI_UNVERIFIED' });
  assert.equal(state.npm.length, 0);
});

test('prepare rejects a different repository or a commit outside trusted master history', async t => {
  const { controller, state } = sandbox(t);
  for (const value of [{ repositoryUrl: 'https://github.com/untrusted/repo' }, { inMasterHistory: false }, { commitSha: SHA[1] }]) {
    state.sourceOverride = value;
    await assert.rejects(controller.prepare(SHA[0]), { code: 'SOURCE_UNTRUSTED' });
  }
  assert.equal(state.npm.length, 0);
});

for (const stage of ['ci', 'audit']) test(`npm ${stage} failure removes only the candidate and preserves current`, async t => {
  const { controller, root, state, seed } = sandbox(t);
  await seed(); state.failNpm = stage;
  await assert.rejects(controller.prepare(SHA[1]), { code: 'COMMAND_FAILED' });
  assert.equal(pointer(root, 'current'), SHA[0]);
  assert.equal(fs.existsSync(path.join(root, 'releases', SHA[1])), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'state/candidates')), []);
  assert.equal(state.restarts, 0);
});

test('failed candidate health cannot publish a prepared release', async t => {
  const { controller, root, state } = sandbox(t); state.failSmoke = true;
  await assert.rejects(controller.prepare(SHA[0]), { code: 'HEALTH_FAILED' });
  assert.equal(fs.existsSync(path.join(root, 'releases', SHA[0])), false);
  assert.deepEqual(fs.readdirSync(path.join(root, 'state/candidates')), []);
});

test('real flock rejects concurrent prepare/deploy/rollback operations immediately', async t => {
  const { controller, root, state } = sandbox(t);
  const unlock = await acquireLock(path.join(root, 'state'));
  try {
    await assert.rejects(controller.prepare(SHA[0]), { code: 'LOCKED' });
    await assert.rejects(controller.deploy(SHA[0], { yes: true }), { code: 'LOCKED' });
    await assert.rejects(controller.rollback({ yes: true }), { code: 'LOCKED' });
  } finally { await unlock(); }
  assert.equal(state.npm.length, 0);
  await controller.prepare(SHA[0]);
});

test('repeated deploy of the current healthy SHA is a no-op without npm or restart', async t => {
  const { controller, state, seed } = sandbox(t); await seed();
  const count = state.npm.length;
  const result = await controller.deploy(SHA[0], { yes: true });
  assert.equal(result.result, 'unchanged'); assert.equal(state.restarts, 0); assert.equal(state.npm.length, count);
});

test('deploy saves the verified current release as previous with intact source and dependencies', async t => {
  const { controller, root, state, seed } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  const oldManifest = controller.release(SHA[0]).attestation.manifestHash;
  await controller.deploy(SHA[1], { yes: true });
  assert.equal(pointer(root, 'previous'), SHA[0]); assert.equal(state.restarts, 1);
  assert.equal(controller.release(SHA[0]).attestation.manifestHash, oldManifest);
  assert.equal(controller.healthy(SHA[0]).commitSha, SHA[0]);
});

test('deploy atomically switches current to the exact target rather than newer master', async t => {
  const { controller, root, seed, state } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  state.sourceOverride = { masterSha: SHA[9] };
  const result = await controller.deploy(SHA[1], { yes: true });
  assert.equal(pointer(root, 'current'), SHA[1]); assert.equal(result.deployedSha, SHA[1]);
  assert.equal(readJson(path.join(root, 'releases', SHA[1], 'release-info.json')).commitSha, SHA[1]);
  assert.equal(fs.existsSync(path.join(root, 'state/transaction.json')), false);
});

test('startup timeout triggers an automatic verified rollback and a failed deploy result', async t => {
  const { controller, root, seed, state, deps } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  // Candidate smoke stays healthy; only the simulated production start fails.
  deps.service.health = async (commit, directory) => {
    if (commit === SHA[1]) throw Object.assign(new Error('timeout'), { code: 'STARTUP_TIMEOUT' });
    return { verified: true, commitSha: commit, directory, port: 3000, pid: 23456, startTicks: '101' };
  };
  await assert.rejects(controller.deploy(SHA[1], { yes: true }), { code: 'DEPLOYMENT_ROLLED_BACK' });
  assert.equal(pointer(root, 'current'), SHA[0]); assert.equal(state.restarts, 2);
  assert.equal(controller.history().at(-1).result, 'rolled_back');
  assert.equal(controller.history().at(-1).healthCheck.restoredSha, SHA[0]);
});

test('wrong running SHA is rejected and restores the prior release', async t => {
  const { controller, root, seed, deps, health } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  deps.service.health = async (commit, directory) => ({ ...health(commit, directory), commitSha: commit === SHA[1] ? SHA[2] : commit });
  await assert.rejects(controller.deploy(SHA[1], { yes: true }), { code: 'DEPLOYMENT_ROLLED_BACK' });
  assert.equal(pointer(root, 'current'), SHA[0]);
});

test('rollback health failure emits a high severity error and retains the failed transaction', async t => {
  const { controller, root, seed, state } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  state.failAllAfterRestart = true;
  await assert.rejects(controller.deploy(SHA[1], { yes: true }), { code: 'ROLLBACK_FAILED' });
  assert.equal(controller.history().at(-1).result, 'rollback_failed');
  assert.equal(readJson(path.join(root, 'state/transaction.json')).phase, 'rollback_failed');
  assert.equal(fs.existsSync(path.join(root, 'releases', SHA[1])), true);
  await assert.rejects(controller.prepare(SHA[2]), { code: 'RECOVERY_REQUIRED' });
});

test('manual rollback restores only previous with a healthy record and verifies the restarted SHA', async t => {
  const { controller, root, seed, state } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  await controller.deploy(SHA[1], { yes: true });
  state.ciError = 'CI_UNVERIFIED'; // Restoring verified previous is possible during a GitHub outage.
  const result = await controller.rollback({ yes: true });
  assert.equal(result.result, 'success'); assert.equal(pointer(root, 'current'), SHA[0]);
  assert.equal(pointer(root, 'previous'), SHA[1]); assert.equal(state.restarts, 2);
});

test('deployment history is structured, records CI and health, and rotates with a bounded retention', async t => {
  const { controller, root, seed } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  await controller.deploy(SHA[1], { yes: true });
  const record = controller.history().at(-1);
  for (const field of ['deployedSha', 'previousSha', 'timestamp', 'triggerMethod', 'ci', 'result', 'rollbackReason', 'healthCheck']) assert.ok(Object.hasOwn(record, field));
  for (let index = 0; index < 500; index++) controller.record({ action: 'rotation-test', index, note: 'x'.repeat(3000) });
  assert.equal(controller.history().at(-1).index, 499);
  assert.equal(fs.existsSync(path.join(root, 'state/history.jsonl.5')), false);
  assert.ok(controller.history().length < 500);
});

test('cleanup preserves current, previous, running releases, candidates and three recent healthy versions', async t => {
  const { controller, root, state, health } = sandbox(t);
  for (const commit of SHA.slice(0, 8)) {
    await controller.prepare(commit); controller.markHealthy(commit, health(commit, path.join(root, 'releases', commit)));
    const file = controller.healthyFile(commit); const value = readJson(file);
    value.verifiedAt = new Date(Date.UTC(2026, 0, SHA.indexOf(commit) + 1)).toISOString(); atomicJson(file, value);
  }
  setPointer(root, 'current', SHA[0]); setPointer(root, 'previous', SHA[1]);
  state.extraRunning.add(path.join(root, 'releases', SHA[2]));
  const building = fs.mkdtempSync(path.join(root, 'state/candidates', 'building.'));
  await controller.cleanupUnlocked();
  for (const commit of [SHA[0], SHA[1], SHA[2], SHA[5], SHA[6], SHA[7]]) assert.equal(fs.existsSync(path.join(root, 'releases', commit)), true);
  for (const commit of [SHA[3], SHA[4]]) assert.equal(fs.existsSync(path.join(root, 'releases', commit)), false);
  assert.equal(fs.existsSync(building), true);
});

test('default deploy requires confirmation and production enablement cannot be bypassed by --yes', async t => {
  const { controller, root, seed, config, state } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  await assert.rejects(controller.deploy(SHA[1]), { code: 'NOT_AUTHORIZED' });
  config.productionEnabled = false;
  await assert.rejects(controller.deploy(SHA[1], { yes: true }), { code: 'NOT_AUTHORIZED' });
  assert.equal(pointer(root, 'current'), SHA[0]); assert.equal(state.restarts, 0);
});

test('active and unknown rooms cannot be overridden by --yes and a bare --force-active flag', async t => {
  const { controller, root, seed, state } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  state.rooms = 1;
  await assert.rejects(controller.deploy(SHA[1], { yes: true, forceActive: true }), { code: 'ROOMS_BLOCKED' });
  assert.equal(state.draining, false); assert.equal(pointer(root, 'current'), SHA[0]);
  state.rooms = 0; state.roomsUnknown = true;
  await assert.rejects(controller.deploy(SHA[1], { yes: true }), { code: 'ROOMS_BLOCKED' });
  assert.equal(state.restarts, 0);
});

test('a room created after the initial idle snapshot blocks deployment at the drain check', async t => {
  const { controller, root, seed, state } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  await assert.rejects(controller.deploy(SHA[1], { confirm: async () => {
    state.rooms = 1; // A player arrives while the operator is approving the SHA.
    return SHA[1];
  } }), { code: 'ROOMS_BLOCKED' });
  assert.equal(pointer(root, 'current'), SHA[0]); assert.equal(state.restarts, 0);
  assert.equal(state.draining, false); assert.equal(fs.existsSync(path.join(root, 'state/transaction.json')), false);
});

test('explicit room-loss confirmation permits forced deployment and prints the room warning', async t => {
  const { controller, root, seed, state } = sandbox(t); await seed(); await controller.prepare(SHA[1]); state.rooms = 1;
  await controller.deploy(SHA[1], { yes: true, forceActive: true, confirm: async () => `TERMINATE ROOMS ${SHA[1]}` });
  assert.equal(pointer(root, 'current'), SHA[1]);
  assert.ok(state.events.some(event => event.message?.includes('可能终止当前对局') && event.message.includes('断开当前玩家')));
});

test('CI revoked during room-loss confirmation prevents switching and resumes the current service', async t => {
  const { controller, root, seed, state } = sandbox(t); await seed(); await controller.prepare(SHA[1]); state.rooms = 1;
  await assert.rejects(controller.deploy(SHA[1], { yes: true, forceActive: true, confirm: async () => {
    state.ciError = 'CI_NOT_PASSED';
    return `TERMINATE ROOMS ${SHA[1]}`;
  } }), { code: 'CI_NOT_PASSED' });
  assert.equal(pointer(root, 'current'), SHA[0]); assert.equal(state.restarts, 0);
  assert.equal(state.draining, false); assert.equal(fs.existsSync(path.join(root, 'state/transaction.json')), false);
});

test('changing installed dependencies or source invalidates the immutable preparation attestation', async t => {
  const { controller, root } = sandbox(t); await controller.prepare(SHA[0]);
  const file = path.join(root, 'releases', SHA[0], 'node_modules/ws/package.json');
  fs.chmodSync(file, 0o644); fs.writeFileSync(file, '{"version":"forged"}'); fs.chmodSync(file, 0o444);
  assert.throws(() => controller.release(SHA[0]), { code: 'SOURCE_CHANGED' });
});

test('npm stages cannot silently rewrite approved source or introduce escaping module symlinks', async t => {
  const { controller, state } = sandbox(t); state.mutateSource = true;
  await assert.rejects(controller.prepare(SHA[0]), { code: 'SOURCE_CHANGED' });
  state.mutateSource = false; state.externalModuleLink = true;
  await assert.rejects(controller.prepare(SHA[0]), /symlink escapes/);
  state.externalModuleLink = false; state.extraSource = true;
  await assert.rejects(controller.prepare(SHA[0]), { code: 'SOURCE_CHANGED' });
});

test('CI policy mismatch is rejected before candidate dependency installation', async t => {
  const { controller, config, state } = sandbox(t); config.ciPolicySha256 = '0'.repeat(64);
  await assert.rejects(controller.prepare(SHA[0]), { code: 'POLICY_CHANGED' }); assert.equal(state.npm.length, 0);
});

test('approved CI policy lists retain validation of previous releases when a new policy is reviewed', async t => {
  const { controller, config } = sandbox(t); await controller.prepare(SHA[0]);
  config.ciPolicySha256 = [config.ciPolicySha256, '0'.repeat(64)];
  assert.equal(controller.release(SHA[0]).manifest.commitSha, SHA[0]);
  await controller.prepare(SHA[1]);
});

test('unsafe Git paths, URL arguments and unknown service/config arguments are rejected', () => {
  for (const args of [['prepare', SHA[0], '--repository', 'https://github.com/evil/repo'], ['deploy', SHA[0], '--service', 'cloudflared.service'], ['rollback', SHA[0]]]) assert.throws(() => parseArguments(args), /argument/);
  for (const entry of [`120000 blob ${SHA[0]}\tlink\0`, `160000 commit ${SHA[0]}\tsubmodule\0`, `100644 blob ${SHA[0]}\t../escape\0`, `100644 blob ${SHA[0]}\tnode_modules/evil\0`]) assert.throws(() => validateTreeListing(entry));
});

test('cleanup never follows an escaping release symlink or removes a protected directory', async t => {
  const { controller, root } = sandbox(t); await controller.prepare(SHA[0]);
  const outside = path.join(root, 'shared', 'keep'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
  fs.symlinkSync(outside, path.join(root, 'releases', SHA[1]));
  await controller.cleanupUnlocked(); assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'keep');
  assert.throws(() => removeTree(path.join(root, 'releases'), outside), /outside/);
  const release = path.join(root, 'releases', SHA[0]);
  assert.throws(() => removeTree(path.join(root, 'releases'), release, [release]), /protected/);
});

test('doctor reports migration and pending-transaction failures without touching systemd configuration', async t => {
  const { controller, root, seed, state } = sandbox(t); await seed(); state.invalidSystemd = true;
  await assert.rejects(controller.doctor(), { code: 'SYSTEMD_UNVERIFIED' });
  state.invalidSystemd = false;
  atomicJson(path.join(root, 'state/transaction.json'), { schemaVersion: 1, oldSha: SHA[0], targetSha: SHA[1], fallbackVerified: true });
  await assert.rejects(controller.doctor(), { code: 'RECOVERY_REQUIRED' });
  assert.equal(state.restarts, 0);
});

test('rollback recovers an interrupted pointer switch using the journaled healthy SHA', async t => {
  const { controller, root, seed, state } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  setPointer(root, 'previous', SHA[0]); setPointer(root, 'current', SHA[1]);
  atomicJson(path.join(root, 'state/transaction.json'), { schemaVersion: 1, targetSha: SHA[1], oldSha: SHA[0],
    oldPreviousSha: null, fallbackVerified: true, phase: 'switched' });
  state.failHealth.add(SHA[1]);
  await controller.rollback({ yes: true });
  assert.equal(pointer(root, 'current'), SHA[0]); assert.equal(pointer(root, 'previous'), null);
  assert.equal(fs.existsSync(path.join(root, 'state/transaction.json')), false);
});
