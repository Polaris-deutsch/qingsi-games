'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { fail, noSymlinkPath, secureDir, inside } = require('./fs-safety');
const { cleanEnv, sleep } = require('./process');

const SOURCE_LIMITS = Object.freeze({ fileBytes: 128 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, entries: 100000 });
const GIT_OPTIONS = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never'];

function validateSourceFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > SOURCE_LIMITS.entries) fail('Missing or oversized trusted Git tree listing.');
  const names = new Set(), directories = new Set(['']);
  for (const file of files) {
    const relative = file?.path;
    if (!['100644', '100755'].includes(file?.mode) || !/^[a-f0-9]{40}$/.test(file?.blob || '') ||
        typeof relative !== 'string' || relative.startsWith('/') || /[\s\x00-\x1f\\\ufffd]/.test(relative) ||
        relative.split('/').some(part => !part || part === '.' || part === '..') ||
        ['.git', 'node_modules', 'release-info.json', '.qingsi-release.json'].includes(relative.split('/')[0]) || names.has(relative)) {
      fail('Git tree contains an unsafe, duplicate or unsupported entry.');
    }
    names.add(relative);
    let parent = path.posix.dirname(relative);
    while (parent !== '.') { directories.add(parent); parent = path.posix.dirname(parent); }
    if (names.size + directories.size > SOURCE_LIMITS.entries) fail('Git tree exceeds its entry limit.');
  }
  if ([...names].some(name => directories.has(name))) fail('Git tree contains conflicting file and directory paths.');
  return files;
}

// Plain cat-file --batch returns raw bytes, without attributes, filters or textconv.
// Parse lengths as bytes: binary data and CRLF are never decoded or normalized.
async function writeBlobStream(directory, files, stream, limits = SOURCE_LIMITS) {
  validateSourceFiles(files);
  for (const key of ['fileBytes', 'totalBytes']) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0 || limits[key] > SOURCE_LIMITS[key]) fail('Source size limits cannot be widened.');
  }
  secureDir(directory);
  if (fs.readdirSync(directory).length) fail('Candidate source destination must be empty.');
  let index = 0, header = '', phase = 'header', remaining = 0, total = 0, fd, hash;
  const reject = message => fail(message, 'SOURCE_CHANGED');
  function finishBlob() {
    if (hash.digest('hex') !== files[index].blob) reject('Git blob content differs from the approved tree.');
    fs.fchmodSync(fd, files[index].mode === '100755' ? 0o755 : 0o644);
    fs.closeSync(fd); fd = undefined; phase = 'separator';
  }
  try {
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) reject('Git blob stream must contain binary buffers.');
      let offset = 0;
      while (offset < chunk.length) {
        if (phase === 'header') {
          if (index >= files.length) reject('Git returned extra blob data.');
          const newline = chunk.indexOf(10, offset), end = newline < 0 ? chunk.length : newline;
          if (header.length + end - offset > 100) reject('Invalid Git blob response header.');
          header += chunk.subarray(offset, end).toString('latin1'); offset = end;
          if (newline < 0) continue;
          offset++;
          const match = header.match(/^([a-f0-9]{40}) blob (0|[1-9][0-9]*)$/);
          if (!match || match[1] !== files[index].blob) reject('Git returned the wrong blob identity or type.');
          const size = Number(match[2]);
          if (!Number.isSafeInteger(size) || size > limits.fileBytes || total + size > limits.totalBytes) reject('Git source exceeds its size limits.');
          total += size;
          const target = noSymlinkPath(path.join(directory, files[index].path));
          if (!inside(directory, target)) reject('Git source path escapes its destination.');
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          noSymlinkPath(path.dirname(target));
          fd = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
          hash = crypto.createHash('sha1').update(`blob ${size}\0`);
          remaining = size; header = ''; phase = 'body';
          if (!remaining) finishBlob();
        } else if (phase === 'body') {
          const end = offset + Math.min(remaining, chunk.length - offset);
          const bytes = chunk.subarray(offset, end);
          fs.writeFileSync(fd, bytes); hash.update(bytes);
          remaining -= bytes.length; offset = end;
          if (!remaining) finishBlob();
        } else {
          if (chunk[offset++] !== 10) reject('Git blob response has an invalid separator.');
          index++; phase = 'header';
        }
      }
    }
    if (index !== files.length || phase !== 'header' || header) reject('Git blob export is incomplete.');
    return { files: index, bytes: total };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

async function exportGitBlobs(cache, directory, files, signal) {
  validateSourceFiles(files);
  if (signal?.aborted) fail('Operation cancelled.', 'CANCELLED');
  const child = spawn('/usr/bin/git', [...GIT_OPTIONS, '-C', cache, 'cat-file', '--batch'],
    { env: cleanEnv(), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false, timedOut = false, streamError = false, stderrBytes = 0, force;
  const exited = new Promise(resolve => {
    child.once('error', () => { streamError = true; });
    child.once('close', (code, killedBy) => { closed = true; resolve({ code, killedBy }); });
  });
  const stop = (name = 'SIGTERM') => {
    if (!closed && child.pid) {
      try { process.kill(-child.pid, name); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (!force && name === 'SIGTERM') force = setTimeout(() => stop('SIGKILL'), 2000);
    }
  };
  const cancel = () => { stop(); child.stdout.destroy(); };
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; cancel(); }, 60000);
  child.stdin.on('error', () => { streamError = true; cancel(); });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) { streamError = true; cancel(); } });
  try {
    child.stdin.end(files.map(file => `${file.blob}\n`).join(''));
    if (signal?.aborted) cancel();
    const result = await writeBlobStream(directory, files, child.stdout);
    const exit = await Promise.race([exited, sleep(3000).then(() => null)]);
    if (signal?.aborted) fail('Operation cancelled.', 'CANCELLED');
    if (!exit || timedOut || streamError || exit.code !== 0 || exit.killedBy) fail('Git blob export did not exit successfully.', 'COMMAND_FAILED');
    return result;
  } catch (error) {
    if (signal?.aborted) fail('Operation cancelled.', 'CANCELLED');
    if (timedOut) fail('Git blob export timed out.', 'COMMAND_FAILED');
    throw error;
  } finally {
    stop(); child.stdin.destroy();
    await Promise.race([exited, sleep(2000)]);
    if (!closed) stop('SIGKILL');
    await Promise.race([exited, sleep(1000)]);
    clearTimeout(timer); clearTimeout(force); signal?.removeEventListener('abort', cancel);
    if (!closed) fail(`Git blob export cleanup failed; recorded PID ${child.pid} requires attention.`, 'CLEANUP_FAILED');
  }
}

module.exports = { SOURCE_LIMITS, GIT_OPTIONS, validateSourceFiles, writeBlobStream, exportGitBlobs };
