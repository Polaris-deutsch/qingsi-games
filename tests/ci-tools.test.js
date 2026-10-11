'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { requireSuccessfulChecks } = require('../scripts/ci-gate');

test('deployment gate requires test and audit and rejects every non-success result', () => {
  requireSuccessfulChecks({ test: { result: 'success' }, audit: { result: 'success' } });
  for (const name of ['test', 'audit']) {
    for (const result of ['failure', 'cancelled', 'skipped', 'queued', 'in_progress', 'timed_out', 'neutral', undefined]) {
      const needs = { test: { result: 'success' }, audit: { result: 'success' }, [name]: { result } };
      assert.throws(() => requireSuccessfulChecks(needs), new RegExp(name));
    }
    const needs = { test: { result: 'success' }, audit: { result: 'success' } };
    delete needs[name];
    assert.throws(() => requireSuccessfulChecks(needs), /missing/);
  }
  for (const value of [null, undefined, [], 'success', {}]) {
    assert.throws(() => requireSuccessfulChecks(value));
  }
  assert.throws(() => requireSuccessfulChecks({
    test: { result: 'success' }, audit: { result: 'success' }, future: { result: 'failure' },
  }), /future/);
});

test('deployment gate CLI fails with a clear reason for malformed or cancelled results', () => {
  const script = path.resolve(__dirname, '../scripts/ci-gate.js');
  for (const input of ['', '{bad', JSON.stringify({ test: { result: 'cancelled' }, audit: { result: 'success' } })]) {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, NEEDS_RESULTS: input }, encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Deployment gate failed:/);
  }
});

test('actual CI audit step preserves vulnerability and registry failure exit codes', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/ci.yml'), 'utf8');
  const match = workflow.match(/      - name: Audit production dependencies\r?\n[\s\S]*?        run: \|\r?\n((?:          [^\r\n]*\r?\n)+)/);
  assert.ok(match, 'audit shell step must exist');
  const shell = match[1].replace(/^          /gm, '');
  for (const code of [0, 1, 127]) {
    // Fake npm only for this shell. No network call or dependency mutation.
    const stub = `npm() { printf '%s\\n' 'controlled audit result'; return ${code}; }\n`;
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', stub + shell], {
      encoding: 'utf8', timeout: 5000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, code, result.stderr);
    if (code !== 0) {
      assert.match(result.stdout, /::error::Production audit failed/);
      assert.doesNotMatch(result.stdout, /audit passed/);
    }
  }
});

// Exercise the actual entrypoint with controlled OS outcomes: a killed child
// has status=null, which must never be converted into a successful exit.
function runTestEntrypoint(result, files = ['example.test.js']) {
  const filename = path.resolve(__dirname, '../scripts/run-tests.js');
  const messages = [];
  let exitCode;
  let spawned = false;
  const exited = new Error('intercepted exit');
  const context = {
    __dirname: path.dirname(filename),
    require(name) {
      if (name === 'fs') return { readdirSync: () => files };
      if (name === 'child_process') return { spawnSync: () => { spawned = true; return result; } };
      return require(name);
    },
    process: { execPath: process.execPath, exit(code) { exitCode = code; throw exited; } },
    console: { error(message) { messages.push(message); } },
  };
  try {
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    assert.fail('test entrypoint must exit');
  } catch (error) {
    if (error !== exited) throw error;
  }
  return { exitCode, messages: messages.join('\n'), spawned };
}

test('test entrypoint preserves exit codes and fails closed on signals and launch errors', () => {
  for (const status of [0, 1, 2]) {
    assert.equal(runTestEntrypoint({ status, signal: null }).exitCode, status);
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const result = runTestEntrypoint({ status: null, signal });
    assert.equal(result.exitCode, 1);
    assert.ok(result.messages.includes(signal));
  }
  const failed = runTestEntrypoint({ status: null, error: new Error('spawn EACCES') });
  assert.equal(failed.exitCode, 1);
  assert.match(failed.messages, /spawn EACCES/);
  assert.equal(runTestEntrypoint({ status: null }).exitCode, 1);
  const empty = runTestEntrypoint({}, []);
  assert.equal(empty.exitCode, 1);
  assert.equal(empty.spawned, false);
});
