#!/usr/bin/env node
'use strict';

function requireSuccessfulChecks(needs) {
  if (!needs || typeof needs !== 'object' || Array.isArray(needs)) {
    throw new Error('Missing or invalid CI dependency results.');
  }
  for (const name of ['test', 'audit']) {
    if (!Object.hasOwn(needs, name)) throw new Error(`Required CI job is missing: ${name}`);
  }
  for (const [name, job] of Object.entries(needs)) {
    if (job?.result !== 'success') {
      throw new Error(`Required CI job ${name} did not pass: ${job?.result || 'missing result'}`);
    }
  }
}

if (require.main === module) {
  try {
    requireSuccessfulChecks(JSON.parse(process.env.NEEDS_RESULTS || 'null'));
    console.log('All required CI jobs passed for this workflow run.');
  } catch (error) {
    console.error(`Deployment gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { requireSuccessfulChecks };
