'use strict';

module.exports = Object.freeze({
  REPOSITORY: 'Polaris-deutsch/qingsi-games',
  REPOSITORY_URL: 'https://github.com/Polaris-deutsch/qingsi-games',
  WORKFLOW: '.github/workflows/ci.yml',
  SERVICE: 'qingsi-games.service',
  PUBLIC_URL: 'https://games.qingsiphotograph.com',
  REQUIRED_JOBS: [
    'Checks (Node.js 18)', 'Checks (Node.js 20)', 'Checks (Node.js 22)', 'Checks (Node.js 24)',
    'Security audit (Node.js 24)', 'Deployment gate',
  ],
});
