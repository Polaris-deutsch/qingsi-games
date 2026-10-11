'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPOSITORY_URL, SERVICE, WORKFLOW } = require('./constants');
const { fail, sha, secureDir, atomicJson, readJson, noSymlinkPath, pointer, setPointer, removeTree } = require('./fs-safety');
const { digest, approvedPolicy, verifySource, fingerprint, checkLayout, sealRelease, verifyRelease } = require('./release');
const { acquireLock } = require('./process');
const { isKnownRoomSummary, unknownRoomSummary } = require('./room-status');

class DeploymentController {
  constructor(config, dependencies) {
    if (process.getuid() === 0) fail('Deployment and candidate code must run as a non-root user.');
    this.config = config;
    this.deps = dependencies;
    this.root = secureDir(config.root, { create: true });
    this.state = path.join(this.root, 'state');
    for (const name of ['releases', 'shared', 'state', 'state/candidates', 'state/prepared', 'state/healthy', 'state/logs', 'state/updates']) {
      secureDir(path.join(this.root, name), { create: true });
    }
    this.journal = path.join(this.state, 'transaction.json');
  }

  log(event) { this.deps.log?.(event); }
  checkCancelled() { if (this.deps.signal?.aborted) fail('Operation cancelled.', 'CANCELLED'); }
  release(commit) { return verifyRelease(this.root, sha(commit), this.config.ciPolicySha256); }
  current() { return pointer(this.root, 'current'); }
  previous() { return pointer(this.root, 'previous'); }
  healthyFile(commit) { return path.join(this.state, 'healthy', `${sha(commit)}.json`); }

  async locked(action, task, { recovery = false } = {}) {
    const unlock = await (this.deps.acquireLock || acquireLock)(this.state);
    try {
      this.checkCancelled();
      if (!recovery && fs.existsSync(this.journal)) fail('An unfinished transaction exists; inspect doctor/history and use rollback recovery.', 'RECOVERY_REQUIRED');
      return await task();
    } finally { await unlock(); }
  }

  record(data) {
    const file = noSymlinkPath(path.join(this.state, 'history.jsonl'));
    if (fs.existsSync(file) && fs.statSync(file).size > 256 * 1024) {
      for (let index = 4; index >= 1; index--) {
        const older = noSymlinkPath(`${file}.${index}`);
        if (fs.existsSync(older)) {
          if (index === 4) fs.unlinkSync(older); else fs.renameSync(older, `${file}.${index + 1}`);
        }
      }
      fs.renameSync(file, `${file}.1`);
    }
    const event = { schemaVersion: 1, timestamp: new Date().toISOString(), service: SERVICE, ...data };
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.log(event);
    return event;
  }

