'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPOSITORY_URL, WORKFLOW } = require('./constants');
const { sha, fail, noSymlinkPath, atomicJson, readJson, inside } = require('./fs-safety');
const { run, cleanEnv } = require('./process');
const { SOURCE_LIMITS, GIT_OPTIONS, validateSourceFiles, exportGitBlobs } = require('./git-blobs');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const approvedPolicy = (value, policy) => (Array.isArray(policy) ? policy : [policy]).includes(value);

function validateTreeListing(output) {
  if (typeof output !== 'string' || !output.endsWith('\0')) fail('Git tree listing is empty or incomplete.');
  return validateSourceFiles(output.slice(0, -1).split('\0').map(line => {
    const match = line.match(/^(100644|100755) blob ([a-f0-9]{40})\t([^\x00]+)$/);
    if (!match) fail('Git tree contains unsupported symlinks or submodules.');
    return { mode: match[1], blob: match[2], path: match[3] };
  }));
}

function verifySource(directory, files) {
  validateSourceFiles(files);
  noSymlinkPath(directory);
  let totalBytes = 0;
  const expectedFiles = new Set(files.map(file => file.path));
  const expectedDirectories = new Set(['']);
  for (const file of files) {
    let parent = path.posix.dirname(file.path);
    while (parent !== '.') { expectedDirectories.add(parent); parent = path.posix.dirname(parent); }
  }
  function checkNames(relative = '') {
    for (const name of fs.readdirSync(path.join(directory, relative))) {
      if (relative === '' && ['node_modules', 'release-info.json', '.qingsi-release.json'].includes(name)) continue;
      const child = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(path.join(directory, child));
      if (stat.isDirectory() && expectedDirectories.has(child)) checkNames(child);
      else if (!stat.isFile() || !expectedFiles.has(child)) fail('Unexpected source file or directory was generated during preparation.', 'SOURCE_CHANGED');
    }
  }
  checkNames();
  for (const file of files) {
    const target = path.join(directory, file.path);
    if (!inside(directory, target)) fail('Source path escapes the candidate.');
    noSymlinkPath(target);
    let stat;
    try { stat = fs.lstatSync(target); }
    catch (error) { if (error.code === 'ENOENT') fail('Approved source file is missing.', 'SOURCE_CHANGED'); throw error; }
    totalBytes += stat.size;
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > SOURCE_LIMITS.fileBytes || totalBytes > SOURCE_LIMITS.totalBytes ||
        (stat.mode & 0o111) !== (file.mode === '100755' ? 0o111 : 0)) fail('Invalid source file, size or executable mode.', 'SOURCE_CHANGED');
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let content;
    try { content = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    const blob = crypto.createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    if (blob !== file.blob) fail('Candidate source differs from the approved Git commit.', 'SOURCE_CHANGED');
  }
}

function fingerprint(directory, { seal = false, requireReadOnly = false } = {}) {
  noSymlinkPath(directory);
  const entries = [];
  let count = 0, totalBytes = 0;
  function visit(target, relative) {
    const stat = fs.lstatSync(target);
    if (++count > 100000) fail('Release contains too many filesystem entries.');
    if (stat.isSymbolicLink()) {
      const destination = fs.realpathSync(target);
      if (!inside(directory, destination)) fail('Release symlink escapes its directory.');
      entries.push([relative, 'link', fs.readlinkSync(target)]);
    } else if (stat.isDirectory()) {
      if (seal) fs.chmodSync(target, 0o555);
      else if (requireReadOnly && stat.mode & 0o222) fail('Release directory is writable.');
      entries.push([relative, 'directory']);
      for (const name of fs.readdirSync(target).sort()) {
        if (relative === '' && name === '.qingsi-release.json') continue;
        visit(path.join(target, name), relative ? `${relative}/${name}` : name);
      }
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) fail('Release files must not share hard links with other versions.');
      totalBytes += stat.size;
      if (totalBytes > 512 * 1024 * 1024) fail('Release exceeds the 512 MiB verification limit.');
      if (stat.size > 128 * 1024 * 1024) fail('Release file is too large.');
      const executable = Boolean(stat.mode & 0o111);
      if (seal) fs.chmodSync(target, executable ? 0o555 : 0o444);
      else if (requireReadOnly && stat.mode & 0o222) fail('Release file is writable.');
      entries.push([relative, executable ? 'executable' : 'file', digest(fs.readFileSync(target))]);
    } else fail('Unsupported filesystem object in release.');
  }
  visit(directory, '');
  return { digest: digest(JSON.stringify(entries)), entries: count };
}

