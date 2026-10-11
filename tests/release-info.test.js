'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');
const { readReleaseInfo } = require('../scripts/release-info');

test('release metadata identifies a real full SHA and handles detached HEAD and SHA mismatches', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qingsi-release-info-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--initial-branch=metadata-test');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version: '1.5.0' }));
  git('add', 'package.json');
  const subject = 'CI metadata: "quoted" $(literal)';
  git('-c', 'user.name=CI Test', '-c', 'user.email=ci-test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', subject);
  const commitSha = git('rev-parse', 'HEAD');
  const info = readReleaseInfo({ cwd, env: {} });
  assert.equal(info.commitSha, commitSha);
  assert.match(info.commitSha, /^[a-f0-9]{40}$/);
  assert.equal(info.commitSubject, subject);
  assert.equal(info.branch, 'metadata-test');
  assert.equal(info.packageVersion, '1.5.0');
  assert.ok(Number.isFinite(Date.parse(info.checkedAt)));
  assert.equal(info.ci, undefined);

  git('checkout', '--detach', commitSha);
  const env = {
    GITHUB_ACTIONS: 'true', GITHUB_SHA: commitSha, GITHUB_REF: 'refs/pull/123/merge',
    GITHUB_REPOSITORY: 'Polaris-deutsch/qingsi-games', GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
  };
  const detached = readReleaseInfo({ cwd, env });
  assert.equal(detached.branch, null);
  assert.equal(detached.commitSha, commitSha);
  assert.equal(detached.ci.ref, 'refs/pull/123/merge');
  assert.equal(detached.ci.runAttempt, '2');
  assert.throws(() => readReleaseInfo({ cwd, env: { GITHUB_SHA: '0'.repeat(40) } }), /does not match/);
  assert.throws(() => readReleaseInfo({ cwd, env: { GITHUB_SHA: commitSha.slice(0, 7) } }), /does not match/);
});

test('release metadata never invents a SHA when Git is unavailable', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'qingsi-no-git-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"version":"1.5.0"}');
  assert.throws(() => readReleaseInfo({ cwd, env: {} }));
});

test('release metadata CLI emits JSON and rejects a SHA unrelated to its checkout', () => {
  const script = path.resolve(__dirname, '../scripts/release-info.js');
  const env = { ...process.env };
  delete env.GITHUB_SHA;
  const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8', timeout: 20000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).commitSha, /^[a-f0-9]{40}$/);
  const mismatch = spawnSync(process.execPath, [script], {
    env: { ...env, GITHUB_SHA: '0'.repeat(40) }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(mismatch.error, undefined);
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /Cannot identify release:.*does not match/);
  assert.equal(mismatch.stdout, '');
});
