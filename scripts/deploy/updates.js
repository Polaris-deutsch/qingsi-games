'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPOSITORY, WORKFLOW } = require('./constants');
const { acquireLock } = require('./process');
const { sha, fail, atomicJson, readJson, noSymlinkPath } = require('./fs-safety');
const { isKnownRoomSummary } = require('./room-status');

const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const STATES = ['up-to-date', 'update-available', 'ci-pending', 'ci-failed', 'check-failed'];
const CI_STATES = ['passed', 'pending', 'failed', 'unknown', 'not-checked'];
const stateFile = controller => path.join(controller.state, 'updates', 'status.json');
const validSha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

function validProof(proof, commit) {
  return proof?.repository === REPOSITORY && proof.workflowPath === WORKFLOW && proof.headSha === commit &&
    proof.conclusion === 'success' && Number.isSafeInteger(proof.runId) && proof.runId > 0 &&
    Number.isSafeInteger(proof.runAttempt) && proof.runAttempt > 0 &&
    proof.url === `https://github.com/${REPOSITORY}/actions/runs/${proof.runId}` && Number.isFinite(Date.parse(proof.verifiedAt));
}

function readState(controller) {
  const file = noSymlinkPath(stateFile(controller));
  if (!fs.existsSync(file)) return { value: null };
  try {
    if (fs.statSync(file).size > 65536) fail('Update state is too large.');
    const value = readJson(file);
    if (value.schemaVersion !== 1 || value.repository !== REPOSITORY || value.branch !== 'master' || !STATES.includes(value.status) ||
        !CI_STATES.includes(value.ci?.state) || !Number.isFinite(Date.parse(value.checkedAt)) || Date.parse(value.checkedAt) > Date.now() + 60000 ||
        !(value.currentSha === null || validSha(value.currentSha)) || !(value.remoteSha === null || validSha(value.remoteSha)) ||
        value.automaticDeploy !== false || value.persisted !== true || !Array.isArray(value.recentChecks) || value.recentChecks.length > 24 ||
        typeof value.currentVerified !== 'boolean' || !['EMPTY', 'ACTIVE', 'UNKNOWN'].includes(value.roomStatus) ||
        !(value.blockingRooms === null || Number.isSafeInteger(value.blockingRooms) && value.blockingRooms >= 0) ||
        value.recentChecks.some(event => !event || !STATES.includes(event.status) || !Number.isFinite(Date.parse(event.checkedAt))) ||
        value.status === 'ci-pending' && (value.ci.state !== 'pending' || value.ci.headSha !== value.remoteSha) ||
        value.status === 'ci-failed' && (value.ci.state !== 'failed' || value.ci.headSha !== value.remoteSha) ||
        value.status === 'update-available' && (value.ci.state !== 'passed' || value.currentVerified !== true || value.currentSha === value.remoteSha) ||
        value.status === 'up-to-date' && (value.currentVerified !== true || !value.currentSha || value.currentSha !== value.remoteSha) ||
        value.ci.state === 'passed' && (!validSha(value.remoteSha) || !validProof(value.ci.proof, value.remoteSha))) {
      fail('Invalid stored update state.');
    }
    return { value };
  } catch { return { value: null, error: 'INVALID_UPDATE_STATE' }; }
}

function roomState(runtime) {
  const count = runtime.rooms?.blockingRooms;
  return isKnownRoomSummary(runtime.rooms) ? { roomStatus: runtime.rooms.roomStatus, blockingRooms: count }
    : { roomStatus: 'UNKNOWN', blockingRooms: null };
}

function candidateFor(controller, commit) {
  if (!validSha(commit)) return { commitSha: null, state: 'UNKNOWN' };
  if (!fs.existsSync(path.join(controller.root, 'releases', commit))) return { commitSha: commit, state: 'MISSING' };
  try {
    const release = controller.release(commit);
    return { commitSha: commit, state: 'PREPARED', preparedAt: release.manifest.preparedAt };
  } catch { return { commitSha: commit, state: 'INVALID' }; }
}

function latestCandidate(controller, runtime) {
  try {
    const entries = fs.readdirSync(path.join(controller.state, 'prepared')).filter(validShaFile => /^[a-f0-9]{40}\.json$/.test(validShaFile));
    const candidates = [];
    for (const entry of entries) {
      const commit = entry.slice(0, 40);
      if (commit === runtime.currentSha || commit === runtime.previousSha || fs.existsSync(controller.healthyFile(commit))) continue;
      const manifest = readJson(path.join(controller.root, 'releases', commit, '.qingsi-release.json'));
      if (!Number.isFinite(Date.parse(manifest.preparedAt))) fail('Candidate has no valid preparation time.');
      candidates.push({ commit, time: Date.parse(manifest.preparedAt) });
    }
    candidates.sort((a, b) => b.time - a.time || a.commit.localeCompare(b.commit));
    return candidates.length ? candidateFor(controller, candidates[0].commit) : { commitSha: null, state: 'NONE' };
  } catch { return { commitSha: null, state: 'UNKNOWN' }; }
}

