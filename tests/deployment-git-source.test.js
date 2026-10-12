'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { createGitSource, verifySource, validateTreeListing, fingerprint } = require('../scripts/deploy/release');
const { GIT_OPTIONS, SOURCE_LIMITS, writeBlobStream } = require('../scripts/deploy/git-blobs');
const { run, cleanEnv } = require('../scripts/deploy/process');
const { removeTree } = require('../scripts/deploy/fs-safety');

const blob = data => crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const entry = (name, data, mode = '100644') => ({ path: name, blob: blob(data), mode });
const frame = (file, data) => Buffer.concat([Buffer.from(`${file.blob} blob ${data.length}\n`), data, Buffer.from('\n')]);

function fixture(t, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qgs-'));
  t.after(() => removeTree(os.tmpdir(), root));
  const cache = path.join(root, 'state/repository.git');
  const candidates = path.join(root, 'state/candidates'); fs.mkdirSync(candidates, { recursive: true });
  const env = cleanEnv({ GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' });
  function git(args, input) {
    const result = spawnSync('/usr/bin/git', [...GIT_OPTIONS, '-C', cache, ...args], { env, input, timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
  }
  fs.mkdirSync(cache);
  git(['init', '--bare']);
  const data = contents || {
    '.gitattributes': Buffer.from('scripts/windows/*.cmd text eol=crlf\nscripts/windows/*.ps1 text eol=crlf\nREADME.txt export-subst\nignored.txt export-ignore\n'),
    'README.txt': Buffer.from('LF text\n$Format:%H$\n'),
    'ignored.txt': Buffer.from('still required by the commit tree\n'),
    'scripts/windows/Start.cmd': Buffer.from('@echo off\r\necho fixture\r\n'),
    'scripts/windows/Install.ps1': Buffer.from('\ufeffWrite-Output "fixture"\n'),
    'binary.bin': Buffer.from([0, 255, 195, 40, 13, 10, 0]),
    'run.sh': Buffer.from('#!/bin/sh\nexit 0\n'),
  };
  const files = Object.entries(data).map(([name, value]) => entry(name, value, name === 'run.sh' ? '100755' : '100644'));
  for (const file of files) assert.equal(git(['hash-object', '-w', '--stdin'], data[file.path]).toString().trim(), file.blob);
  function tree(prefix = '') {
    const rows = [], dirs = new Set();
    for (const file of files.filter(value => value.path.startsWith(prefix))) {
      const relative = file.path.slice(prefix.length), slash = relative.indexOf('/');
      if (slash < 0) rows.push(`${file.mode} blob ${file.blob}\t${relative}`);
      else dirs.add(relative.slice(0, slash));
    }
    for (const dir of dirs) rows.push(`040000 tree ${tree(`${prefix}${dir}/`)}\t${dir}`);
    return git(['mktree'], rows.join('\n') + '\n').toString().trim();
  }
  const commit = git(['commit-tree', tree()], 'Exact blob fixture\n').toString().trim();
  git(['update-ref', 'refs/remotes/trusted/master', commit]);
  const calls = [];
  const execute = async (command, args, options) => {
    calls.push({ command, args });
    if (args.includes('fetch')) return { code: 0, output: '' }; // Only the official network transport is mocked.
    return run(command, args, options);
  };
  const source = createGitSource({ root }, undefined, execute);
  const candidate = fs.mkdtempSync(path.join(candidates, `${commit}.`));
  return { root, cache, data, files, git, commit, source, candidate, calls, execute,
    anotherCandidate() { return fs.mkdtempSync(path.join(candidates, `${commit}.`)); } };
}

test('real Git blob export preserves LF, CRLF, BOM, binary bytes, all tree files and executable modes', { timeout: 15000 }, async t => {
  const f = fixture(t), proof = await f.source.resolve(f.commit);
  await f.source.materialize(proof, f.candidate);
  for (const file of f.files) assert.deepEqual(fs.readFileSync(path.join(f.candidate, file.path)), f.data[file.path]);
  assert.equal(fs.statSync(path.join(f.candidate, 'run.sh')).mode & 0o111, 0o111);
  assert.equal(fs.statSync(path.join(f.candidate, 'README.txt')).mode & 0o111, 0);
  verifySource(f.candidate, proof.files); verifySource(f.candidate, proof.files);
  const sealed = fingerprint(f.candidate, { seal: true });
  verifySource(f.candidate, proof.files);
  assert.equal(fingerprint(f.candidate, { requireReadOnly: true }).digest, sealed.digest);
  assert.equal(f.calls.some(call => call.args.includes('archive') || call.command === '/usr/bin/tar'), false);
});

test('normal Windows checkout still applies CRLF while the Linux snapshot matches raw Git blobs', { timeout: 15000 }, async t => {
  const f = fixture(t), proof = await f.source.resolve(f.commit);
  await f.source.materialize(proof, f.candidate);
  const checkout = path.join(f.root, 'windows-checkout'); fs.mkdirSync(checkout);
  f.git(['--work-tree', checkout, 'read-tree', f.commit]);
  f.git(['--work-tree', checkout, 'checkout-index', '--all', '--force']);
  for (const name of ['scripts/windows/Start.cmd', 'scripts/windows/Install.ps1']) {
    const raw = fs.readFileSync(path.join(f.candidate, name)), checkedOut = fs.readFileSync(path.join(checkout, name));
    assert.equal(blob(raw), proof.files.find(file => file.path === name).blob);
    assert.ok(checkedOut.includes(Buffer.from('\r\n')));
    assert.equal(checkedOut.toString().replace(/\r\n/g, '\n'), raw.toString().replace(/\r\n/g, '\n'));
  }
  // Neither even a legitimate EOL-only rewrite nor a content edit is allowed after export.
  const ps1 = path.join(f.candidate, 'scripts/windows/Install.ps1');
  fs.writeFileSync(ps1, fs.readFileSync(path.join(checkout, 'scripts/windows/Install.ps1')));
  assert.throws(() => verifySource(f.candidate, proof.files), { code: 'SOURCE_CHANGED' });
});

for (const change of ['content', 'extra-file', 'extra-directory', 'missing', 'executable-removed', 'executable-partially-removed', 'executable-added', 'symlink', 'hardlink']) {
  test(`source verification rejects ${change} after a valid export`, { timeout: 15000 }, async t => {
    const f = fixture(t), proof = await f.source.resolve(f.commit);
    await f.source.materialize(proof, f.candidate);
    const text = path.join(f.candidate, 'README.txt'), script = path.join(f.candidate, 'run.sh');
    if (change === 'content') fs.appendFileSync(text, 'changed\n');
    if (change === 'extra-file') fs.writeFileSync(path.join(f.candidate, 'extra.js'), 'extra');
    if (change === 'extra-directory') fs.mkdirSync(path.join(f.candidate, 'extra'));
    if (change === 'missing') fs.unlinkSync(text);
    if (change === 'executable-removed') fs.chmodSync(script, 0o644);
    if (change === 'executable-partially-removed') fs.chmodSync(script, 0o744);
    if (change === 'executable-added') fs.chmodSync(text, 0o755);
    if (change === 'symlink') { fs.unlinkSync(text); fs.symlinkSync(script, text); }
    if (change === 'hardlink') fs.linkSync(text, path.join(f.root, 'linked-source'));
    assert.throws(() => verifySource(f.candidate, proof.files), { code: 'SOURCE_CHANGED' });
  });
}

test('commit binding rejects altered proof, invalid SHA, tree objects and destinations outside candidates', { timeout: 15000 }, async t => {
  const f = fixture(t), proof = await f.source.resolve(f.commit);
  const altered = { ...proof, files: proof.files.map((file, index) => index ? file : { ...file, blob: '0'.repeat(40) }) };
  await assert.rejects(f.source.materialize(altered, f.candidate), { code: 'SOURCE_CHANGED' });
  for (const commitSha of ['master', f.commit.slice(0, 8), '0'.repeat(40), f.git(['rev-parse', `${f.commit}^{tree}`]).toString().trim()]) {
    await assert.rejects(f.source.resolve(commitSha));
  }
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  await assert.rejects(f.source.materialize(proof, outside), /isolated candidate/);
  const link = path.join(f.root, 'state/candidates', `${f.commit}.link`); fs.symlinkSync(outside, link);
  await assert.rejects(f.source.materialize(proof, link), /Symlink/);
  fs.writeFileSync(path.join(f.candidate, 'keep'), 'existing');
  await assert.rejects(f.source.materialize(proof, f.candidate), /must be empty/);
  assert.equal(fs.readFileSync(path.join(f.candidate, 'keep'), 'utf8'), 'existing');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('Git tree rejects traversal, links, submodules, duplicate paths, conflicts and truncated listings', () => {
  const oid = 'a'.repeat(40), row = name => `100644 blob ${oid}\t${name}\0`;
  for (const value of [`120000 blob ${oid}\tlink\0`, `160000 commit ${oid}\tmodule\0`, row('../escape'), row('/absolute'),
    row('a/../escape'), row('a\\escape'), row('.git/config'), row('node_modules/evil'), row('release-info.json'),
    row('same') + row('same'), row('file') + row('file/child'), row('a').slice(0, -1), '', row('bad\nname')]) {
    assert.throws(() => validateTreeListing(value));
  }
});

test('binary batch parser handles every framing boundary, empty blobs and repeated blob IDs', async t => {
  const f = fixture(t), data = Buffer.from([0, 13, 10, 255]), empty = Buffer.alloc(0);
  const files = [entry('one', data), entry('nested/two', data), entry('empty', empty)];
  const bytes = Buffer.concat([frame(files[0], data), frame(files[1], data), frame(files[2], empty)]);
  await writeBlobStream(f.candidate, files, Readable.from([...bytes].map(byte => Buffer.from([byte]))));
  verifySource(f.candidate, files);
  assert.deepEqual(fs.readFileSync(path.join(f.candidate, 'one')), data);
});

for (const problem of ['header', 'body', 'separator', 'missing-object', 'wrong-object', 'wrong-type', 'wrong-content', 'extra-data', 'size-limit', 'invalid-size']) {
  test(`batch export fails closed for ${problem}`, async t => {
    const f = fixture(t), data = Buffer.from('trusted\n'), file = entry('source', data);
    let bytes = frame(file, data);
    if (problem === 'header') bytes = bytes.subarray(0, 12);
    if (problem === 'body') bytes = bytes.subarray(0, bytes.length - 3);
    if (problem === 'separator') bytes = bytes.subarray(0, bytes.length - 1);
    if (problem === 'missing-object') bytes = Buffer.from(`${file.blob} missing\n`);
    if (problem === 'wrong-object') bytes = frame({ ...file, blob: '0'.repeat(40) }, data);
    if (problem === 'wrong-type') bytes = Buffer.from(`${file.blob} tree 0\n\n`);
    if (problem === 'wrong-content') bytes = frame(file, Buffer.from('changed\n'));
    if (problem === 'extra-data') bytes = Buffer.concat([bytes, Buffer.from('extra')]);
    if (problem === 'size-limit') bytes = Buffer.from(`${file.blob} blob ${SOURCE_LIMITS.fileBytes + 1}\n`);
    if (problem === 'invalid-size') bytes = Buffer.from(`${file.blob} blob 999999999999999999999\n`);
    await assert.rejects(writeBlobStream(f.candidate, [file], Readable.from([bytes])), { code: 'SOURCE_CHANGED' });
  });
}

test('batch export enforces total size and rejects widened limits or untrusted paths before writing', async t => {
  const f = fixture(t), data = Buffer.from('12345678'), files = [entry('one', data), entry('two', data)];
  await assert.rejects(writeBlobStream(f.candidate, files, Readable.from(files.map(file => frame(file, data))), { fileBytes: 8, totalBytes: 12 }), { code: 'SOURCE_CHANGED' });
  for (const file of [{ ...files[0], path: '../escape' }, { ...files[0], mode: '120000' }, { ...files[0], blob: 'HEAD' }]) {
    await assert.rejects(writeBlobStream(f.anotherCandidate(), [file], Readable.from([])));
  }
  await assert.rejects(writeBlobStream(f.anotherCandidate(), files, Readable.from([]), { fileBytes: SOURCE_LIMITS.fileBytes + 1, totalBytes: SOURCE_LIMITS.totalBytes }));
  assert.equal(fs.existsSync(path.join(f.root, 'state/escape')), false);
});

test('interrupted blob stream rejects instead of accepting partially written source', async t => {
  const f = fixture(t), data = Buffer.from('trusted\n'), file = entry('source', data);
  async function* interrupted() { yield frame(file, data).subarray(0, 50); throw Object.assign(new Error('Interrupted fixture'), { code: 'CANCELLED' }); }
  await assert.rejects(writeBlobStream(f.candidate, [file], Readable.from(interrupted())), { code: 'CANCELLED' });
  assert.throws(() => verifySource(f.candidate, [file]), { code: 'SOURCE_CHANGED' });
});

test('cancelling a real Git export terminates its own process and cannot produce a release', { timeout: 15000 }, async t => {
  const f = fixture(t, { 'large.bin': Buffer.alloc(16 * 1024 * 1024, 0x41) });
  const abort = new AbortController(), source = createGitSource({ root: f.root }, abort.signal, f.execute);
  const proof = await source.resolve(f.commit);
  const watcher = fs.watch(f.candidate, () => abort.abort());
  t.after(() => watcher.close());
  const timer = setTimeout(() => abort.abort(), 5000);
  try { await assert.rejects(source.materialize(proof, f.candidate), { code: 'CANCELLED' }); }
  finally { clearTimeout(timer); watcher.close(); }
  assert.ok(fs.existsSync(path.join(f.candidate, 'large.bin')), 'abort occurs after blob export starts');
  const processes = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name)).filter(pid => {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').includes(f.cache);
    } catch (error) { if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return false; throw error; }
  });
  assert.deepEqual(processes, []);
  assert.equal(fs.existsSync(path.join(f.root, 'releases', f.commit)), false);
});