  history() {
    const events = [];
    for (const suffix of ['.4', '.3', '.2', '.1', '']) {
      const file = noSymlinkPath(path.join(this.state, `history.jsonl${suffix}`));
      if (!fs.existsSync(file)) continue;
      if (!fs.lstatSync(file).isFile() || fs.statSync(file).size > 512 * 1024) fail('History is unsafe or too large.');
      for (const line of fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)) events.push(JSON.parse(line));
    }
    return events;
  }

  sourceProof(proof, commit) {
    if (proof?.repositoryUrl !== REPOSITORY_URL || proof.commitSha !== commit || proof.inMasterHistory !== true) fail('Source repository or exact SHA is untrusted.', 'SOURCE_UNTRUSTED');
    sha(proof.masterSha);
    if (!Array.isArray(proof.files) || !proof.files.length) fail('Trusted source tree is missing.');
    return proof;
  }

  async ci(commit) {
    const result = await this.deps.verifyCi(commit);
    if (result?.headSha !== commit || result.conclusion !== 'success' || result.repository !== 'Polaris-deutsch/qingsi-games' ||
        result.workflowPath !== WORKFLOW || !Number.isSafeInteger(result.runId) || result.runId < 1 ||
        !Number.isSafeInteger(result.runAttempt) || result.runAttempt < 1) fail('CI proof is invalid for the exact SHA.', 'CI_UNVERIFIED');
    return result;
  }

  validateHealth(proof, commit, directory, port = 3000) {
    if (proof?.verified !== true || proof.commitSha !== commit || proof.directory !== directory || proof.port !== port ||
        !Number.isSafeInteger(proof.pid) || proof.pid < 2) fail('Health proof does not identify the expected release.', 'HEALTH_FAILED');
    return proof;
  }

  markHealthy(commit, proof) {
    this.validateHealth(proof, commit, path.join(this.root, 'releases', commit));
    atomicJson(this.healthyFile(commit), { schemaVersion: 1, commitSha: commit, verifiedAt: new Date().toISOString(),
      health: { pid: proof.pid, startTicks: proof.startTicks, port: proof.port, verified: true },
      manifestHash: this.release(commit).attestation.manifestHash });
  }

  healthy(commit) {
    const record = readJson(this.healthyFile(commit));
    const release = this.release(commit);
    if (record.schemaVersion !== 1 || record.commitSha !== commit || record.health?.verified !== true ||
        record.manifestHash !== release.attestation.manifestHash || !Number.isFinite(Date.parse(record.verifiedAt))) fail('Previous release has no valid healthy record.');
    return record;
  }

  async prepare(commit) {
    sha(commit);
    return this.locked('prepare', async () => {
      let candidate, moved = false, ci;
      try {
        const proof = this.sourceProof(await this.deps.source.resolve(commit), commit);
        ci = await this.ci(commit);
        const final = path.join(this.root, 'releases', commit);
        if (fs.existsSync(final)) {
          this.release(commit);
          return this.record({ action: 'prepare', deployedSha: commit, previousSha: this.current(), triggerMethod: 'explicit-sha', ci, result: 'already_prepared' });
        }
        candidate = fs.mkdtempSync(path.join(this.state, 'candidates', `${commit}.`));
        await this.deps.source.materialize(proof, candidate);
        verifySource(candidate, proof.files);
        if (!approvedPolicy(digest(fs.readFileSync(path.join(candidate, WORKFLOW))), this.config.ciPolicySha256)) fail('Candidate workflow is not the approved CI policy.', 'POLICY_CHANGED');
        this.checkCancelled();
        for (const stage of ['ci', 'check', 'audit']) {
          this.checkCancelled();
          this.log({ action: 'prepare', stage, commitSha: commit });
          await this.deps.npm(stage, candidate, commit);
        }
        const pkg = checkLayout(candidate, this.config.ciPolicySha256);
        verifySource(candidate, proof.files);
        fingerprint(candidate); // Reject escaping dependency links before executing the server.
        atomicJson(path.join(candidate, 'release-info.json'), { schemaVersion: 1, commitSha: commit,
          commitSubject: proof.subject, packageVersion: pkg.version, preparedAt: new Date().toISOString() }, 0o444);
        const health = this.validateHealth(await this.deps.smoke(candidate, commit), commit, candidate, this.config.candidatePort);
        verifySource(candidate, proof.files);
        this.checkCancelled();
        const sealed = sealRelease(candidate, { commitSha: commit, repositoryUrl: REPOSITORY_URL, masterSha: proof.masterSha,
          commitSubject: proof.subject, packageVersion: pkg.version, preparedAt: new Date().toISOString(), ci,
          checks: { syntax: 'success', audit: 'success', smoke: 'success' } });
        // Moving a directory between parents also updates its '..' entry.
        // Keep only its root writable for this unpublished atomic move.
        fs.chmodSync(candidate, 0o700);
        fs.renameSync(candidate, final); moved = true;
        fs.chmodSync(final, 0o555);
        atomicJson(path.join(this.state, 'prepared', `${commit}.json`), { schemaVersion: 1, commitSha: commit, ...sealed });
        this.release(commit);
        return this.record({ action: 'prepare', deployedSha: commit, previousSha: this.current(), triggerMethod: 'explicit-sha', ci,
          result: 'prepared', healthCheck: { success: true, candidatePort: health.port } });
      } catch (error) {
        this.record({ action: 'prepare', deployedSha: commit, triggerMethod: 'explicit-sha', ci, result: 'failed', reason: error.code || 'PREPARE_FAILED', candidatePid: error.candidatePid });
        if (candidate && fs.existsSync(candidate)) removeTree(path.join(this.state, 'candidates'), candidate);
        if (moved) {
          const final = path.join(this.root, 'releases', commit);
          const protectedPaths = [this.current(), this.previous()].filter(Boolean).map(value => path.join(this.root, 'releases', value));
          removeTree(path.join(this.root, 'releases'), final, protectedPaths);
          const attestation = noSymlinkPath(path.join(this.state, 'prepared', `${commit}.json`));
          if (fs.existsSync(attestation)) fs.unlinkSync(attestation);
        }
        throw error;
      }
    });
  }

  migration() {
    if (this.config.productionEnabled !== true) fail('Production deployment is disabled; phase-four migration has not been authorized.', 'NOT_AUTHORIZED');
    const record = readJson(path.join(this.state, 'migration.json'));
    if (record.schemaVersion !== 1 || record.legacyPath !== '/home/ubuntu/qingsi-games' || record.filesystemReviewed !== true ||
        record.sharedContainsExecutableCode !== false || record.systemdMigrationApproved !== true ||
        !Number.isFinite(Date.parse(record.reviewedAt))) fail('Real-host filesystem review and systemd migration approval are required.', 'MIGRATION_REQUIRED');
  }

  async approve(target, ci, options, current, snapshot) {
    this.log({ action: 'approval', currentSha: current, targetSha: target.manifest.commitSha,
      commitSubject: target.manifest.commitSubject, ci, blockingRooms: snapshot?.blockingRooms ?? 'unknown', restartRequired: true });
    if (!options.yes && (!options.confirm || await options.confirm(`Type the full target SHA to authorize a service restart: ${target.manifest.commitSha}`) !== target.manifest.commitSha)) {
      fail('Deployment was not explicitly approved.', 'NOT_AUTHORIZED');
    }
  }

  async drain(current, target, options) {
    let snapshot;
    try { snapshot = await this.deps.service.drain(true, current); } catch { snapshot = null; }
    if (!isKnownRoomSummary(snapshot) || snapshot.draining !== true || snapshot.blockingRooms > 0) {
      this.log({ action: 'room-warning', message: '可能终止当前对局，重启将断开当前玩家连接。Active rooms exist or their status is unknown.', blockingRooms: snapshot?.blockingRooms ?? 'unknown' });
      const phrase = `TERMINATE ROOMS ${target}`;
      if (!options.forceActive || !options.confirm || await options.confirm(`可能终止当前对局，重启将断开当前玩家连接。Type ${phrase} to explicitly accept room loss.`) !== phrase) {
        fail('Active or unknown rooms require separate interactive authorization; --yes is insufficient.', 'ROOMS_BLOCKED');
      }
    }
  }

  restorePrevious(commit) {
    if (commit) setPointer(this.root, 'previous', commit);
    else {
      const file = path.join(this.root, 'previous');
      try { if (!fs.lstatSync(file).isSymbolicLink()) fail('Unsafe previous pointer.'); fs.unlinkSync(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async activate({ action, commit, current, oldPrevious, currentHealthy, ci, options }) {
    let transitionStarted = false, drainAttempted = false;
    const triggerMethod = options.yes ? 'explicit-sha --yes' : 'interactive';
    try {
      atomicJson(this.journal, { schemaVersion: 1, action, targetSha: commit, oldSha: current,
        oldPreviousSha: oldPrevious, fallbackVerified: currentHealthy, phase: 'approved', timestamp: new Date().toISOString() });
      drainAttempted = true;
      await this.drain(current, commit, options);
      this.checkCancelled();
      // The separate room-loss prompt can outlast a CI rerun. Check again
      // after all human approval, while admission remains paused.
      if (action === 'deploy') ci = await this.ci(commit);
      transitionStarted = true;
      if (currentHealthy) setPointer(this.root, 'previous', current);
      else this.restorePrevious(oldPrevious === commit ? null : oldPrevious);
      setPointer(this.root, 'current', commit);
      atomicJson(this.journal, { schemaVersion: 1, action, targetSha: commit, oldSha: current, oldPreviousSha: oldPrevious,
        fallbackVerified: currentHealthy, phase: 'switched', timestamp: new Date().toISOString() });
      await this.deps.service.restart();
      const health = this.validateHealth(await this.deps.service.health(commit, path.join(this.root, 'releases', commit), { signal: this.deps.signal }), commit, path.join(this.root, 'releases', commit));
      await this.deps.service.drain(false, commit);
      this.markHealthy(commit, health);
      const event = this.record({ action, deployedSha: commit, previousSha: current, triggerMethod, ci, result: 'success',
        rollbackReason: action === 'rollback' ? 'operator-requested previous healthy release' : null,
        healthCheck: { success: true, pid: health.pid, port: health.port } });
      fs.unlinkSync(this.journal);
      await this.cleanupUnlocked();
      return event;
    } catch (error) {
      if (!transitionStarted) {
        if (drainAttempted) {
          try { await this.deps.service.drain(false, current); }
          catch { this.log({ action: 'warning', message: 'Admission could not be resumed; transaction retained for rollback recovery.' }); throw error; }
        }
        if (fs.existsSync(this.journal)) fs.unlinkSync(this.journal);
        this.record({ action, deployedSha: commit, previousSha: current, triggerMethod, ci, result: 'rejected', reason: error.code || 'REJECTED' });
        throw error;
      }
      try {
        if (!currentHealthy) fail('No healthy fallback exists for this failed rollback.');
        this.healthy(current);
        setPointer(this.root, 'current', current);
        this.restorePrevious(oldPrevious);
        await this.deps.service.restart();
        const health = this.validateHealth(await this.deps.service.health(current, path.join(this.root, 'releases', current)), current, path.join(this.root, 'releases', current));
        await this.deps.service.drain(false, current);
        this.markHealthy(current, health);
        this.record({ action, deployedSha: commit, previousSha: current, triggerMethod, ci, result: 'rolled_back',
          rollbackReason: error.code || 'POST_SWITCH_FAILURE', healthCheck: { success: true, restoredSha: current, pid: health.pid } });
        fs.unlinkSync(this.journal);
      } catch (rollbackError) {
        atomicJson(this.journal, { schemaVersion: 1, action, targetSha: commit, oldSha: current, oldPreviousSha: oldPrevious,
          fallbackVerified: currentHealthy, phase: 'rollback_failed', timestamp: new Date().toISOString() });
        this.record({ action, deployedSha: commit, previousSha: current, triggerMethod, ci, result: 'rollback_failed',
          rollbackReason: error.code || 'POST_SWITCH_FAILURE', healthCheck: { success: false }, recoveryError: rollbackError.code || 'ROLLBACK_FAILED' });
        fail('HIGH SEVERITY: deployment and rollback health verification failed. Inspect retained transaction and logs.', 'ROLLBACK_FAILED');
      }
      if (action === 'rollback') fail('HIGH SEVERITY: requested rollback failed; the original current release was restored and verified. Inspect rollback history.', 'ROLLBACK_FAILED');
      fail('Requested release failed; the previous healthy release was restored and verified.', 'DEPLOYMENT_ROLLED_BACK');
    }
  }

  async deploy(commit, options = {}) {
    sha(commit);
    return this.locked('deploy', async () => {
      this.migration();
      const target = this.release(commit);
      this.sourceProof(await this.deps.source.resolve(commit), commit);
      let ci = await this.ci(commit);
      await this.deps.service.validate();
      const current = this.current();
      if (!current) fail('No immutable current release exists; initial migration is required.', 'MIGRATION_REQUIRED');
      this.release(current);
      const currentHealth = this.validateHealth(await this.deps.service.health(current, path.join(this.root, 'releases', current), { signal: this.deps.signal }), current, path.join(this.root, 'releases', current));
      this.markHealthy(current, currentHealth);
      if (current === commit) return this.record({ action: 'deploy', deployedSha: commit, previousSha: this.previous(), triggerMethod: '--yes/no-op', ci, result: 'unchanged', healthCheck: { success: true } });
      await this.deps.npm('audit', target.directory, commit);
      this.validateHealth(await this.deps.smoke(target.directory, commit), commit, target.directory, this.config.candidatePort);
      this.release(commit);
      let rooms; try { rooms = await this.deps.service.rooms(current); } catch { rooms = null; }
      await this.approve(target, ci, options, current, rooms);
      this.sourceProof(await this.deps.source.resolve(commit), commit);
      ci = await this.ci(commit); // A pending rerun after a long approval wait revokes eligibility.
      this.checkCancelled();
      const oldPrevious = this.previous();
      if (oldPrevious) this.healthy(oldPrevious);
      return this.activate({ action: 'deploy', commit, current, oldPrevious, currentHealthy: true, ci, options });
    });
  }

  async rollback(options = {}) {
    return this.locked('rollback', async () => {
      this.migration();
      await this.deps.service.validate();
      const recovery = fs.existsSync(this.journal) ? readJson(this.journal) : null;
      if (recovery && (recovery.schemaVersion !== 1 || recovery.fallbackVerified !== true)) fail('Transaction has no verified rollback target; operator recovery is required.', 'RECOVERY_REQUIRED');
      const current = this.current();
      const commit = recovery ? sha(recovery.oldSha) : this.previous();
      if (!current || !commit) fail('No previous verified healthy release is available.');
      this.healthy(commit);
      const target = this.release(commit);
      if (current === commit) {
        const health = this.validateHealth(await this.deps.service.health(commit, target.directory), commit, target.directory);
        await this.deps.service.drain(false, commit);
        this.markHealthy(commit, health);
        if (recovery) { this.restorePrevious(recovery.oldPreviousSha); fs.unlinkSync(this.journal); }
        return this.record({ action: 'rollback', deployedSha: commit, previousSha: this.previous(), triggerMethod: 'recovery', ci: target.manifest.ci,
          result: 'already_restored', healthCheck: { success: true }, rollbackReason: 'verified existing current release' });
      }
      let currentHealthy = false;
      try { this.healthy(current); await this.deps.service.health(current, path.join(this.root, 'releases', current)); currentHealthy = true; } catch { /* target remains the only trusted fallback */ }
      let rooms; try { rooms = await this.deps.service.rooms(current); } catch { rooms = null; }
      await this.approve(target, target.manifest.ci, options, current, rooms);
      return this.activate({ action: 'rollback', commit, current, oldPrevious: recovery ? recovery.oldPreviousSha || null : this.previous(), currentHealthy,
        ci: target.manifest.ci, options });
    }, { recovery: true });
  }

  async checkUpdates() { return new (require('./updates').UpdateChecker)(this).check(); }

  async status() {
    const runtime = await this.runtimeStatus();
    return { ...runtime, ...require('./updates').describeUpdates(this, runtime) };
  }

  async runtimeStatus() {
    const current = this.current(), previous = this.previous();
    const result = { currentSha: current, previousSha: previous, productionEnabled: this.config.productionEnabled,
      transaction: fs.existsSync(this.journal) ? readJson(this.journal) : null, healthy: false, rooms: unknownRoomSummary() };
    if (current && this.config.productionEnabled) {
      try {
        const release = this.release(current);
        const health = this.validateHealth(await this.deps.service.health(current, release.directory, { signal: this.deps.signal }), current, release.directory);
        result.healthy = true; result.mainPid = health.pid; result.rooms = await this.deps.service.rooms(current);
      } catch (error) { result.error = error.code || 'UNVERIFIED'; }
    }
    result.readyForPlayers = result.healthy && !result.transaction && result.rooms?.draining === false;
    return result;
  }

  async doctor({ resume = false } = {}) {
    const work = async () => {
      this.migration();
      if (fs.existsSync(this.journal)) fail('An unfinished transaction requires rollback recovery.', 'RECOVERY_REQUIRED');
      await this.deps.service.validate();
      const current = this.current();
      if (!current) fail('Initial immutable current release is missing.', 'MIGRATION_REQUIRED');
      const release = this.release(current);
      const health = this.validateHealth(await this.deps.service.health(current, release.directory), current, release.directory);
      if (resume) { await this.ci(current); await this.deps.service.drain(false, current); this.markHealthy(current, health); }
      return { ok: true, currentSha: current, mainPid: health.pid, admissionResumed: resume, rooms: await this.deps.service.rooms(current) };
    };
    return resume ? this.locked('doctor-resume', work) : work();
  }

  async cleanupUnlocked() {
    try {
      const running = await this.deps.service.runningDirectories();
      const protectedPaths = new Set([...running, ...[this.current(), this.previous()].filter(Boolean).map(commit => path.join(this.root, 'releases', commit))]);
      const releases = fs.readdirSync(path.join(this.root, 'releases')).filter(name => /^[a-f0-9]{40}$/.test(name)).map(commit => {
        const release = this.release(commit);
        let healthy; try { healthy = this.healthy(commit); } catch { healthy = null; }
        return { commit, directory: release.directory, time: healthy?.verifiedAt || release.manifest.preparedAt, healthy: !!healthy };
      }).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      const keep = this.config.keepReleases || 5;
      for (const kind of [true, false]) {
        const matching = releases.filter(release => release.healthy === kind);
        for (const release of matching.slice(0, keep)) protectedPaths.add(release.directory);
      }
      for (const release of releases) if (!protectedPaths.has(release.directory)) {
        removeTree(path.join(this.root, 'releases'), release.directory, [...protectedPaths]);
        for (const record of [path.join(this.state, 'prepared', `${release.commit}.json`), this.healthyFile(release.commit)]) {
          noSymlinkPath(record);
          if (fs.existsSync(record)) fs.unlinkSync(record);
        }
        this.log({ action: 'cleanup', removedSha: release.commit });
      }
      const logs = fs.readdirSync(path.join(this.state, 'logs')).filter(name => /^[a-f0-9]{40}\.(prepare|smoke)\.log$/.test(name))
        .map(name => ({ name, mtime: fs.lstatSync(path.join(this.state, 'logs', name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime);
      for (const log of logs.slice(20)) {
        const commit = log.name.slice(0, 40);
        if (!protectedPaths.has(path.join(this.root, 'releases', commit))) fs.unlinkSync(noSymlinkPath(path.join(this.state, 'logs', log.name)));
      }
    } catch (error) { this.log({ action: 'cleanup-skipped', reason: error.code || 'UNVERIFIED_PATH_OR_PROCESS' }); }
  }
}

module.exports = { DeploymentController };
