'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { DeploymentController } = require('../../scripts/deploy/controller');
const { REPOSITORY, REPOSITORY_URL, WORKFLOW } = require('../../scripts/deploy/constants');
const { digest } = require('../../scripts/deploy/release');
const { atomicJson, pointer, setPointer, removeTree } = require('../../scripts/deploy/fs-safety');

const SHA = Array.from({ length: 12 }, (_, index) => (index + 1).toString(16).repeat(40));

function ciProof(commit) {
  return { repository: REPOSITORY, workflowPath: WORKFLOW, workflowId: 1, headSha: commit,
    runId: 100, runAttempt: 1, conclusion: 'success', verifiedAt: new Date().toISOString(), url: `https://github.com/${REPOSITORY}/actions/runs/100` };
}

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-'));
  t.after(() => removeTree(os.tmpdir(), root));
  const workflow = fs.readFileSync(path.join(__dirname, '../../.github/workflows/ci.yml'), 'utf8');
  const dependencies = Object.fromEntries(['compression', 'express', 'qrcode', 'ws'].map(name => [name, '^1.0.0']));
  const files = {
    'server.js': 'module.exports = {};\n', 'startup-port.js': '// fixture\n', 'public-origin.js': '// fixture\n', 'internet-security.js': '// fixture\n',
    'package.json': JSON.stringify({ version: '1.5.0', dependencies, scripts: { check: 'node scripts/check-syntax.js' } }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { version: '1.5.0', dependencies } } }),
    'scripts/check-syntax.js': '// fixture\n', 'scripts/deploy/runtime.js': '// fixture\n', 'scripts/deploy/fs-safety.js': '// fixture\n', 'scripts/deploy/room-status.js': '// fixture\n',
    'games/fixture.js': '// fixture\n', 'bots/fixture.js': '// fixture\n', 'public/index.html': '<html>fixture</html>\n', 'lang/fixture.js': '// fixture\n',
    [WORKFLOW]: workflow,
  };
  const sourceFiles = Object.entries(files).map(([name, value]) => ({ path: name, mode: '100644',
    blob: crypto.createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex') }));
  const config = { root, productionEnabled: true, candidatePort: 3101, ciPolicySha256: digest(workflow), keepReleases: 3,
    healthTimeoutMs: 1500, nodePath: process.execPath };
  const state = { npm: [], events: [], restarts: 0, running: null, rooms: 0, draining: false,
    failHealth: new Set(), extraRunning: new Set(), pid: 12000 };
  const error = (message, code) => Object.assign(new Error(message), { code });
  function health(commit, directory, port = 3000) {
    if (state.failHealth.has(commit) || state.failAllAfterRestart && state.restarts > 0) throw error('Controlled startup timeout.', 'STARTUP_TIMEOUT');
    return { verified: true, commitSha: state.wrongHealthSha === commit ? SHA[10] : commit, directory, port, pid: state.pid++, startTicks: '100' };
  }
  const snapshot = commit => ({ schemaVersion: 1, releaseSha: commit, ready: true, host: '127.0.0.1', port: 3000,
    draining: state.draining, roomStatus: state.rooms ? 'ACTIVE' : 'EMPTY', totalRooms: state.rooms, waitingRooms: 0,
    activeGames: state.rooms, completedRooms: 0, expiredRooms: 0, unknownRooms: 0,
    blockingRooms: state.rooms, playingRooms: state.rooms, connectedPlayers: state.rooms, reconnectingPlayers: 0,
    ...state.roomSnapshot });
  const deps = {
    log: value => state.events.push(value),
    async verifyCi(commit) { if (state.ciError) throw error('Controlled CI verification failure.', state.ciError); return { ...ciProof(commit), ...state.ciOverride }; },
    source: {
      async resolve(commit) { return { repositoryUrl: REPOSITORY_URL, commitSha: commit, masterSha: SHA[11], inMasterHistory: true,
        subject: `Fixture ${commit.slice(0, 7)}`, files: sourceFiles, ...state.sourceOverride }; },
      async materialize(proof, directory) {
        for (const [name, content] of Object.entries(files)) {
          const target = path.join(directory, name);
          fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content);
        }
      },
    },
    async npm(stage, directory, commit) {
      state.npm.push({ stage, directory, commit });
      if (state.failNpm === stage) throw error(`Controlled npm ${stage} failure.`, 'COMMAND_FAILED');
      if (stage === 'ci') for (const name of Object.keys(dependencies)) {
        const dir = path.join(directory, 'node_modules', name); fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
      }
      if (state.mutateSource && stage === 'check') fs.appendFileSync(path.join(directory, 'server.js'), '// changed\n');
      if (state.extraSource && stage === 'check') fs.writeFileSync(path.join(directory, 'games', 'unexpected.js'), '// unexpected source\n');
      if (state.externalModuleLink && stage === 'audit') fs.symlinkSync(os.tmpdir(), path.join(directory, 'node_modules', 'escape'));
    },
    async smoke(directory, commit) { if (state.failSmoke) throw error('Controlled candidate health failure.', 'HEALTH_FAILED'); return health(commit, directory, config.candidatePort); },
    service: {
      async validate() { if (state.invalidSystemd) throw error('Controlled unreviewed systemd unit.', 'SYSTEMD_UNVERIFIED'); },
      async restart() { state.restarts++; state.running = pointer(root, 'current'); if (state.failRestart) throw error('Controlled restart failure.', 'COMMAND_FAILED'); },
      async health(commit, directory) { return health(commit, directory); },
      async rooms(commit) { if (state.roomsUnknown) throw error('Controlled unavailable admin socket.', 'ROOMS_UNKNOWN'); return snapshot(commit); },
      async drain(enabled, commit) { if (state.roomsUnknown) throw error('Controlled unavailable admin socket.', 'ROOMS_UNKNOWN'); state.draining = enabled; return snapshot(commit); },
      async runningDirectories() { return new Set([...state.extraRunning, ...(state.running ? [path.join(root, 'releases', state.running)] : [])]); },
    },
  };
  const controller = new DeploymentController(config, deps);
  atomicJson(path.join(root, 'state', 'migration.json'), { schemaVersion: 1, legacyPath: '/home/ubuntu/qingsi-games',
    filesystemReviewed: true, sharedContainsExecutableCode: false, systemdMigrationApproved: true, reviewedAt: new Date().toISOString() });
  async function seed(commit = SHA[0]) {
    await controller.prepare(commit);
    setPointer(root, 'current', commit); state.running = commit;
    controller.markHealthy(commit, health(commit, path.join(root, 'releases', commit)));
  }
  return { root, config, state, deps, controller, seed, health };
}

module.exports = { sandbox, SHA, ciProof };
