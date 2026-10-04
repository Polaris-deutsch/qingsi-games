#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');

const PROJECT_DIR = fs.realpathSync(path.join(__dirname, '..'));
const ENTRYPOINT = path.join(PROJECT_DIR, 'server.js');
const PORT = 3000;
const LOCAL_URL = `http://localhost:${PORT}`;
const PUBLIC_URL = process.env.PUBLIC_BASE_URL || 'https://games.qingsiphotograph.com';
const STATE_DIR = path.resolve(process.argv[3]);
const PID_FILE = path.join(STATE_DIR, 'qingsi-games.pid');
const LOG_FILE = path.join(STATE_DIR, 'qingsi-games.log');
const BOOT_ID = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  try {
    const proc = `/proc/${pid}`;
    if (fs.statSync(proc).uid !== process.getuid()) return null;
    const args = fs.readFileSync(`${proc}/cmdline`, 'utf8').split('\0').filter(Boolean);
    if (args.length !== 2) return null;
    const cwd = fs.realpathSync(`${proc}/cwd`);
    if (cwd !== PROJECT_DIR) return null;
    if (fs.realpathSync(path.resolve(cwd, args[1])) !== ENTRYPOINT) return null;
    if (path.basename(fs.realpathSync(`${proc}/exe`)) !== 'node') return null;
    const stat = fs.readFileSync(`${proc}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    return { pid, startTicks: fields[19], bootId: BOOT_ID };
  } catch {
    return null;
  }
}

function matches(record) {
  if (!record || record.bootId !== BOOT_ID || typeof record.startTicks !== 'string') return false;
  const actual = processIdentity(record.pid);
  return actual !== null && actual.startTicks === record.startTicks;
}

function readRecord() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return null; }
}

function removeRecord() {
  try { fs.unlinkSync(PID_FILE); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function managedRecord() {
  const record = readRecord();
  if (matches(record)) return record;
  // An invalid record grants no authority to signal its PID.
  removeRecord();
  return null;
}

function saveRecord(record) {
  const temporary = `${PID_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, PID_FILE);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never created */ }
  }
}

function probeHealth(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let finished = false;
    let request;
    const finish = (online) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(online);
    };
    const timer = setTimeout(() => { finish(false); request?.destroy(); }, timeoutMs);
    request = http.get({
      hostname: '127.0.0.1', port: PORT, path: '/api/health',
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    }, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        finish(false); response.destroy(); return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) { finish(false); response.destroy(); }
      });
      response.on('error', () => finish(false));
      response.on('end', () => {
        try {
          const value = JSON.parse(body);
          finish(value?.ok === true && value?.service === 'qingsi-games');
        } catch { finish(false); }
      });
    });
    request.on('error', () => finish(false));
  });
}

function portAvailable() {
  return new Promise((resolve) => {
    const listener = net.createServer();
    const timer = setTimeout(() => { listener.close(); resolve(false); }, 1000);
    listener.once('error', () => { clearTimeout(timer); resolve(false); });
    listener.listen({ host: '0.0.0.0', port: PORT, exclusive: true }, () => {
      listener.close(() => { clearTimeout(timer); resolve(true); });
    });
  });
}

function existingPortOwner() {
  return new Promise((resolve) => {
    execFile('ss', ['-H', '-ltnp', `( sport = :${PORT} )`], { timeout: 1000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      for (const match of stdout.matchAll(/pid=(\d+)/g)) {
        const identity = processIdentity(Number(match[1]));
        if (identity) { resolve(identity); return; }
      }
      resolve(null);
    });
  });
}

