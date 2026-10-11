'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { fail, privateFile, noSymlinkPath } = require('./fs-safety');
const { PUBLIC_URL, SERVICE } = require('./constants');
const { run, cleanEnv, sleep, processIdentity, verifyListener, localJson, portAvailable } = require('./process');
const { isKnownRoomSummary, unknownRoomSummary } = require('./room-status');

function websocketCheck(port) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const payload = Buffer.from('qingsi-deploy');
    let socket, finished = false;
    const request = http.request({ host: '127.0.0.1', port, path: '/', agent: false, headers: {
      Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', Origin: `http://127.0.0.1:${port}`,
    } });
    const timer = setTimeout(() => finish(new Error('WebSocket handshake/pong timed out.')), 1500);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket?.destroy(); request.destroy();
      if (error) reject(error); else resolve();
    }
    request.once('error', finish);
    request.once('response', response => { response.resume(); finish(new Error('WebSocket upgrade rejected.')); });
    request.once('upgrade', (response, upgraded, head) => {
      socket = upgraded;
      socket.once('error', finish);
      if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket' ||
          !response.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade') || response.headers['sec-websocket-accept'] !== expectedAccept) {
        finish(new Error('Invalid WebSocket upgrade.')); return;
      }
      let buffered = head;
      const receive = chunk => {
        buffered = Buffer.concat([buffered, chunk]);
        if (buffered.length > 1024 || buffered.length >= 2 && (buffered[0] !== 0x8a || buffered[1] !== payload.length)) {
          finish(new Error('Invalid WebSocket pong.')); return;
        }
        if (buffered.length >= payload.length + 2) {
          if (!buffered.subarray(2, payload.length + 2).equals(payload)) finish(new Error('WebSocket pong did not match the probe.'));
          else finish();
        }
      };
      socket.on('data', receive);
      const mask = crypto.randomBytes(4);
      const frame = Buffer.alloc(payload.length + 6);
      frame[0] = 0x89; frame[1] = 0x80 | payload.length; mask.copy(frame, 2);
      for (let index = 0; index < payload.length; index++) frame[index + 6] = payload[index] ^ mask[index % 4];
      socket.write(frame);
      if (head.length) receive(Buffer.alloc(0));
    });
    request.end();
  });
}

function validateSnapshot(snapshot, commit, port, { requireEmpty = false } = {}) {
  if (snapshot?.schemaVersion !== 1 || snapshot.releaseSha !== commit || snapshot.ready !== true || snapshot.host !== '127.0.0.1' ||
      snapshot.port !== port || typeof snapshot.draining !== 'boolean') fail('Private runtime identity is invalid.', 'HEALTH_FAILED');
  if (!isKnownRoomSummary(snapshot)) fail('Room status is not verifiable.', 'ROOMS_UNKNOWN');
  if (requireEmpty && (snapshot.blockingRooms || snapshot.connectedPlayers || snapshot.reconnectingPlayers)) fail('Candidate smoke unexpectedly created room state.', 'HEALTH_FAILED');
  return snapshot;
}

function validatePublicHealth(health, commit) {
  if (health?.ok !== true || health.service !== 'qingsi-games' || health.releaseSha !== commit || typeof health.version !== 'string' || !health.version) {
    fail('HTTP health returned an unexpected service or SHA.', 'HEALTH_FAILED');
  }
  return health;
}

async function observe({ pid, directory, nodePath, commit, port, socketPath, token, production = false, controlGroup }) {
  const identity = processIdentity(pid);
  const entrypoint = path.join(directory, 'server.js');
  if (identity.uid !== process.getuid() || identity.cwd !== directory || identity.executable !== fs.realpathSync(nodePath) ||
      identity.args.length !== 2 || fs.realpathSync(path.resolve(identity.cwd, identity.args[1])) !== entrypoint) {
    fail('Running process does not match the release directory and exact server entrypoint.', 'IDENTITY_FAILED');
  }
  if (identity.env.NODE_ENV !== 'production' || identity.env.PORT !== String(port) || identity.env.HOST !== '127.0.0.1' ||
      identity.env.PUBLIC_BASE_URL !== PUBLIC_URL || identity.env.GAMENEST_DEBUG === '1' || identity.env.ANDROID_SKIP_REGISTRY_LOAD) {
    fail('Running process has an unapproved environment.', 'IDENTITY_FAILED');
  }
  if (production && (!controlGroup || !identity.cgroup.split('\n').some(line => line.endsWith(`:${controlGroup}`)))) {
    fail('MainPID is outside the approved systemd control group.', 'IDENTITY_FAILED');
  }
  verifyListener(pid, port);
  const health = await localJson({ port });
  validatePublicHealth(health, commit);
  const admin = validateSnapshot(await localJson({ socketPath, token, route: '/v1/status' }), commit, port, { requireEmpty: !production });
  await websocketCheck(port);
  const after = processIdentity(pid);
  if (after.startTicks !== identity.startTicks || after.cwd !== directory) fail('Process identity changed during health verification.', 'IDENTITY_FAILED');
  verifyListener(pid, port);
  return { verified: true, commitSha: commit, directory, pid, startTicks: identity.startTicks, port, admin };
}