function releaseStatus(update, runtime, candidate, stale = false) {
  if (stale) return 'CHECK_REQUIRED';
  if (!update) return 'UNKNOWN';
  if (update.status === 'ci-pending') return update.ci.reason === 'NO_CI_RUN' ? 'NO_CI_RUN' : 'PENDING';
  if (update.status !== 'update-available') return ({ 'up-to-date': 'UP_TO_DATE', 'ci-failed': 'REJECTED', 'check-failed': 'CHECK_FAILED' })[update.status];
  if (!runtime.healthy || !runtime.productionEnabled) return 'RUNNING_VERSION_UNKNOWN';
  if (runtime.transaction) return 'RECOVERY_REQUIRED';
  if (candidate.state !== 'PREPARED') return candidate.state === 'INVALID' ? 'INVALID_CANDIDATE' : 'NEEDS_PREPARE';
  const rooms = roomState(runtime);
  if (rooms.roomStatus === 'UNKNOWN') return 'ROOMS_UNKNOWN';
  if (rooms.roomStatus === 'ACTIVE') return 'WAITING_FOR_ROOMS';
  if (runtime.rooms.draining !== false) return 'ADMISSION_PAUSED';
  return 'READY'; // Informational only. deploy never reads this cache as approval.
}

function recentResult(controller, action) {
  try {
    const event = controller.history().filter(value => action === 'deploy' ? ['deploy', 'rollback'].includes(value.action) : value.action === 'prepare').at(-1);
    return event ? { action: event.action, commitSha: event.deployedSha, previousSha: event.previousSha ?? null, timestamp: event.timestamp,
      result: event.result, reason: event.rollbackReason || event.reason || null } : null;
  } catch { return { result: 'UNKNOWN' }; }
}

function describeUpdates(controller, runtime) {
  let stored;
  try { stored = readState(controller); } catch { stored = { value: null, error: 'INVALID_UPDATE_STATE' }; }
  const value = stored.value;
  const matchesCurrent = !!value && value.currentSha === runtime.currentSha && runtime.healthy === true;
  const stale = !!value && (Date.now() - Date.parse(value.checkedAt) > MAX_AGE_MS || !matchesCurrent);
  const candidate = candidateFor(controller, value?.remoteSha);
  return {
    updates: value ? { status: value.status, checkedAt: value.checkedAt, remoteSha: value.remoteSha, ci: value.ci,
      cached: true, stale, matchesCurrent, automaticDeploy: false, candidate, error: value.error || null }
      : { status: stored.error ? 'check-failed' : 'not-checked', checkedAt: null, remoteSha: null, ci: { state: 'unknown' },
        stale: true, matchesCurrent: false, automaticDeploy: false, candidate, error: stored.error || null },
    releaseStatus: stored.error ? 'CHECK_FAILED' : releaseStatus(value, runtime, candidate, stale),
    latestCandidate: latestCandidate(controller, runtime), latestDeployment: recentResult(controller, 'deploy'),
    latestPreparation: recentResult(controller, 'prepare'), ...roomState(runtime),
  };
}

function safeError(error) {
  const allowed = ['LOCKED', 'CANCELLED', 'SOURCE_UNTRUSTED', 'CI_NOT_PASSED', 'CI_UNVERIFIED', 'NO_CI_RUN', 'REMOTE_CHANGED',
    'CURRENT_UNVERIFIED', 'CURRENT_CHANGED', 'RECOVERY_REQUIRED', 'ENOSPC', 'EDQUOT', 'EACCES', 'EROFS',
    'GITHUB_TIMEOUT', 'GITHUB_RATE_LIMIT', 'GITHUB_NETWORK_OR_RESPONSE'];
  const code = error.failureReason || error.code;
  return allowed.includes(code) || /^GITHUB_HTTP_\d{3}$/.test(code || '') ? code : 'UPDATE_CHECK_FAILED';
}

class UpdateChecker {
  constructor(controller) { this.controller = controller; this.deps = controller.deps; }

  cancelled() { if (this.deps.signal?.aborted) fail('Update check cancelled.', 'CANCELLED'); }