function rotateLog() {
  try {
    if (fs.statSync(LOG_FILE).size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function terminate(record) {
  // Revalidate immediately before every signal, including escalation.
  if (!matches(record)) return true;
  try { process.kill(record.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  const deadline = Date.now() + 5000;
  while (matches(record) && Date.now() < deadline) await sleep(100);
  if (!matches(record)) return true;
  console.log('Graceful shutdown timed out; terminating the verified QingSi Games PID.');
  if (matches(record)) {
    try { process.kill(record.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const forceDeadline = Date.now() + 1000;
  while (matches(record) && Date.now() < forceDeadline) await sleep(100);
  return !matches(record);
}

async function start() {
  if (managedRecord()) {
    console.log('QingSi Games is already running.');
    return true;
  }
  if (!await portAvailable()) {
    const existing = await existingPortOwner();
    if (existing && matches(existing)) {
      saveRecord(existing);
      console.log('QingSi Games is already running.');
      return true;
    }
    console.error('Port 3000 is already in use. No process was stopped.');
    return false;
  }

  rotateLog();
  console.log('QingSi Games\nStarting...');
  const descriptor = fs.openSync(LOG_FILE, 'a', 0o600);
  let child;
  let record;
  try {
    child = spawn(process.execPath, [ENTRYPOINT], {
      cwd: PROJECT_DIR, detached: true,
      env: { ...process.env, PORT: String(PORT), PUBLIC_BASE_URL: PUBLIC_URL, QINGSI_GAMES_STARTUP_LOG: LOG_FILE },
      stdio: ['ignore', descriptor, descriptor],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    record = processIdentity(child.pid);
    if (!record) throw new Error('server exited');
    saveRecord(record);
  } catch {
    if (record && matches(record)) await terminate(record);
    removeRecord();
    console.error('Failed to start QingSi Games. Run qingsi-games-service.sh logs.');
    return false;
  } finally { fs.closeSync(descriptor); }

  const deadline = Date.now() + 8000;
  while (matches(record) && Date.now() < deadline) {
    const online = await probeHealth(Math.min(1000, Math.max(1, deadline - Date.now())));
    if (online && matches(record)) {
      console.log(`ONLINE\n${PUBLIC_URL}`);
      return true;
    }
    await sleep(200);
  }
  if (matches(record) && !await terminate(record)) {
    console.error('Failed to start QingSi Games; the verified PID remains recorded. Run qingsi-games-service.sh status.');
    return false;
  }
  removeRecord();
  console.error('Failed to start QingSi Games. Run qingsi-games-service.sh logs.');
  return false;
}

async function stop() {
  const record = managedRecord();
  if (!record) { console.log('QingSi Games is stopped.'); return true; }
  if (!await terminate(record)) {
    console.error('Unable to stop the verified QingSi Games PID. Run qingsi-games-service.sh status.');
    return false;
  }
  removeRecord();
  console.log('QingSi Games stopped.');
  return true;
}

async function status() {
  const record = managedRecord() || await existingPortOwner();
  const online = await probeHealth();
  console.log('QingSi Games');
  console.log(`Process: ${record && matches(record) ? 'RUNNING' : 'STOPPED'}`);
  console.log(`Health: ${online ? 'ONLINE' : 'OFFLINE'}`);
  if (record && matches(record)) console.log(`PID: ${record.pid}`);
  console.log(`Local: ${LOCAL_URL}\nPublic: ${PUBLIC_URL}`);
}

function logs() {
  try {
    const descriptor = fs.openSync(LOG_FILE, 'r');
    try {
      const size = fs.fstatSync(descriptor).size;
      const length = Math.min(size, 128 * 1024);
      const buffer = Buffer.alloc(length);
      fs.readSync(descriptor, buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').trimEnd().split('\n');
      console.log(lines.slice(-80).join('\n'));
    } finally { fs.closeSync(descriptor); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log('No QingSi Games log yet.');
  }
}

async function main() {
  switch (process.argv[2]) {
    case 'start': return await start();
    case 'stop': return await stop();
    case 'status': await status(); return true;
    case 'restart': if (!await stop()) return false; await sleep(200); return await start();
    case 'logs': logs(); return true;
    default: return false;
  }
}

main().then((success) => { process.exitCode = success ? 0 : 1; }).catch(() => {
  console.error('QingSi Games control failed. Check the runtime directory permissions and run qingsi-games-service.sh logs.');
  process.exitCode = 1;
});
