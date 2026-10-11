'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { fail, noSymlinkPath } = require('./fs-safety');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cleanEnv(extra = {}) {
  return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false',
    ...extra };
}

function run(command, args, { cwd, env = cleanEnv(), timeout = 30000, signal, allowFailure = false, logFile } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) fail('Operation cancelled.', 'CANCELLED');
    let output = '', bytes = 0, timedOut = false, aborted = false, finished = false, force;
    let descriptor, loggedBytes = 0;
    if (logFile) {
      descriptor = fs.openSync(noSymlinkPath(logFile), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
      loggedBytes = fs.fstatSync(descriptor).size;
    }
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // A fresh process group contains only descendants of this invocation.
    const terminate = () => {
      if (!finished && child.pid) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        if (!force) force = setTimeout(() => {
          if (!finished) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
        }, 2000);
      }
    };
    const abort = () => { aborted = true; terminate(); };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeout);
    const receive = chunk => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { timedOut = true; terminate(); return; }
      output += chunk.toString('utf8');
      if (descriptor !== undefined && loggedBytes < 1024 * 1024) {
        const limited = chunk.subarray(0, 1024 * 1024 - loggedBytes);
        fs.writeSync(descriptor, limited); loggedBytes += limited.length;
      }
    };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    child.once('error', error => { cleanup(); reject(new Error(`Unable to execute ${path.basename(command)}: ${error.code || 'error'}.`)); });
    child.once('close', (code, killedBy) => {
      cleanup();
      if (timedOut || aborted || killedBy || (!allowFailure && code !== 0)) {
        const error = new Error(`${path.basename(command)} failed (${aborted ? 'cancelled' : timedOut ? 'timeout/output limit' : killedBy || `exit ${code}`}).`);
        error.code = aborted ? 'CANCELLED' : 'COMMAND_FAILED';
        reject(error);
      } else resolve({ code, output });
    });
    function cleanup() {
      finished = true;
      clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', abort);
      if (descriptor !== undefined) { fs.closeSync(descriptor); descriptor = undefined; }
    }
    if (signal?.aborted) abort();
  });
}

async function acquireLock(state) {
  const lockPath = noSymlinkPath(path.join(state, 'deploy.lock'));
  const fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  fs.closeSync(fd);
  const child = spawn('/usr/bin/flock', ['-n', '-E', '75', lockPath, process.execPath, path.join(__dirname, 'lock-holder.js')],
    { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  let ended = false;
  const exited = new Promise(resolve => { child.once('error', () => { ended = true; resolve(1); }); child.once('exit', code => { ended = true; resolve(code); }); });
  let timer;
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', data => data.toString() === 'LOCKED\n' ? resolve(true) : reject(new Error('Invalid lock holder response.')));
    timer = setTimeout(() => reject(new Error('Deployment lock timed out.')), 2000);
  });
  try {
    const value = await Promise.race([ready, exited.then(code => { fail(code === 75 ? 'Another deployment operation is running.' : 'Unable to acquire deployment lock.', 'LOCKED'); })]);
    if (!value) fail('Deployment lock was not acquired.', 'LOCKED');
  } catch (error) { child.stdin.destroy(); if (!ended) child.kill('SIGTERM'); throw error; }
  finally { clearTimeout(timer); }
  return async () => {
    child.stdin.end();
    await Promise.race([exited, sleep(1000)]);
    if (!ended) { child.kill('SIGTERM'); fail('Deployment lock holder did not exit.', 'LOCKED'); }
  };
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) fail('Invalid service MainPID.', 'IDENTITY_FAILED');
  const proc = `/proc/${pid}`;
  const stat = fs.readFileSync(`${proc}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
  if (['Z', 'X'].includes(fields[0])) fail('Service process has exited.', 'IDENTITY_FAILED');
  return { pid, startTicks: fields[19], cwd: fs.realpathSync(`${proc}/cwd`),
    executable: fs.realpathSync(`${proc}/exe`),
    args: fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0').filter(Boolean),
    uid: fs.statSync(proc).uid,
    env: Object.fromEntries(fs.readFileSync(`${proc}/environ`, 'utf8').split('\0').filter(Boolean).map(value => {
      const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)];
    })),
    cgroup: fs.readFileSync(`${proc}/cgroup`, 'utf8'),
  };
}

function verifyListener(pid, port) {
  const inodes = new Set();
  for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
    try {
      const match = fs.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
      if (match) inodes.add(match[1]);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const listeners = [];
  for (const table of ['tcp', 'tcp6']) {
    const lines = fs.readFileSync(`/proc/${pid}/net/${table}`, 'utf8').trim().split('\n').slice(1);
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && inodes.has(fields[9])) listeners.push({ address: fields[1], table });
    }
  }
  const expected = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  if (listeners.length !== 1 || listeners[0].table !== 'tcp' || listeners[0].address !== expected) {
    fail('MainPID does not exclusively listen on the approved IPv4 loopback port.', 'IDENTITY_FAILED');
  }
}

function localJson({ port, socketPath, route = '/api/health', method = 'GET', token, body, timeout = 1000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ ...(socketPath ? { socketPath } : { host: '127.0.0.1', port }),
      path: route, method, agent: false,
      headers: { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; if (text.length > 65536) request.destroy(new Error('Response too large.')); });
      response.once('error', reject);
      response.on('end', () => {
        clearTimeout(timer);
        try {
          if (response.statusCode !== 200 || !/^application\/json\b/.test(response.headers['content-type'] || '')) fail('Unexpected health/admin HTTP response.', 'HEALTH_FAILED');
          resolve(JSON.parse(text));
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('Local HTTP request timed out.')), timeout);
    request.once('error', error => { clearTimeout(timer); reject(error); });
    request.end(payload);
  });
}

async function portAvailable(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => probe.once('error', () => reject(new Error('Candidate port is occupied; no process was stopped.'))).listen(port, '127.0.0.1', resolve));
  await new Promise(resolve => probe.close(resolve));
}

module.exports = { sleep, cleanEnv, run, acquireLock, processIdentity, verifyListener, localJson, portAvailable, once };
