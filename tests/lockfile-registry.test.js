'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Audited tree from fddd4ee58f6cace33f991b2f52692c283eda7277, excluding only
// packages[*].resolved. Versions, original SRI, edges, flags and root metadata
// remain pinned. An intentional dependency update must review this baseline.
const TREE_SHA256 = '8c27e3566022de3c5e273e06932360c17feb046c6904076d4872afb97d02ed8d';
// Git/workspace/file/alias dependencies are not inherently invalid. None are
// currently approved. Future exceptions require an exact reviewed lock entry
// keyed by its location here, plus a reviewed tree baseline; never a wildcard.
const REVIEWED_SPECIAL_SOURCES = Object.freeze({});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function treeDigest(value) {
  const tree = structuredClone(value);
  for (const entry of Object.values(tree.packages)) delete entry.resolved;
  return crypto.createHash('sha256').update(JSON.stringify(canonical(tree))).digest('hex');
}

function registryEntry(location, entry) {
  const name = location.split('node_modules/').at(-1);
  const packagePattern = '(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*';
  assert.match(location, new RegExp(`^node_modules/${packagePattern}(?:/node_modules/${packagePattern})*$`));
  assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry));
  assert.equal(entry.link, undefined, `${location}: links need explicit source review`);
  assert.ok(entry.name === undefined || entry.name === name, `${location}: aliases need explicit source review`);
  assert.match(entry.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, `${location}: missing or invalid SHA-512 SRI`);
  const digest = Buffer.from(entry.integrity.slice(7), 'base64');
  assert.equal(digest.length, 64);
  assert.equal(digest.toString('base64'), entry.integrity.slice(7), `${location}: noncanonical SRI`);
  const expected = `https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${entry.version}.tgz`;
  assert.equal(entry.resolved, expected, `${location}: unapproved registry, package, version or URL components`);
}

function verifyPolicy(value, manifest = pkg) {
  assert.equal(value.lockfileVersion, 3, 'Lockfile format change needs review');
  assert.deepEqual(value.packages[''].dependencies, manifest.dependencies, 'Direct dependency constraints must match');
  for (const [location, entry] of Object.entries(value.packages)) {
    if (location === '') continue;
    if (Object.hasOwn(REVIEWED_SPECIAL_SOURCES, location)) {
      assert.deepEqual(entry, REVIEWED_SPECIAL_SOURCES[location], 'Special source differs from reviewed entry');
    } else registryEntry(location, entry);
  }
  assert.equal(treeDigest(value), TREE_SHA256, 'Dependency tree, versions or original integrity changed; review required');
}

test('locked sources use official HTTPS tarballs and retain the audited dependency tree and SRI', () => {
  verifyPolicy(lock);
});

test('registry paths support scoped packages and nested exact versions', () => {
  const integrity = lock.packages['node_modules/ms'].integrity;
  registryEntry('node_modules/@example/tool', { version: '1.2.3', integrity,
    resolved: 'https://registry.npmjs.org/@example/tool/-/tool-1.2.3.tgz' });
  registryEntry('node_modules/send/node_modules/ms', lock.packages['node_modules/send/node_modules/ms']);
});

for (const [name, url] of Object.entries({
  http: 'http://registry.npmjs.org/ms/-/ms-2.0.0.tgz',
  mirror: 'https://registry.npmmirror.com/ms/-/ms-2.0.0.tgz',
  thirdParty: 'https://downloads.example.org/ms/-/ms-2.0.0.tgz',
  hostSuffix: 'https://registry.npmjs.org.example.org/ms/-/ms-2.0.0.tgz',
  credentials: 'https://user:password@registry.npmjs.org/ms/-/ms-2.0.0.tgz',
  port: 'https://registry.npmjs.org:8443/ms/-/ms-2.0.0.tgz',
  query: 'https://registry.npmjs.org/ms/-/ms-2.0.0.tgz?source=other',
  fragment: 'https://registry.npmjs.org/ms/-/ms-2.0.0.tgz#other',
  wrongPackage: 'https://registry.npmjs.org/other/-/other-2.0.0.tgz',
  wrongVersion: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
  traversal: 'https://registry.npmjs.org/ms/../ms/-/ms-2.0.0.tgz',
  git: 'git+https://github.com/example/ms.git#abcdef',
  local: 'file:../ms.tgz',
})) {
  test(`source policy rejects ${name} URL without an explicit review`, () => {
    const changed = structuredClone(lock);
    changed.packages['node_modules/ms'].resolved = url;
    assert.throws(() => verifyPolicy(changed));
  });
}

for (const [name, mutate] of Object.entries({
  missingIntegrity: entry => { delete entry.integrity; },
  invalidIntegrity: entry => { entry.integrity = 'sha512-invalid'; },
  weakerIntegrity: entry => { entry.integrity = `sha1-${Buffer.alloc(20).toString('base64')}`; },
  replacedIntegrity: entry => { entry.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`; },
  changedVersion: entry => { entry.version = '2.1.3'; entry.resolved = 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz'; },
  changedEdge: entry => { entry.dependencies = { unexpected: '^1.0.0' }; },
  alias: entry => { entry.name = 'different-package'; },
  workspaceLink: entry => { entry.link = true; },
})) {
  test(`source policy rejects ${name} even if other fields remain valid`, () => {
    const changed = structuredClone(lock);
    mutate(changed.packages['node_modules/ms']);
    assert.throws(() => verifyPolicy(changed));
  });
}

test('source policy rejects lockfile format, package set and direct constraint changes', () => {
  for (const version of [1, 2, 4, '3', undefined]) {
    const changed = structuredClone(lock); changed.lockfileVersion = version;
    assert.throws(() => verifyPolicy(changed));
  }
  const missing = structuredClone(lock); delete missing.packages['node_modules/ms'];
  assert.throws(() => verifyPolicy(missing));
  const extra = structuredClone(lock); extra.packages['node_modules/unexpected'] = {
    ...lock.packages['node_modules/ms'], resolved: 'https://registry.npmjs.org/unexpected/-/unexpected-2.0.0.tgz' };
  assert.throws(() => verifyPolicy(extra));
  const manifest = structuredClone(pkg); manifest.dependencies.ws = '^8.22.0';
  assert.throws(() => verifyPolicy(lock, manifest));
  const changed = structuredClone(lock); changed.packages[''].dependencies.ws = '^8.22.0';
  assert.throws(() => verifyPolicy(changed, manifest));
});