function checkLayout(directory, policyDigest) {
  for (const name of ['server.js', 'startup-port.js', 'public-origin.js', 'internet-security.js', 'package.json', 'package-lock.json',
    'scripts/check-syntax.js', 'scripts/deploy/runtime.js', 'scripts/deploy/fs-safety.js', 'scripts/deploy/room-status.js']) {
    const file = noSymlinkPath(path.join(directory, name));
    if (!fs.statSync(file).isFile()) fail(`Candidate is missing ${name}.`);
  }
  for (const name of ['games', 'bots', 'public', 'lang', 'node_modules']) {
    if (!fs.statSync(noSymlinkPath(path.join(directory, name))).isDirectory()) fail(`Candidate is missing ${name}.`);
  }
  for (const name of ['express', 'compression', 'qrcode', 'ws']) {
    if (!fs.statSync(noSymlinkPath(path.join(directory, 'node_modules', name, 'package.json'))).isFile()) fail('Production dependencies are incomplete.');
  }
  if (!approvedPolicy(digest(fs.readFileSync(path.join(directory, WORKFLOW))), policyDigest)) fail('Candidate CI policy differs from the approved workflow digest.', 'POLICY_CHANGED');
  const pkg = readJson(path.join(directory, 'package.json'));
  const lock = readJson(path.join(directory, 'package-lock.json'));
  if (pkg.scripts?.check !== 'node scripts/check-syntax.js' || typeof pkg.version !== 'string' || !pkg.version ||
      lock.packages?.['']?.version !== pkg.version || JSON.stringify(lock.packages[''].dependencies) !== JSON.stringify(pkg.dependencies)) {
    fail('Candidate package manifest, check entrypoint or lockfile is inconsistent.');
  }
  return pkg;
}

function sealRelease(directory, info) {
  const tree = fingerprint(directory, { seal: true });
  // Temporarily open only the root directory to add the final manifest.
  fs.chmodSync(directory, 0o700);
  try { atomicJson(path.join(directory, '.qingsi-release.json'), { schemaVersion: 1, ...info, tree }, 0o444); }
  finally { fs.chmodSync(directory, 0o555); }
  return { tree, manifestHash: digest(fs.readFileSync(path.join(directory, '.qingsi-release.json'))) };
}

function verifyRelease(root, commit, policyDigest) {
  sha(commit);
  const directory = noSymlinkPath(path.join(root, 'releases', commit));
  if (fs.realpathSync(directory) !== directory) fail('Release directory is not canonical.');
  const attestation = readJson(path.join(root, 'state', 'prepared', `${commit}.json`));
  const manifestPath = path.join(directory, '.qingsi-release.json');
  const manifest = readJson(manifestPath);
  const metadata = readJson(path.join(directory, 'release-info.json'));
  if (fs.statSync(manifestPath).mode & 0o222 || attestation.schemaVersion !== 1 || manifest.schemaVersion !== 1 ||
      manifest.commitSha !== commit || attestation.commitSha !== commit || metadata.commitSha !== commit ||
      manifest.repositoryUrl !== REPOSITORY_URL || attestation.manifestHash !== digest(fs.readFileSync(manifestPath)) ||
      manifest.ci?.headSha !== commit || manifest.ci?.conclusion !== 'success' || metadata.schemaVersion !== 1 ||
      ['syntax', 'audit', 'smoke'].some(name => manifest.checks?.[name] !== 'success')) fail('Release metadata or preparation attestation is invalid.');
  checkLayout(directory, policyDigest);
  const tree = fingerprint(directory, { requireReadOnly: true });
  if (tree.digest !== manifest.tree?.digest || tree.digest !== attestation.tree?.digest) fail('Release contents changed after preparation.', 'SOURCE_CHANGED');
  return { directory, manifest, attestation };
}

