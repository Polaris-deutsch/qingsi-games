'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { privateFile, noSymlinkPath, sha, fail } = require('./fs-safety');
const { summarizeRooms, unknownRoomSummary } = require('./room-status');

function createRuntime({ root, host, getPort, getRooms, isInitialized, env = process.env }) {
  const metadataPath = env.QINGSI_RELEASE_FILE;
  let releaseSha = null;
  if (metadataPath) {
    // current may be a symlink; the resolved metadata must be in this process's
    // actual source directory, rather than in shared or another release.
    const real = fs.realpathSync(metadataPath);
    if (real !== path.join(fs.realpathSync(root), 'release-info.json')) fail('Release metadata is outside the running release.');
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.mode & 0o222 || stat.size > 16384) fail('Release metadata must be a small read-only file.');
    const metadata = JSON.parse(fs.readFileSync(real, 'utf8'));
    if (metadata.schemaVersion !== 1) fail('Unsupported release metadata.');
    releaseSha = sha(metadata.commitSha);
  }
  let draining = env.QINGSI_START_DRAINING === '1';
  let admin;
  let ready = Promise.resolve();
  const snapshot = () => {
    let initialized = false, port = null, summary = unknownRoomSummary();
    try {
      initialized = isInitialized() === true;
      port = getPort();
      summary = summarizeRooms(getRooms(), initialized);
    } catch { /* A failed query is UNKNOWN, never an empty room map. */ }
    return { schemaVersion: 1, releaseSha, ready: initialized, host, port, draining, ...summary };
  };
  if (env.QINGSI_ADMIN_SOCKET) {
    if (!releaseSha || !env.QINGSI_ADMIN_TOKEN_FILE) fail('Private administration requires release metadata and a token file.');
    const socketPath = noSymlinkPath(env.QINGSI_ADMIN_SOCKET);
    if (Buffer.byteLength(socketPath) > 100) fail('Admin socket path is too long.');
    const parent = fs.statSync(path.dirname(socketPath));
    if (!parent.isDirectory() || parent.uid !== process.getuid() || parent.mode & 0o077) fail('Admin socket directory must be owned by the service user with mode 0700.');
    const token = privateFile(env.QINGSI_ADMIN_TOKEN_FILE).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) fail('Admin token must contain 32 random bytes encoded as hex.');
    const expected = Buffer.from(`Bearer ${token}`);
    admin = http.createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Cache-Control', 'no-store');
      const supplied = Buffer.from(request.headers.authorization || '');
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
        response.writeHead(403); response.end('{"error":"forbidden"}'); request.resume(); return;
      }
      if (request.method === 'GET' && request.url === '/v1/status') {
        response.end(JSON.stringify(snapshot())); return;
      }
      if (request.method === 'POST' && request.url === '/v1/drain') {
        let body = '';
        request.on('data', chunk => { body += chunk; if (body.length > 1024) request.destroy(); });
        request.on('end', () => {
          try {
            const value = JSON.parse(body);
            if (typeof value.enabled !== 'boolean' || Object.keys(value).length !== 1) throw new Error();
            draining = value.enabled;
            response.end(JSON.stringify(snapshot()));
          } catch { response.writeHead(400); response.end('{"error":"invalid request"}'); }
        });
        return;
      }
      response.writeHead(404); response.end('{"error":"not found"}'); request.resume();
    });
    admin.requestTimeout = 2000;
    admin.headersTimeout = 2000;
    admin.keepAliveTimeout = 100;
    ready = new Promise((resolve, reject) => {
      admin.once('error', reject);
      // Never unlink an existing socket: it may belong to another process.
      admin.listen(socketPath, () => {
        try { fs.chmodSync(socketPath, 0o600); resolve(); } catch (error) { reject(error); }
      });
    });
  }
  return { releaseSha, ready, isDraining: () => draining, snapshot,
    close() { if (admin?.listening) { admin.close(); admin.closeAllConnections?.(); } } };
}

module.exports = { createRuntime };
