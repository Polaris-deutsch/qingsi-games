'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { privateFile, noSymlinkPath, fail } = require('./fs-safety');

function loadConfig(filename) {
  let config;
  const text = privateFile(filename);
  try { config = JSON.parse(text); } catch { fail('Invalid deployment configuration JSON.'); }
  const allowed = new Set(['root', 'nodePath', 'npmCliPath', 'candidatePort', 'healthTimeoutMs', 'keepReleases',
    'productionEnabled', 'adminSocket', 'adminTokenFile', 'githubTokenFile', 'ciPolicySha256']);
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !allowed.has(key))) fail('Unknown deployment configuration key.');
  if (config.root !== '/srv/qingsi-games') fail('Production release root must be /srv/qingsi-games.');
  for (const key of ['nodePath', 'npmCliPath', 'adminTokenFile']) {
    if (typeof config[key] !== 'string') fail(`Missing ${key}.`);
    noSymlinkPath(path.dirname(config[key]));
    const target = fs.realpathSync(config[key]);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.mode & 0o022 || ![0, process.getuid()].includes(stat.uid)) fail(`Unsafe ${key}.`);
    config[key] = target;
  }
  if (config.githubTokenFile) privateFile(config.githubTokenFile);
  privateFile(config.adminTokenFile);
  if (config.adminSocket !== '/run/qingsi-games/admin.sock') fail('Unexpected production admin socket.');
  if (!Number.isInteger(config.candidatePort) || config.candidatePort < 1024 || config.candidatePort > 65535 || config.candidatePort === 3000) fail('Candidate port must be explicitly approved and cannot be 3000.');
  if (!Number.isInteger(config.healthTimeoutMs) || config.healthTimeoutMs < 1000 || config.healthTimeoutMs > 30000) fail('Health timeout must be 1000-30000 ms.');
  if (!Number.isInteger(config.keepReleases) || config.keepReleases < 3 || config.keepReleases > 10) fail('Keep 3-10 releases.');
  const policies = Array.isArray(config.ciPolicySha256) ? config.ciPolicySha256 : [config.ciPolicySha256];
  if (typeof config.productionEnabled !== 'boolean' || policies.length < 1 || policies.length > 10 ||
      policies.some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) || new Set(policies).size !== policies.length) {
    fail('A production enable flag and 1-10 unique approved CI policy digests are required.');
  }
  config.ciPolicySha256 = policies;
  if (config.productionEnabled) {
    const installed = fs.realpathSync(__dirname);
    if (installed !== '/opt/qingsi-games-deploy') fail('Enabled production controller must be installed outside application releases at /opt/qingsi-games-deploy.');
    if (fs.statSync(installed).uid !== 0 || fs.statSync(installed).mode & 0o022) fail('Installed controller directory must be root-owned and not writable by other users.');
    for (const name of fs.readdirSync(installed)) {
      const stat = fs.lstatSync(path.join(installed, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022) fail('Installed controller files must be root-owned and not writable by other users.');
    }
  }
  return config;
}

function parseArguments(args) {
  const commands = ['status', 'check-updates', 'prepare', 'deploy', 'rollback', 'history', 'doctor'];
  const command = args.shift();
  if (!commands.includes(command)) fail('Usage: deploy.sh {status|check-updates|prepare SHA|deploy SHA|rollback|history|doctor} [--config FILE] [--yes] [--force-active] [--resume]', 'USAGE');
  let commit;
  if (command === 'prepare' || command === 'deploy') commit = require('./fs-safety').sha(args.shift());
  const options = { configFile: '/etc/qingsi-games/deploy.json' };
  const seen = new Set();
  while (args.length) {
    const option = args.shift();
    if (seen.has(option)) fail('Duplicate option.', 'USAGE');
    seen.add(option);
    if (option === '--config') {
      if (!args[0]) fail('--config requires a file.', 'USAGE');
      options.configFile = noSymlinkPath(args.shift());
    } else if (option === '--yes' && ['deploy', 'rollback'].includes(command)) options.yes = true;
    else if (option === '--force-active' && ['deploy', 'rollback'].includes(command)) options.forceActive = true;
    else if (option === '--resume' && command === 'doctor') options.resume = true;
    else fail('Unknown or misplaced command argument.', 'USAGE');
  }
  return { command, commit, options };
}

module.exports = { loadConfig, parseArguments };
