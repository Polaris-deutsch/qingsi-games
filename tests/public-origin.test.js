const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { getPublicBaseUrl, buildRoomShareUrl } = require('../public-origin');
const { version } = require('../package.json');

const root = path.join(__dirname, '..');

test('PUBLIC_BASE_URL is optional and normalizes HTTP(S) origins', () => {
  assert.equal(getPublicBaseUrl(undefined), null);
  assert.equal(getPublicBaseUrl(''), null);
  assert.equal(getPublicBaseUrl('  '), null);
  assert.equal(getPublicBaseUrl('https://games.qingsiphotograph.com'), 'https://games.qingsiphotograph.com');
  assert.equal(getPublicBaseUrl('https://games.qingsiphotograph.com/'), 'https://games.qingsiphotograph.com');
  assert.equal(getPublicBaseUrl('http://example.test:3000'), 'http://example.test:3000');
  assert.throws(() => getPublicBaseUrl('not a URL'), /Invalid PUBLIC_BASE_URL/);
  assert.throws(() => getPublicBaseUrl('ftp://example.test'), /Invalid PUBLIC_BASE_URL/);
  assert.throws(() => getPublicBaseUrl('https://example.test/path'), /Invalid PUBLIC_BASE_URL/);
  assert.throws(() => getPublicBaseUrl('https://example.test/?'), /Invalid PUBLIC_BASE_URL/);
  assert.throws(() => getPublicBaseUrl('https://example.test/#'), /Invalid PUBLIC_BASE_URL/);
});

test('room invite uses the existing /?room= join contract in public and LAN modes', () => {
  const publicBaseUrl = getPublicBaseUrl('https://games.qingsiphotograph.com/');
  const invite = buildRoomShareUrl('AB3', {
    publicBaseUrl,
    requestHost: '192.168.1.106:3000',
    forwardedProto: 'http',
    getShareableLanIP: () => { throw new Error('public mode must not inspect LAN IPs'); },
    port: 3000,
  });
  assert.equal(invite, 'https://games.qingsiphotograph.com/?room=AB3');
  assert.doesNotMatch(invite, /localhost|192\.168\.|172\.|10\./);

  const local = { requestHost: 'localhost:3000', getShareableLanIP: () => '192.168.1.106', port: 3000 };
  assert.equal(buildRoomShareUrl('AB3', local), 'http://192.168.1.106:3000/?room=AB3');
  assert.equal(buildRoomShareUrl('AB3', { ...local, publicBaseUrl: '' }), 'http://192.168.1.106:3000/?room=AB3');
  assert.equal(buildRoomShareUrl('AB3', { requestHost: '127.0.0.1:3000', port: 3000 }), 'http://127.0.0.1:3000/?room=AB3');
  assert.equal(buildRoomShareUrl('AB3', { requestHost: '192.168.1.106:3000', port: 3000 }), 'http://192.168.1.106:3000/?room=AB3');
  assert.equal(buildRoomShareUrl('AB3', { requestHost: 'example.test', forwardedProto: 'https' }), 'https://example.test/?room=AB3');
});

test('both browser clients connect to the current page origin', () => {
  for (const file of ['public/index.html', 'public/js/room-client.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const match = source.match(/function getSocketURL\(\) \{[\s\S]*?\n\s*\}/);
    assert.ok(match, `getSocketURL exists in ${file}`);
    const socketURL = (protocol, host) => vm.runInNewContext(`${match[0]}\ngetSocketURL()`, {
      location: { protocol, host },
    });
    assert.equal(socketURL('http:', '192.168.1.106:3000'), 'ws://192.168.1.106:3000');
    assert.equal(socketURL('http:', 'localhost:3000'), 'ws://localhost:3000');
    assert.equal(socketURL('https:', 'games.qingsiphotograph.com'), 'wss://games.qingsiphotograph.com');
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function withServer(publicBaseUrl, run) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  if (publicBaseUrl == null) delete env.PUBLIC_BASE_URL;
  else env.PUBLIC_BASE_URL = publicBaseUrl;
  // Capture the string passed to the real /qr route without adding a PNG
  // decoder dependency. The route still exercises its normal URL selection.
  const server = spawn(process.execPath, ['-e', "require('qrcode').toBuffer = async url => Buffer.from(url); require('./server.js')"], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 8000;
    while (true) {
      if (server.exitCode !== null) throw new Error(`server exited: ${output}`);
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) break;
      } catch (err) {
        if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`);
      }
      await new Promise(resolve => setTimeout(resolve, 75));
    }
    await run(base, output);
  } finally {
    server.kill();
  }
}

function getQr(base, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${base}/qr?room=AB3`, { headers, timeout: 3000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        contentType: response.headers['content-type'],
        body: Buffer.concat(chunks).toString(),
      }));
    });
    request.on('timeout', () => request.destroy(new Error('QR request timed out')));
    request.on('error', reject);
  });
}

test('health endpoint is minimal, JSON, and never cached', async () => {
  await withServer(undefined, async base => {
    const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { ok: true, service: 'qingsi-games', version });
  });
});

test('QR encodes the canonical public invite despite a LAN Host header', async () => {
  await withServer('https://games.qingsiphotograph.com/', async base => {
    const response = await getQr(base, { Host: '192.168.1.106:3000', 'X-Forwarded-Proto': 'http' });
    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'image/png');
    assert.equal(response.body, 'https://games.qingsiphotograph.com/?room=AB3');
  });
});

test('QR keeps the original LAN invite when PUBLIC_BASE_URL is unset', async () => {
  await withServer(undefined, async base => {
    const response = await getQr(base, { Host: '192.168.1.106:3000' });
    assert.equal(response.status, 200);
    assert.equal(response.body, 'http://192.168.1.106:3000/?room=AB3');
  });
});

test('invalid PUBLIC_BASE_URL fails startup with a clear error', () => {
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0', PUBLIC_BASE_URL: 'invalid-url' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Invalid PUBLIC_BASE_URL/);
});