  async check() {
    const controller = this.controller;
    let unlock, prior, runtime = {}, notify = false;
    const result = { schemaVersion: 1, repository: REPOSITORY, branch: 'master', status: 'check-failed', checkedAt: null,
      currentSha: null, currentVerified: false, remoteSha: null, ci: { state: 'unknown' },
      roomStatus: 'UNKNOWN', blockingRooms: null, runningStatus: 'UNKNOWN', automaticDeploy: false, persisted: false };
    try {
      unlock = await (this.deps.acquireLock || acquireLock)(controller.state);
      try { prior = readState(controller).value; } catch { /* a new check may replace invalid cached state */ }
      this.cancelled();
      runtime = await controller.runtimeStatus();
      result.currentSha = runtime.currentSha;
      result.currentVerified = runtime.healthy === true;
      result.runningStatus = runtime.healthy ? 'HEALTHY' : 'UNKNOWN';
      Object.assign(result, roomState(runtime));
      if (runtime.transaction) fail('Interrupted deployment requires recovery.', 'RECOVERY_REQUIRED');
      const remote = await this.deps.masterHead();
      if (remote?.repository !== REPOSITORY || remote.branch !== 'master') fail('Unapproved update source.', 'SOURCE_UNTRUSTED');
      result.remoteSha = sha(remote.commitSha);
      this.cancelled();
      if (result.currentVerified && result.remoteSha === result.currentSha) {
        result.status = 'up-to-date'; result.result = 'no-update'; result.ci = { state: 'not-checked', reason: 'same-running-sha' };
      } else {
        try {
          const proof = await controller.ci(result.remoteSha);
          if (!validProof(proof, result.remoteSha)) fail('CI proof is incomplete.', 'CI_UNVERIFIED');
          result.ci = { state: 'passed', headSha: result.remoteSha, proof };
          result.status = 'update-available';
        } catch (error) {
          if (!['pending', 'failed'].includes(error.ciState)) throw error;
          result.ci = { state: error.ciState, headSha: result.remoteSha,
            reason: safeError(error),
            status: error.ciStatus ?? null, conclusion: error.ciConclusion ?? null, runId: error.runId ?? null, runAttempt: error.runAttempt ?? null };
          result.status = error.ciState === 'pending' ? 'ci-pending' : 'ci-failed';
        }
        // Do not silently follow a new master head during an in-flight check.
        const after = await this.deps.masterHead();
        if (after?.repository !== REPOSITORY || after.branch !== 'master' || after.commitSha !== result.remoteSha) fail('Master changed during verification.', 'REMOTE_CHANGED');
      }
      this.cancelled();
      if (!result.currentVerified) fail('The current running release could not be verified.', 'CURRENT_UNVERIFIED');
      if (controller.current() !== result.currentSha) fail('Current changed during the update check.', 'CURRENT_CHANGED');
    } catch (error) {
      result.status = 'check-failed'; result.error = safeError(error);
    }
    result.checkedAt = new Date().toISOString();
    result.result = result.status === 'up-to-date' ? 'no-update' : result.status;
    result.candidate = candidateFor(controller, result.remoteSha);
    result.releaseStatus = releaseStatus(result, runtime, result.candidate);
    try {
      if (unlock) {
        const recent = (prior?.recentChecks || []).slice(-23).map(event => ({ checkedAt: event.checkedAt, status: event.status,
          currentSha: event.currentSha, remoteSha: event.remoteSha, error: event.error || null }));
        recent.push({ checkedAt: result.checkedAt, status: result.status, currentSha: result.currentSha, remoteSha: result.remoteSha, error: result.error || null });
        atomicJson(stateFile(controller), { ...result, persisted: true, recentChecks: recent });
        result.persisted = true;
        notify = result.status === 'update-available' && (prior?.status !== result.status || prior?.remoteSha !== result.remoteSha);
      }
    } catch (error) {
      result.status = 'check-failed'; result.result = 'check-failed'; result.error = safeError(error); result.releaseStatus = 'CHECK_FAILED';
    } finally {
      if (unlock) {
        try { await unlock(); } catch { result.status = 'check-failed'; result.result = 'check-failed'; result.error = 'LOCKED'; result.releaseStatus = 'CHECK_FAILED'; }
      }
    }
    controller.log({ action: 'update-check', ...result });
    if (notify && result.status === 'update-available' && this.deps.notifyUpdate) await this.notify(result);
    return result;
  }

  async notify(result) {
    const abort = new AbortController();
    let timer;
    try {
      await Promise.race([Promise.resolve().then(() => this.deps.notifyUpdate(structuredClone(result), { signal: abort.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error('Notifier timed out.')); }, 1000); })]);
    } catch { this.controller.log({ action: 'notifier-failed', code: 'NOTIFIER_FAILED', commitSha: result.remoteSha }); }
    finally { clearTimeout(timer); }
  }
}

module.exports = { UpdateChecker, describeUpdates, MAX_AGE_MS };