function createGitSource(config, signal, execute = run) {
  const cache = path.join(config.root, 'state', 'repository.git');
  const git = (args, options = {}) => execute('/usr/bin/git', [...GIT_OPTIONS, ...args], { env: cleanEnv(), timeout: 60000, signal, ...options });
  async function resolve(commit) {
    sha(commit);
    noSymlinkPath(cache);
    if (!fs.existsSync(cache)) await git(['init', '--bare', cache]);
    const localConfig = fs.readFileSync(noSymlinkPath(path.join(cache, 'config')), 'utf8').trim().split('\n').map(line => line.trim());
    if (localConfig.length !== 4 || localConfig[0] !== '[core]' || !localConfig.slice(1).every(line => /^(repositoryformatversion\s*=\s*0|filemode\s*=\s*true|bare\s*=\s*true)$/.test(line))) {
      fail('Repository cache has unapproved configuration or URL rewrite rules.', 'SOURCE_UNTRUSTED');
    }
    // URL is a compiled constant. No origin HEAD, URL argument or local repo is accepted.
    await git(['-C', cache, 'fetch', '--no-tags', '--prune', REPOSITORY_URL, '+refs/heads/master:refs/remotes/trusted/master']);
    const master = (await git(['-C', cache, 'rev-parse', '--verify', 'refs/remotes/trusted/master^{commit}'])).output.trim();
    sha(master);
    if ((await git(['-C', cache, 'cat-file', '-t', commit])).output.trim() !== 'commit') fail('Requested object is not a Git commit.');
    const ancestry = await git(['-C', cache, 'merge-base', '--is-ancestor', commit, master], { allowFailure: true });
    if (ancestry.code !== 0) fail('Requested SHA is not in the trusted remote master history.');
    const files = validateTreeListing((await git(['-C', cache, 'ls-tree', '-r', '-z', commit])).output);
    const subject = (await git(['-C', cache, 'show', '--no-patch', '--format=%s', commit])).output.trim().slice(0, 512);
    return { repositoryUrl: REPOSITORY_URL, commitSha: commit, masterSha: master, inMasterHistory: true, subject, files };
  }
  async function materialize(proof, directory) {
    const commit = sha(proof.commitSha);
    if (proof.repositoryUrl !== REPOSITORY_URL || proof.inMasterHistory !== true) fail('Untrusted source proof.');
    noSymlinkPath(cache);
    noSymlinkPath(directory);
    if (path.dirname(directory) !== path.join(config.root, 'state', 'candidates') || !path.basename(directory).startsWith(`${commit}.`)) {
      fail('Source destination must be an isolated candidate for the exact SHA.');
    }
    // Re-read the tree to bind every requested blob/path/mode to this commit,
    // rather than accepting a modified in-memory source proof.
    if ((await git(['-C', cache, 'cat-file', '-t', commit])).output.trim() !== 'commit') fail('Requested object is not a Git commit.');
    const files = validateTreeListing((await git(['-C', cache, 'ls-tree', '-r', '-z', commit])).output);
    if (JSON.stringify(files) !== JSON.stringify(proof.files)) fail('Source proof differs from the exact commit tree.', 'SOURCE_CHANGED');
    await exportGitBlobs(cache, directory, files, signal);
    verifySource(directory, files);
  }
  return { resolve, materialize };
}

module.exports = { digest, approvedPolicy, validateTreeListing, verifySource, fingerprint, checkLayout, sealRelease, verifyRelease, createGitSource };
