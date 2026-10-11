#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function readReleaseInfo({ cwd = path.resolve(__dirname, '..'), env = process.env } = {}) {
  const git = (args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const commitSha = git(['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error('Expected a full GitHub commit SHA.');
  if (env.GITHUB_SHA && env.GITHUB_SHA !== commitSha) {
    throw new Error(`Checked-out commit ${commitSha} does not match GITHUB_SHA ${env.GITHUB_SHA}.`);
  }
  const commitSubject = git(['show', '--no-patch', '--format=%s', commitSha]);
  let branch;
  try {
    branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch (error) {
    if (error.status !== 1) throw error;
    branch = null; // Detached HEAD, including GitHub's PR merge checkout.
  }
  const { version: packageVersion } = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  if (typeof packageVersion !== 'string' || !packageVersion) throw new Error('Missing package.json version.');
  return {
    schemaVersion: 1,
    commitSha,
    commitSubject,
    branch,
    packageVersion,
    checkedAt: new Date().toISOString(),
    ...(env.GITHUB_ACTIONS === 'true' ? {
      ci: {
        repository: env.GITHUB_REPOSITORY,
        event: env.GITHUB_EVENT_NAME,
        ref: env.GITHUB_REF,
        runId: env.GITHUB_RUN_ID,
        runAttempt: env.GITHUB_RUN_ATTEMPT,
      },
    } : {}),
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(readReleaseInfo(), null, 2));
  } catch (error) {
    console.error(`Cannot identify release: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { readReleaseInfo };