async function stableHealth(parameters, getProcess, { timeout = 10000, signal, observations = 3 } = {}) {
  const deadline = Date.now() + timeout;
  let consecutive = 0, lastBirth = null, lastCode = 'STARTUP_TIMEOUT';
  while (Date.now() < deadline) {
    if (signal?.aborted) fail('Operation cancelled.', 'CANCELLED');
    try {
      const process = await getProcess();
      const proof = await observe({ ...parameters, ...process });
      if (lastBirth !== `${proof.pid}:${proof.startTicks}`) consecutive = 0;
      lastBirth = `${proof.pid}:${proof.startTicks}`;
      if (++consecutive >= observations) return proof;
    } catch (error) { consecutive = 0; lastCode = error.code || 'HEALTH_FAILED'; }
    await sleep(250);
  }
  fail(`Service did not become stably healthy (${lastCode}).`, 'STARTUP_TIMEOUT');
}

function createSystemd(config, execute = run) {
  const properties = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'Type', 'User', 'WorkingDirectory', 'ExecStart', 'KillMode', 'ControlGroup'];
  async function show() {
    const result = await execute('/usr/bin/systemctl', ['show', SERVICE, `--property=${properties.join(',')}`, '--no-pager'], { timeout: 3000 });
    const data = Object.fromEntries(result.output.trim().split('\n').map(line => {
      const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
    }));
    return data;
  }
  function validate(data) {
    const expected = `${config.nodePath} ${config.root}/current/server.js`;
    if (data.Id !== SERVICE || data.LoadState !== 'loaded' || data.Type !== 'exec' || data.User !== require('node:os').userInfo().username ||
        data.WorkingDirectory !== `${config.root}/current` || data.KillMode !== 'control-group' ||
        (data.ExecStart.match(/\{ path=/g) || []).length !== 1 ||
        !data.ExecStart.startsWith(`{ path=${config.nodePath} ; argv[]=${expected} ; ignore_errors=no ;`)) {
      fail('systemd is not using the reviewed versioned-release template; migration is required.', 'SYSTEMD_UNVERIFIED');
    }
    return data;
  }
  return {
    async validate() { return validate(await show()); },
    async restart() { await execute('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'restart', SERVICE], { timeout: 30000 }); },
    async health(commit, directory, { signal } = {}) {
      const token = privateFile(config.adminTokenFile).trim();
      return stableHealth({ directory, nodePath: config.nodePath, commit, port: 3000, socketPath: config.adminSocket, token, production: true }, async () => {
        const data = validate(await show());
        if (data.ActiveState !== 'active' || data.SubState !== 'running') fail('systemd is not running.', 'HEALTH_FAILED');
        return { pid: Number(data.MainPID), controlGroup: data.ControlGroup };
      }, { timeout: config.healthTimeoutMs, signal });
    },
    async rooms(commit) {
      try {
        const token = privateFile(config.adminTokenFile).trim();
        return validateSnapshot(await localJson({ socketPath: config.adminSocket, token, route: '/v1/status' }), commit, 3000);
      } catch { return { ...unknownRoomSummary(), draining: null, error: 'ROOMS_UNKNOWN' }; }
    },
    async drain(enabled, commit) {
      const token = privateFile(config.adminTokenFile).trim();
      const snapshot = validateSnapshot(await localJson({ socketPath: config.adminSocket, token, route: '/v1/drain', method: 'POST', body: { enabled } }), commit, 3000);
      if (snapshot.draining !== enabled) fail('Private runtime did not apply the requested admission state.', 'HEALTH_FAILED');
      return snapshot;
    },
    async runningDirectories() {
      const directories = new Set();
      for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
        try {
          if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
          const cwd = fs.realpathSync(`/proc/${pid}/cwd`);
          if (path.dirname(cwd) === path.join(config.root, 'releases')) directories.add(cwd);
        } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
      }
      return directories;
    },
  };
}

async function smoke(config, directory, commit, signal) {
  if (process.getuid() === 0) fail('Candidate code must never run as root.');
  if (!Number.isInteger(config.candidatePort) || config.candidatePort < 1024 || config.candidatePort > 65535 || config.candidatePort === 3000) {
    fail('Candidate port must be explicit and cannot be production port 3000.');
  }
  if (signal?.aborted) fail('Operation cancelled.', 'CANCELLED');
  await portAvailable(config.candidatePort);
  const socketPath = path.join(config.root, 'state', `candidate-${commit.slice(0, 12)}.sock`);
  noSymlinkPath(socketPath);
  if (fs.existsSync(socketPath)) fail('Candidate admin socket is already present; it was not removed.');
  const tokenFile = noSymlinkPath(path.join(config.root, 'state', `candidate-${commit.slice(0, 12)}.token`));
  const token = crypto.randomBytes(32).toString('hex');
  const log = path.join(config.root, 'state', 'logs', `${commit}.smoke.log`);
  let child, descriptor, exit = Promise.resolve(), closed = false, tokenCreated = false, logged = 0;
  const stop = (signalName = 'SIGTERM') => {
    if (!closed && child?.pid) {
      try { process.kill(-child.pid, signalName); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const cancel = () => stop();
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    fs.writeFileSync(tokenFile, token, { mode: 0o600, flag: 'wx' }); tokenCreated = true;
    descriptor = fs.openSync(noSymlinkPath(log), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    child = spawn(config.nodePath, [path.join(directory, 'server.js')], {
      cwd: directory, detached: true,
      env: cleanEnv({ NODE_ENV: 'production', PORT: String(config.candidatePort), HOST: '127.0.0.1', PUBLIC_BASE_URL: PUBLIC_URL,
        QINGSI_RELEASE_FILE: path.join(directory, 'release-info.json'), QINGSI_ADMIN_SOCKET: socketPath,
        QINGSI_ADMIN_TOKEN_FILE: tokenFile, QINGSI_GAMES_STARTUP_LOG: log, QINGSI_START_DRAINING: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = chunk => { if (logged < 1024 * 1024) { const limited = chunk.subarray(0, 1024 * 1024 - logged); fs.writeSync(descriptor, limited); logged += limited.length; } };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('error', () => {});
    exit = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
    await Promise.race([once(child, 'spawn'), exit.then(() => fail('Candidate failed to execute.', 'HEALTH_FAILED'))]);
    process.stderr.write(`${JSON.stringify({ action: 'candidate-start', commitSha: commit, pid: child.pid })}\n`);
    return await stableHealth({ directory, nodePath: config.nodePath, commit, port: config.candidatePort, socketPath, token }, async () => {
      if (closed) fail('Candidate exited before verification.', 'HEALTH_FAILED');
      return { pid: child.pid };
    }, { timeout: config.healthTimeoutMs, signal });
  } catch (error) {
    if (child?.pid) error.candidatePid = child.pid;
    throw error;
  } finally {
    signal?.removeEventListener('abort', cancel);
    // A fresh process group contains only this candidate and its descendants;
    // close waits for its pipes, including descendants holding them open.
    if (child?.pid) {
      stop(); await Promise.race([exit, sleep(2000)]);
      if (!closed) stop('SIGKILL');
      await Promise.race([exit, sleep(1000)]);
    }
    if (descriptor !== undefined) { fs.ftruncateSync(descriptor, Math.min(fs.fstatSync(descriptor).size, 1024 * 1024)); fs.closeSync(descriptor); }
    if (tokenCreated) fs.unlinkSync(noSymlinkPath(tokenFile));
    if (child?.pid && !closed) fail(`Candidate cleanup failed; recorded PID ${child.pid} requires attention.`, 'CLEANUP_FAILED');
  }
}

module.exports = { websocketCheck, validateSnapshot, validatePublicHealth, observe, stableHealth, createSystemd, smoke };
