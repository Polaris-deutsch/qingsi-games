'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { createGitSource } = require('../scripts/deploy/release');
const { createSystemd } = require('../scripts/deploy/health');
const { REPOSITORY_URL, SERVICE } = require('../scripts/deploy/constants');
const { removeTree } = require('../scripts/deploy/fs-safety');
const { summarizeRooms } = require('../scripts/deploy/room-status');
const COMMIT = 'a'.repeat(40), MASTER = 'b'.repeat(40);

test('source adapter fetches only the compiled GitHub URL and archives the requested immutable SHA', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qga-'));
  t.after(() => removeTree(os.tmpdir(), root));
  fs.mkdirSync(path.join(root, 'state'));
  const candidate = path.join(root, 'candidate'); fs.mkdirSync(candidate);
  const calls = [], content = '// trusted exact source\n';
  const blob = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
  let ancestry = 0;
  const execute = async (command, args) => {
    calls.push({ command, args });
    if (command === '/usr/bin/tar') fs.writeFileSync(path.join(candidate, 'server.js'), content);
    if (args.includes('init')) {
      fs.mkdirSync(path.join(root, 'state/repository.git'));
      fs.writeFileSync(path.join(root, 'state/repository.git/config'), '[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = true\n');
    }
    if (args.includes('archive')) fs.writeFileSync(args.find(arg => arg.startsWith('--output=')).slice(9), 'mock archive');
    return { code: args.includes('merge-base') ? ancestry : 0,
      output: args.includes('rev-parse') ? `${MASTER}\n` : args.includes('cat-file') ? 'commit\n'
        : args.includes('ls-tree') ? `100644 blob ${blob}\tserver.js\0` : args.includes('show') ? 'Exact source\n' : '' };
  };
  const source = createGitSource({ root }, undefined, execute);
  const proof = await source.resolve(COMMIT); await source.materialize(proof, candidate);
  const fetch = calls.find(call => call.args.includes('fetch'));
  assert.ok(fetch.args.includes(REPOSITORY_URL));
  assert.ok(fetch.args.includes('+refs/heads/master:refs/remotes/trusted/master'));
  assert.equal(calls.find(call => call.args.includes('archive')).args.at(-1), COMMIT);
  assert.equal(fs.readFileSync(path.join(candidate, 'server.js'), 'utf8'), content);
  ancestry = 1;
  await assert.rejects(source.resolve(COMMIT), /master history/);
  fs.appendFileSync(path.join(root, 'state/repository.git/config'), '[url "file:///tmp/evil"]\ninsteadOf=https://github.com/\n');
  await assert.rejects(source.resolve(COMMIT), { code: 'SOURCE_UNTRUSTED' });
});

test('systemd adapter validates reviewed paths and invokes only the exact allowed restart', async () => {
  const config = { root: '/srv/qingsi-games', nodePath: '/usr/bin/node' };
  const properties = { Id: SERVICE, LoadState: 'loaded', Type: 'exec', User: os.userInfo().username,
    WorkingDirectory: '/srv/qingsi-games/current', KillMode: 'control-group',
    ExecStart: '{ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/qingsi-games/current/server.js ; ignore_errors=no ; start_time=n/a ; }' };
  const calls = [];
  const execute = async (command, args) => { calls.push({ command, args }); return { output: Object.entries(properties).map(([key, value]) => `${key}=${value}`).join('\n') }; };
  const systemd = createSystemd(config, execute);
  await systemd.validate(); await systemd.restart();
  assert.deepEqual(calls.at(-1), { command: '/usr/bin/sudo', args: ['-n', '/usr/bin/systemctl', 'restart', SERVICE] });
  for (const [key, value] of Object.entries({ Type: 'simple', User: 'root', WorkingDirectory: '/home/ubuntu/qingsi-games', KillMode: 'process', ExecStart: '/bin/bash run.sh' })) {
    const before = properties[key]; properties[key] = value;
    await assert.rejects(systemd.validate(), { code: 'SYSTEMD_UNVERIFIED' }); properties[key] = before;
  }
  assert.ok(calls.every(call => !call.args.includes('cloudflared.service')));
});

test('systemd adapter rejects an administration response that did not apply the requested drain state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qda-'));
  t.after(async () => {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    removeTree(os.tmpdir(), root);
  });
  const tokenFile = path.join(root, 'token'), socketPath = path.join(root, 'admin.sock');
  fs.writeFileSync(tokenFile, 'a'.repeat(64), { mode: 0o600 });
  let draining = true;
  const server = http.createServer((request, response) => {
    request.resume(); response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ schemaVersion: 1, releaseSha: COMMIT, ready: true, host: '127.0.0.1', port: 3000,
      draining, roomStatus: 'EMPTY', totalRooms: 0, waitingRooms: 0, activeGames: 0, completedRooms: 0, expiredRooms: 0, unknownRooms: 0,
      blockingRooms: 0, playingRooms: 0, connectedPlayers: 0, reconnectingPlayers: 0 }));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  const systemd = createSystemd({ adminSocket: socketPath, adminTokenFile: tokenFile });
  await assert.rejects(systemd.drain(false, COMMIT), { code: 'HEALTH_FAILED' });
  draining = false;
  assert.equal((await systemd.drain(false, COMMIT)).draining, false);
});

test('room query failures, unauthorized replies and mismatched runtime identity return UNKNOWN', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qru-'));
  const socketPath = path.join(root, 'admin.sock'), tokenFile = path.join(root, 'token');
  fs.writeFileSync(tokenFile, 'b'.repeat(64), { mode: 0o600 });
  let mode = 'valid';
  const value = { schemaVersion: 1, releaseSha: COMMIT, ready: true, host: '127.0.0.1', port: 3000,
    draining: false, ...summarizeRooms(new Map()) };
  const server = http.createServer((request, response) => {
    request.resume();
    if (mode === 'timeout') return;
    response.writeHead(mode === 'unauthorized' ? 403 : 200, { 'Content-Type': 'application/json' });
    response.end(mode === 'bad-json' ? '{' : JSON.stringify({ ...value, ...(mode === 'wrong-sha' ? { releaseSha: MASTER } : {}),
      ...(mode === 'unknown' ? { roomStatus: 'UNKNOWN' } : {}) }));
  });
  t.after(async () => { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); removeTree(os.tmpdir(), root); });
  const adapter = createSystemd({ adminSocket: socketPath, adminTokenFile: tokenFile });
  assert.equal((await adapter.rooms(COMMIT)).roomStatus, 'UNKNOWN', 'missing socket is not EMPTY');
  await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
  assert.equal((await adapter.rooms(COMMIT)).roomStatus, 'EMPTY');
  for (mode of ['unauthorized', 'bad-json', 'wrong-sha', 'unknown', 'timeout']) {
    const result = await adapter.rooms(COMMIT);
    assert.equal(result.roomStatus, 'UNKNOWN'); assert.equal(result.blockingRooms, null);
    assert.equal(result.error, 'ROOMS_UNKNOWN');
  }
});
