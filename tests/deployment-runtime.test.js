'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');
const { getListenConfig } = require('../startup-port');
const { PUBLIC_URL } = require('../scripts/deploy/constants');
const { cleanEnv, localJson, processIdentity, verifyListener, sleep, run } = require('../scripts/deploy/process');
const { stableHealth, smoke, observe, validatePublicHealth } = require('../scripts/deploy/health');
const { removeTree, privateFile } = require('../scripts/deploy/fs-safety');
const { loadConfig } = require('../scripts/deploy/config');
const { request } = require('./helpers/ws-server');

const project = path.resolve(__dirname, '..');
const COMMIT = 'a'.repeat(40);
let root, directory;
const pids = [];

test.before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qrt-'));
  directory = path.join(root, 'source');
  fs.mkdirSync(directory);
  for (const name of ['server.js', 'startup-port.js', 'public-origin.js', 'internet-security.js', 'package.json', 'package-lock.json',
    'scripts/deploy/runtime.js', 'scripts/deploy/fs-safety.js', 'scripts/deploy/room-status.js', 'games/gomoku.js', 'public/js/core/gomoku.js', 'public/js/core/gomoku-ai.js',
    'bots/gomoku.js', 'bots/lib/bot-name.js']) {
    const target = path.join(directory, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(project, name), target);
  }
  fs.cpSync(path.join(project, 'lang'), path.join(directory, 'lang'), { recursive: true });
  // A physical copy, rather than a link to another release's mutable dependencies.
  fs.cpSync(path.join(project, 'node_modules'), path.join(directory, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'public/index.html'), '<html>candidate fixture</html>');
  fs.writeFileSync(path.join(directory, 'release-info.json'), JSON.stringify({ schemaVersion: 1, commitSha: COMMIT }), { mode: 0o444 });
  fs.mkdirSync(path.join(root, 'state/logs'), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, 'state'), 0o700);
});

test.after(() => {
  for (const pid of pids) {
    try { processIdentity(pid); assert.fail(`Owned test PID ${pid} is still running`); }
    catch (error) { if (error.code === 'ERR_ASSERTION') throw error; }
  }
  removeTree(os.tmpdir(), root);
});

