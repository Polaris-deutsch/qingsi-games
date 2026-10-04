'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');

const project = path.resolve(__dirname, '..');
const script = path.join(project, 'scripts/qingsi-games-service.sh');
const serverEntry = path.join(project, 'server.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function birth(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    return fields[0] === 'Z' ? null : fields[19];
  } catch { return null; }
}

function readHealth() {
  return new Promise((resolve, reject) => {
    const request = http.get('http://127.0.0.1:3000/api/health', (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error('health timeout')), 3000);
    request.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { if ((await readHealth()).service === 'qingsi-games') return; } catch { /* booting */ }
    await sleep(100);
  }
  throw new Error('test server did not become healthy');
}

test('service lifecycle manages only verified PIDs and releases port 3000', async () => {
  // Never exercise start/stop against a service that was already using this port.
  const listener = net.createServer();
  listener.listen({ host: '0.0.0.0', port: 3000, exclusive: true });
  await once(listener, 'listening');
  await new Promise((resolve) => listener.close(resolve));

  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'qingsi-service-test-'));
  console.log(`Test runtime directory: ${state}`);
  const env = { ...process.env, QINGSI_GAMES_STATE_DIR: state };
  delete env.PUBLIC_BASE_URL;
  delete env.ANDROID_SKIP_REGISTRY_LOAD;
  const pidFile = path.join(state, 'qingsi-games.pid');
  const logFile = path.join(state, 'qingsi-games.log');
  const owned = [];
  const fixtures = [];
  let ws;
  const run = (command, expected = 0, overrides = {}) => {
    const result = spawnSync(script, [command], {
      cwd: project, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 25000,
    });
    assert.equal(result.error, undefined, `${command} command timed out or failed to execute`);
    assert.equal(result.status, expected, `${command}: ${result.stdout}\n${result.stderr}`);
    return result.stdout + result.stderr;
  };
  const record = () => {
    const value = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    owned.push(value);
    console.log(`Recorded test server PID: ${value.pid}`);
    return value;
  };
  const fixture = async (args, overrides = {}) => {
    const child = spawn(process.execPath, args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...overrides } });
    await once(child, 'spawn');
    const identity = { child, startTicks: birth(child.pid) };
    fixtures.push(identity);
    console.log(`Recorded unrelated fixture PID: ${child.pid}`);
    return child;
  };

  try {
    const unrelated = await fixture(['-e', 'setInterval(() => {}, 1000)']);
    assert.match(run('status'), /Process: STOPPED\nHealth: OFFLINE/);
    assert.match(run('status', 0, { PATH: '/usr/bin:/bin' }), /Process: STOPPED\nHealth: OFFLINE/);
    console.log('PASS: stopped status');

    assert.match(run('start'), /ONLINE/);
    const first = record();
    assert.equal((await readHealth()).ok, true);
    assert.equal((await readHealth()).service, 'qingsi-games');
    assert.match(run('status'), /Process: RUNNING\nHealth: ONLINE/);
    console.log('PASS: start, health and running status');

    assert.match(run('start'), /already running/);
    assert.equal(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, first.pid);
    console.log('PASS: second start keeps the same PID');

    ws = new WebSocket('ws://127.0.0.1:3000', { origin: 'http://127.0.0.1:3000', handshakeTimeout: 2000 });
    await once(ws, 'open');
    assert.doesNotMatch(run('stop'), /timed out/);
    assert.equal(birth(first.pid), null);
    assert.ok(birth(unrelated.pid));
    assert.match(run('status'), /Process: STOPPED\nHealth: OFFLINE/);
    console.log('PASS: SIGTERM closes an active WebSocket without stopping unrelated Node');

    fs.writeFileSync(pidFile, JSON.stringify({
      pid: unrelated.pid, startTicks: birth(unrelated.pid),
      bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    }));
    run('stop');
    assert.ok(birth(unrelated.pid));
    assert.equal(fs.existsSync(pidFile), false);
    console.log('PASS: a PID record for another Node process never grants stop authority');

    fs.writeFileSync(pidFile, JSON.stringify({ pid: 2147483647, startTicks: '0', bootId: 'stale' }));
    fs.writeFileSync(logFile, 'old-log\n' + 'x'.repeat(5 * 1024 * 1024));
    run('start');
    const staleRecovery = record();
    assert.ok(fs.existsSync(`${logFile}.1`));
    assert.match(run('logs'), /GameNest|Public:/);
    console.log('PASS: stale PID recovery, bounded logs and 5 MiB log rotation');

    assert.match(run('restart'), /ONLINE/);
    const restarted = record();
    assert.notEqual(restarted.pid, staleRecovery.pid);
    assert.equal(birth(staleRecovery.pid), null);
    console.log('PASS: restart replaces the confirmed instance');

    fs.writeFileSync(pidFile, JSON.stringify({ ...restarted, startTicks: 'invalid-birth-time' }));
    run('stop');
    assert.ok(birth(restarted.pid));
    assert.equal(fs.existsSync(pidFile), false);
    run('start');
    assert.equal(record().pid, restarted.pid);
    console.log('PASS: PID reuse protection and safe adoption of the matching port owner');

    process.kill(restarted.pid, 'SIGINT');
    const exitDeadline = Date.now() + 2000;
    while (birth(restarted.pid) && Date.now() < exitDeadline) await sleep(50);
    assert.equal(birth(restarted.pid), null);
    assert.match(run('status'), /Process: STOPPED\nHealth: OFFLINE/);
    console.log('PASS: SIGINT graceful shutdown');

    const manual = await fixture(['server.js'], {
      PORT: '3000', PUBLIC_BASE_URL: 'https://games.qingsiphotograph.com', QINGSI_GAMES_STARTUP_LOG: logFile,
    });
    await waitForHealth();
    assert.match(run('start'), /already running/);
    assert.equal(record().pid, manual.pid);
    run('stop');
    assert.equal(birth(manual.pid), null);
    console.log('PASS: a manually started node server.js instance is recognized without duplication');

    const occupied = await fixture(['-e',
      "require('http').createServer((req, res) => res.end(JSON.stringify({ok:true,service:'another-service'}))).listen(3000, '0.0.0.0', () => console.log('READY'))",
    ]);
    await once(occupied.stdout, 'data');
    assert.match(run('start', 1), /Port 3000 is already in use/);
    assert.match(run('status'), /Health: OFFLINE/);
    assert.ok(birth(occupied.pid));
    occupied.kill('SIGTERM');
    await once(occupied, 'exit');
    console.log('PASS: port conflict leaves its owner alive; a different health service is not ONLINE');

    assert.match(run('start', 1, { PUBLIC_BASE_URL: 'invalid-public-url' }), /Failed to start QingSi Games/);
    assert.equal(fs.existsSync(pidFile), false);
    assert.match(run('status'), /Process: STOPPED\nHealth: OFFLINE/);
    console.log('PASS: immediate startup failure is reported without restart loops');
  } finally {
    ws?.terminate();
    // The test journal is independent of stale-PID cases above. Cleanup only
    // recorded test children whose birth token and exact entrypoint still match.
    for (const value of owned) {
      if (birth(value.pid) !== value.startTicks) continue;
      try {
        const args = fs.readFileSync(`/proc/${value.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
        const cwd = fs.realpathSync(`/proc/${value.pid}/cwd`);
        if (args.length !== 2 || cwd !== project || path.resolve(cwd, args[1]) !== serverEntry) continue;
        fs.writeFileSync(pidFile, JSON.stringify(value));
        run('stop');
      } catch { /* exited during cleanup */ }
    }
    for (const { child, startTicks } of fixtures) {
      if (startTicks && birth(child.pid) === startTicks) child.kill('SIGTERM');
    }
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('Windows wrappers and shortcut installer preserve quoted paths and default distro', () => {
  const windows = path.join(project, 'scripts/windows');
  for (const action of ['Start', 'Stop', 'Status', 'Restart']) {
    const wrapper = fs.readFileSync(path.join(windows, `${action}-QingSi-Games.cmd`), 'utf8');
    assert.ok(wrapper.includes(`call "%~dp0QingSi-Games-Control.cmd" ${action.toLowerCase()}`));
  }
  const control = fs.readFileSync(path.join(windows, 'QingSi-Games-Control.cmd'), 'utf8');
  assert.match(control, /wsl\.exe --exec %\*/);
  assert.match(control, /--distribution "%QINGSI_WSL_DISTRO%"/);
  assert.match(control, /WSL is unavailable/);
  assert.doesNotMatch(control, /Ubuntu|taskkill|pkill|killall/i);
  const labels = new Set([...control.matchAll(/^:([\w_]+)/gm)].map((match) => match[1]));
  for (const match of control.matchAll(/(?:goto|call :)\s*([\w_]+)/g)) assert.ok(labels.has(match[1]), match[1]);
  const installerBytes = fs.readFileSync(path.join(windows, 'Install-QingSi-Games-Shortcuts.ps1'));
  assert.equal(installerBytes.subarray(0, 3).toString('hex'), 'efbbbf');
  const installer = installerBytes.toString('utf8');
  assert.match(installer, /GetFolderPath\('Desktop'\)/);
  assert.match(installer, /param\(\[switch\]\$Uninstall\)/);
  assert.match(installer, /Description -ne \$marker/);
  assert.ok(installer.includes("'/d /c \"\"{0}\"\"' -f $wrapperPath"));
  assert.doesNotMatch(installer, /C:\\Users\\|Set-ItemProperty|New-ItemProperty/i);
});
