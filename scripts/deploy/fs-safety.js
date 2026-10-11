'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function fail(message, code = 'UNSAFE_INPUT') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sha(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) fail('A full lowercase 40-character commit SHA is required.');
  return value;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function noSymlinkPath(target) {
  if (!path.isAbsolute(target) || path.resolve(target) !== target || /[\s\x00-\x1f]/.test(target)) fail('Expected a canonical absolute path without whitespace.');
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) fail('Symlink in a protected path.');
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

function privateFile(target) {
  noSymlinkPath(target);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o027 || ![0, process.getuid()].includes(stat.uid)) {
      fail('Private file must be owned by root or the current user, with no group write or other access.');
    }
    if (stat.size > 64 * 1024) fail('Private configuration is too large.');
    return fs.readFileSync(fd, 'utf8');
  } finally { fs.closeSync(fd); }
}

function secureDir(target, { create = false } = {}) {
  noSymlinkPath(target);
  if (create) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o022) fail('Deployment directory must be owned by the deployment user and not writable by others.');
  return fs.realpathSync(target);
}

function atomicJson(target, data, mode = 0o600) {
  noSymlinkPath(target);
  const temp = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, mode);
    try { fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
    const directory = fs.openSync(path.dirname(target), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function readJson(target) {
  noSymlinkPath(target);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.mode & 0o022 || stat.size > 4 * 1024 * 1024) fail('Unsafe JSON metadata.');
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch { fail('Invalid deployment metadata JSON.'); }
}

function pointer(root, name) {
  if (!['current', 'previous'].includes(name)) fail('Invalid release pointer.');
  const target = path.join(root, name);
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isSymbolicLink()) fail('Release pointer must be a symlink.');
  const real = fs.realpathSync(target);
  if (path.dirname(real) !== path.join(root, 'releases') || !inside(root, real)) fail('Release pointer escapes releases.');
  return sha(path.basename(real));
}

function setPointer(root, name, commit) {
  sha(commit);
  if (!['current', 'previous'].includes(name)) fail('Invalid release pointer.');
  const directory = path.join(root, 'releases', commit);
  noSymlinkPath(directory);
  if (!fs.statSync(directory).isDirectory()) fail('Release is missing.');
  const temp = path.join(root, `.${name}.${crypto.randomBytes(8).toString('hex')}`);
  fs.symlinkSync(path.join('releases', commit), temp);
  try {
    fs.renameSync(temp, path.join(root, name));
    const fd = fs.openSync(root, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}

// No recursive rm follows user-controlled links. Only a direct, verified child
// of one of the two controller-owned containers may be removed.
function removeTree(container, target, protectedPaths = []) {
  noSymlinkPath(container);
  if (path.dirname(target) !== container || !inside(container, target)) fail('Deletion outside the allowed container refused.');
  noSymlinkPath(target);
  const real = fs.realpathSync(target);
  if (real !== target || protectedPaths.includes(real)) fail('Deletion of a protected release refused.');
  function remove(entry) {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink() || stat.isFile()) { fs.unlinkSync(entry); return; }
    if (!stat.isDirectory()) fail('Unexpected filesystem object in release.');
    fs.chmodSync(entry, 0o700);
    for (const child of fs.readdirSync(entry)) remove(path.join(entry, child));
    fs.rmdirSync(entry);
  }
  remove(real);
}

module.exports = { fail, sha, inside, noSymlinkPath, privateFile, secureDir, atomicJson, readJson, pointer, setPointer, removeTree };