async function freePort() {
  const probe = net.createServer(); await new Promise((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}

async function serverFixture(t, overrides = {}) {
  const port = await freePort();
  const token = crypto.randomBytes(32).toString('hex');
  const tokenFile = path.join(root, 'state', `${port}.token`), socketPath = path.join(root, 'state', `${port}.sock`);
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const env = cleanEnv({ NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1', PUBLIC_BASE_URL: PUBLIC_URL,
    QINGSI_RELEASE_FILE: path.join(directory, 'release-info.json'), QINGSI_ADMIN_SOCKET: socketPath, QINGSI_ADMIN_TOKEN_FILE: tokenFile,
    QINGSI_GAMES_STARTUP_LOG: path.join(root, 'state', `${port}.log`), ...overrides });
  const child = spawn(process.execPath, [path.join(directory, 'server.js')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  await once(child, 'spawn'); pids.push(child.pid);
  console.log(`Recorded candidate test PID: ${child.pid}`);
  const exit = once(child, 'exit');
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.terminate();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([exit, sleep(2000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.race([exit, sleep(1000)]);
    assert.ok(child.exitCode !== null || child.signalCode !== null, `Candidate cleanup failed: ${output}`);
    assert.equal(fs.existsSync(socketPath), false);
  });
  const parameters = { pid: child.pid, directory, nodePath: process.execPath, commit: COMMIT, port, socketPath, token };
  await stableHealth(parameters, async () => ({ pid: child.pid }), { timeout: 3000, observations: 1 });
  return { child, port, socketPath, token, parameters, output: () => output,
    admin: () => localJson({ socketPath, token, route: '/v1/status' }),
    drain: enabled => localJson({ socketPath, token, route: '/v1/drain', method: 'POST', body: { enabled } }),
    async connect() {
      const client = new WebSocket(`ws://127.0.0.1:${port}`, { origin: `http://127.0.0.1:${port}`, handshakeTimeout: 1500 });
      clients.push(client); await once(client, 'open'); return client;
    },
  };
}

test('listen configuration preserves LAN defaults and makes explicit candidate ports strict', () => {
  assert.deepEqual(getListenConfig({}), { port: 3000, host: '0.0.0.0' });
  assert.deepEqual(getListenConfig({ PORT: '3101', HOST: '127.0.0.1' }), { port: 3101, host: '127.0.0.1' });
  for (const port of ['', '0', '3101junk', '65536', '-1']) assert.throws(() => getListenConfig({ PORT: port }), /Invalid PORT/);
  assert.throws(() => getListenConfig({ HOST: 'untrusted.example' }), /Invalid HOST/);
});

test('candidate smoke checks real loopback ownership, HTTP SHA and WebSocket pong and exits its process', async () => {
  const port = await freePort();
  const result = await smoke({ root, candidatePort: port, healthTimeoutMs: 3000, nodePath: process.execPath }, directory, COMMIT);
  pids.push(result.pid); console.log(`Recorded candidate smoke PID: ${result.pid}`);
  assert.equal(result.commitSha, COMMIT); assert.equal(result.port, port);
  assert.equal(result.admin.blockingRooms, 0);
  assert.throws(() => processIdentity(result.pid));
  assert.equal(fs.existsSync(path.join(root, 'state', `candidate-${COMMIT.slice(0, 12)}.token`)), false);
  assert.equal(fs.existsSync(path.join(root, 'state', `candidate-${COMMIT.slice(0, 12)}.sock`)), false);
});

test('candidate port conflict fails immediately and leaves the unrelated listener alive', async t => {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const port = listener.address().port;
  await assert.rejects(smoke({ root, candidatePort: port, healthTimeoutMs: 1500, nodePath: process.execPath }, directory, COMMIT), /occupied/);
  assert.equal(listener.listening, true);
});

test('candidate smoke rejects production port 3000 before starting or probing a server', async () => {
  await assert.rejects(smoke({ root, candidatePort: 3000, healthTimeoutMs: 1000, nodePath: process.execPath }, directory, COMMIT), /production port 3000/);
});

test('configured candidate port 3101 conflict never stops the listener or starts a candidate', async t => {
  const listener = net.createServer();
  let owned = false;
  try {
    await new Promise((resolve, reject) => listener.once('error', reject).listen(3101, '127.0.0.1', resolve));
    owned = true;
  } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  t.after(() => owned ? new Promise(resolve => listener.close(resolve)) : undefined);
  await assert.rejects(smoke({ root, candidatePort: 3101, healthTimeoutMs: 1000, nodePath: process.execPath }, directory, COMMIT), /occupied/);
  if (owned) assert.equal(listener.listening, true);
  assert.equal(fs.existsSync(path.join(root, 'state', `candidate-${COMMIT.slice(0, 12)}.token`)), false);
});

test('candidate health failure closes its owned process and removes its ephemeral token', async () => {
  const commit = 'b'.repeat(40), port = await freePort();
  let failed;
  await assert.rejects(smoke({ root, candidatePort: port, healthTimeoutMs: 1000, nodePath: process.execPath }, directory, commit), error => {
    failed = error; return error.code === 'STARTUP_TIMEOUT';
  });
  assert.ok(failed.candidatePid > 1); pids.push(failed.candidatePid);
  assert.throws(() => processIdentity(failed.candidatePid));
  assert.equal(fs.existsSync(path.join(root, 'state', `candidate-${commit.slice(0, 12)}.token`)), false);
});

test('an explicitly occupied server port exits instead of falling back to another port', async t => {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  const child = spawn(process.execPath, [path.join(directory, 'server.js')], { cwd: directory,
    env: cleanEnv({ PORT: String(listener.address().port), HOST: '127.0.0.1', QINGSI_GAMES_STARTUP_LOG: path.join(root, 'state', 'conflict.log') }),
    stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child, 'spawn'); pids.push(child.pid);
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1); assert.match(output, /platform-assigned port/); assert.doesNotMatch(output, /trying \d+/);
});

test('private administration requires socket permission and token and has no public HTTP route', async t => {
  const fixture = await serverFixture(t);
  assert.equal(fs.statSync(fixture.socketPath).mode & 0o777, 0o600);
  await assert.rejects(localJson({ socketPath: fixture.socketPath, token: 'wrong', route: '/v1/status' }), /Unexpected/);
  const forgedLocal = await new Promise((resolve, reject) => {
    const request = http.get({ socketPath: fixture.socketPath, path: '/v1/status', headers: { 'X-Forwarded-For': '127.0.0.1' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.setTimeout(1000, () => request.destroy(new Error('private authorization timeout')));
    request.once('error', reject);
  });
  assert.equal(forgedLocal, 403, 'local identity headers never replace the token');
  for (const route of ['/v1/status', '/v1/drain', '/api/admin', '/api/debug/rooms']) {
    const response = await fetch(`http://127.0.0.1:${fixture.port}${route}`, {
      headers: { Authorization: `Bearer ${fixture.token}`, 'X-Forwarded-For': '127.0.0.1' }, signal: AbortSignal.timeout(1000),
    });
    assert.equal(response.status, 404);
  }
  const response = await fetch(`http://127.0.0.1:${fixture.port}/api/health`, { signal: AbortSignal.timeout(1000) });
  const health = await response.json();
  assert.equal(health.releaseSha, COMMIT);
  assert.deepEqual(Object.keys(health).sort(), ['ok', 'releaseSha', 'service', 'version']);
  const snapshot = await fixture.admin();
  assert.equal(snapshot.blockingRooms, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /resumeToken|"state"|"hands"|roomId|source|token/);
});

test('room query counts real games and reconnect grace; drain blocks new rooms without exposing private state', async t => {
  const fixture = await serverFixture(t);
  const player = await fixture.connect();
  const created = await request(player, 'create_room', { game: 'gomoku' }, 'room_created');
  assert.equal((await fixture.admin()).blockingRooms, 1);
  assert.equal((await fixture.admin()).waitingRooms, 1);
  await request(player, 'add_bot', {}, 'room_update');
  await request(player, 'player_ready', {}, 'room_update');
  await request(player, 'start_game', {}, 'game_started');
  assert.equal((await fixture.admin()).playingRooms, 1);
  assert.equal((await fixture.admin()).activeGames, 1);
  const drained = await fixture.drain(true);
  assert.equal(drained.draining, true); assert.equal(drained.blockingRooms, 1);
  const newcomer = await fixture.connect();
  for (const [type, data] of [['create_room', { game: 'gomoku' }], ['join_room', { roomId: created.roomId }]]) {
    const denied = await request(newcomer, type, data, 'error'); assert.equal(denied.code, 'SERVER_DRAINING');
  }
  const closed = once(player, 'close'); player.terminate(); await closed; await sleep(30);
  const snapshot = await fixture.admin();
  assert.equal(snapshot.blockingRooms, 1); assert.equal(snapshot.reconnectingPlayers, 1); assert.equal(snapshot.connectedPlayers, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /resumeToken|"state"|"hands"|roomId/);
});

test('an EMPTY drain snapshot keeps room admission closed until explicitly resumed', async t => {
  const fixture = await serverFixture(t);
  const idle = await fixture.drain(true);
  assert.equal(idle.roomStatus, 'EMPTY'); assert.equal(idle.blockingRooms, 0); assert.equal(idle.draining, true);
  const newcomer = await fixture.connect();
  const denied = await request(newcomer, 'create_room', { game: 'gomoku' }, 'error');
  assert.equal(denied.code, 'SERVER_DRAINING');
  assert.equal((await fixture.admin()).blockingRooms, 0);
  await fixture.drain(false);
  await request(newcomer, 'create_room', { game: 'gomoku' }, 'room_created');
  assert.equal((await fixture.admin()).waitingRooms, 1);
});

test('private room counts follow a real game from waiting to completion and back to lobby', async t => {
  const fixture = await serverFixture(t);
  const host = await fixture.connect(), guest = await fixture.connect();
  const created = await request(host, 'create_room', { game: 'gomoku' }, 'room_created');
  await request(guest, 'join_room', { roomId: created.roomId }, 'room_joined');
  await request(host, 'player_ready', {}, 'room_update', value => value.players.find(player => player.index === 0)?.ready);
  await request(guest, 'player_ready', {}, 'room_update', value => value.players.every(player => player.ready));
  assert.equal((await fixture.admin()).waitingRooms, 1);
  await request(host, 'start_game', {}, 'game_started');
  for (let step = 0; step < 9; step++) {
    const index = step % 2, row = index, col = Math.floor(step / 2);
    await request(index ? guest : host, 'game_move', { row, col, winner: 99, phase: 'over' }, 'game_state',
      value => value.state.board[row][col] === index);
    if (step === 0) assert.equal((await fixture.admin()).activeGames, 1, 'client claims cannot mark a live game completed');
  }
  const completed = await fixture.admin();
  assert.equal(completed.completedRooms, 1); assert.equal(completed.activeGames, 0);
  assert.equal(completed.blockingRooms, 1, 'players in a completed room still have restart protection');
  await request(host, 'return_to_room', {}, 'room_update', value => value.phase === 'lobby');
  const waiting = await fixture.admin();
  assert.equal(waiting.waitingRooms, 1); assert.equal(waiting.completedRooms, 0);
});

test('version and process cross-checks reject wrong SHA, wrong cwd and wrong listening port', async t => {
  const fixture = await serverFixture(t);
  verifyListener(fixture.child.pid, fixture.port);
  await assert.rejects(observe({ ...fixture.parameters, commit: 'b'.repeat(40) }), { code: 'HEALTH_FAILED' });
  await assert.rejects(observe({ ...fixture.parameters, directory: root }), { code: 'IDENTITY_FAILED' });
  assert.throws(() => verifyListener(fixture.child.pid, fixture.port + 1), { code: 'IDENTITY_FAILED' });
});

test('health rejects HTTP errors, non-JSON and a different service rather than accepting static metadata', async t => {
  let mode = '503';
  const listener = http.createServer((request, response) => {
    if (mode === 'timeout') return;
    response.writeHead(mode === '503' ? 503 : 200, { 'Content-Type': mode === 'text' ? 'text/plain' : 'application/json' });
    response.end(mode === 'text' ? 'not JSON' : mode === 'json-error' ? '{bad' : JSON.stringify({ ok: true, service: 'other-service', releaseSha: COMMIT, version: '1.5.0' }));
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => listener.close(resolve)));
  await assert.rejects(localJson({ port: listener.address().port }), /Unexpected/);
  mode = 'text'; await assert.rejects(localJson({ port: listener.address().port }), /Unexpected/);
  mode = 'json-error'; await assert.rejects(localJson({ port: listener.address().port }));
  mode = 'service'; assert.throws(() => validatePublicHealth({ ok: true, service: 'other-service', releaseSha: COMMIT, version: '1.5.0' }, COMMIT), { code: 'HEALTH_FAILED' });
  mode = 'timeout'; await assert.rejects(localJson({ port: listener.address().port, timeout: 50 }), /timed out/);
});

test('subprocess timeouts and cancellation fail closed and terminate only owned children', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 }), { code: 'COMMAND_FAILED' });
  const abort = new AbortController(); abort.abort();
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(0)'], { signal: abort.signal }), { code: 'CANCELLED' });
});

test('private configuration rejects world-readable secrets and configurable repository URLs', () => {
  const file = path.join(root, 'state', 'unsafe.json'); fs.writeFileSync(file, '{}', { mode: 0o644 });
  assert.throws(() => privateFile(file), /Private file/);
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify({ repositoryUrl: 'https://github.com/untrusted/repo' }));
  assert.throws(() => loadConfig(file), /Unknown/);
});
