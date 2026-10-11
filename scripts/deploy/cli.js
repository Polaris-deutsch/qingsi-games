#!/usr/bin/env node
'use strict';

const path = require('node:path');
const readline = require('node:readline/promises');
const { loadConfig, parseArguments } = require('./config');
const { privateFile, fail, secureDir, noSymlinkPath } = require('./fs-safety');
const { cleanEnv, run } = require('./process');
const { createGitSource } = require('./release');
const { createGitHubClient, verifyCi, masterHead } = require('./github');
const { createSystemd, smoke } = require('./health');
const { DeploymentController } = require('./controller');

async function main(args) {
  const { command, commit, options } = parseArguments([...args]);
  if (process.platform !== 'linux' || process.getuid() === 0 || Number(process.versions.node.split('.')[0]) !== 24) fail('Controller requires Linux, a non-root deployment user and Node.js 24.');
  const config = loadConfig(options.configFile);
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const timer = setTimeout(cancel, command === 'check-updates' ? 60000 : 180000);
  try {
    const getJson = createGitHubClient({ token: config.githubTokenFile ? privateFile(config.githubTokenFile).trim() : undefined, signal: abort.signal });
    const controller = new DeploymentController(config, {
      signal: abort.signal, source: createGitSource(config, abort.signal), verifyCi: sha => verifyCi(sha, getJson), masterHead: () => masterHead(getJson),
      service: createSystemd(config), smoke: (directory, sha) => smoke(config, directory, sha, abort.signal),
      async npm(stage, directory, sha) {
        const npmHome = secureDir(path.join(config.root, 'state', 'npm-home'), { create: true });
        const env = cleanEnv({ HOME: npmHome, npm_config_registry: 'https://registry.npmjs.org', npm_config_fetch_retries: '0',
          npm_config_fetch_timeout: '15000', npm_config_fund: 'false', npm_config_audit_level: 'low', npm_config_ignore_scripts: 'true',
          ...(stage === 'ci' ? { npm_config_audit: 'false' } : {}) });
        const args = stage === 'check' ? ['run', 'check'] : stage === 'audit' ? ['audit', '--omit=dev'] : ['ci'];
        const logFile = noSymlinkPath(path.join(config.root, 'state', 'logs', `${sha}.prepare.log`));
        await run(config.nodePath, [config.npmCliPath, ...args], { cwd: directory, env, timeout: stage === 'ci' ? 60000 : 30000,
          signal: abort.signal, logFile });
      },
      log(event) { process.stderr.write(`${JSON.stringify(event)}\n`); },
    });
    options.confirm = async prompt => {
      if (!process.stdin.isTTY) return null;
      const terminal = readline.createInterface({ input: process.stdin, output: process.stderr });
      try { return (await terminal.question(`${prompt}\n> `, { signal: abort.signal })).trim(); }
      finally { terminal.close(); }
    };
    if ((await run(config.nodePath, ['--version'], { timeout: 3000, signal: abort.signal })).output.trim().split('.')[0] !== 'v24') fail('Configured candidate Node.js executable is not version 24.');
    const result = command === 'check-updates' ? await controller.checkUpdates()
      : command === 'prepare' ? await controller.prepare(commit)
      : command === 'deploy' ? await controller.deploy(commit, options)
        : command === 'rollback' ? await controller.rollback(options)
          : command === 'history' ? controller.history()
            : command === 'doctor' ? await controller.doctor(options) : await controller.status();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (command === 'check-updates' && result.status === 'check-failed') process.exitCode = result.error === 'LOCKED' ? 75 : result.error === 'CANCELLED' ? 130 : 1;
    if (command === 'status' && result.productionEnabled && !result.readyForPlayers) process.exitCode = 1;
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${JSON.stringify({ result: 'failed', code: error.code || 'FAILED', message: error.message })}\n`);
  process.exitCode = error.code === 'LOCKED' ? 75 : error.code === 'ROLLBACK_FAILED' ? 3 : error.code === 'USAGE' ? 2 : error.code === 'CANCELLED' ? 130 : 1;
});

module.exports = { main };
