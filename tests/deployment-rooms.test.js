'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeRooms, unknownRoomSummary, isKnownRoomSummary } = require('../scripts/deploy/room-status');
const { createRuntime } = require('../scripts/deploy/runtime');
const { validateSnapshot } = require('../scripts/deploy/health');
const { pointer } = require('../scripts/deploy/fs-safety');
const { sandbox, SHA } = require('./helpers/deployment-sandbox');

function room(phase, state = {}, players = [[{ readyState: 1 }, { disconnectedAt: null }]]) {
  return { phase, state, players: new Map(players), _roomId: 'PRIVATE-ROOM', key: 'PRIVATE-KEY' };
}

test('an initialized empty server is EMPTY, but an unavailable or uninitialized map is UNKNOWN', () => {
  const empty = summarizeRooms(new Map());
  assert.equal(empty.roomStatus, 'EMPTY'); assert.equal(empty.totalRooms, 0);
  assert.equal(isKnownRoomSummary(empty), true);
  for (const value of [null, undefined, [], {}, new Set()]) assert.deepEqual(summarizeRooms(value), unknownRoomSummary());
  assert.deepEqual(summarizeRooms(new Map(), false), unknownRoomSummary());
});

test('authoritative room phases distinguish waiting, live, completed and retained expired rooms', () => {
  const rooms = new Map([
    ['lobby', room('lobby')], ['ready', room('ready')], ['active', room('playing', { winner: null })],
    ['won', room('playing', { winner: 0 })], ['draw', room('playing', { winner: -1 })],
    ['over', room('playing', { phase: 'over', winner: null })], ['expired', room('playing', {}, [])],
  ]);
  const value = summarizeRooms(rooms);
  assert.equal(value.waitingRooms, 2); assert.equal(value.activeGames, 1);
  assert.equal(value.completedRooms, 3); assert.equal(value.expiredRooms, 1);
  assert.equal(value.unknownRooms, 0); assert.equal(value.totalRooms, 7);
  assert.equal(value.blockingRooms, 7); assert.equal(value.roomStatus, 'ACTIVE');
  assert.equal(value.playingRooms, value.activeGames); assert.equal(isKnownRoomSummary(value), true);
  rooms.delete('expired');
  assert.equal(summarizeRooms(rooms).expiredRooms, 0, 'deleted rooms are not fabricated as historical counts');
});

test('round results and partial winners do not mark a game completed', () => {
  for (const state of [{ phase: 'round_end', roundWinner: 0 }, { phase: 'round_result' }, { winners: [0], phase: 'play' }]) {
    const value = summarizeRooms(new Map([['room', room('playing', state)]]));
    assert.equal(value.activeGames, 1); assert.equal(value.completedRooms, 0);
  }
});

test('disconnect and leave grace keep server-owned seats blocking even with no connected WebSocket', () => {
  for (const phase of ['lobby', 'ready', 'playing']) {
    const value = summarizeRooms(new Map([['room', room(phase, { winner: null }, [[{ readyState: 3 }, { disconnectedAt: Date.now() - 600000 }]])]]));
    assert.equal(value.connectedPlayers, 0); assert.equal(value.reconnectingPlayers, 1);
    assert.equal(value.expiredRooms, 0); assert.equal(value.blockingRooms, 1); assert.equal(value.roomStatus, 'ACTIVE');
  }
});

test('unknown phases, malformed game state and malformed seats cannot become EMPTY', () => {
  for (const value of [null, room('unrecognized'), room('playing', null), room('playing', []),
    { phase: 'lobby', players: {} }, room('lobby', {}, [[{ readyState: 1 }, { disconnectedAt: 'invalid' }]])]) {
    const summary = summarizeRooms(new Map([['room', value]]));
    assert.equal(summary.roomStatus, 'UNKNOWN'); assert.equal(summary.unknownRooms, 1);
    assert.equal(isKnownRoomSummary(summary), false);
  }
});

test('classification and runtime snapshots expose aggregate numbers without private room or game data', () => {
  const data = room('playing', { phase: 'play', hands: [['HIDDEN-CARD']], resumeToken: 'PRIVATE-RESUME' });
  const runtime = createRuntime({ root: __dirname, host: '127.0.0.1', getPort: () => 3101,
    getRooms: () => new Map([['PRIVATE-ID', data]]), isInitialized: () => true, env: {} });
  const snapshot = runtime.snapshot();
  assert.equal(snapshot.activeGames, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|HIDDEN|hands|resumeToken|roomId|"state"|"key"/);
  assert.equal(data.state.hands[0][0], 'HIDDEN-CARD', 'query does not mutate game state');
});

test('runtime collection failures return UNKNOWN instead of crashing or reporting zero rooms', () => {
  for (const overrides of [{ getRooms() { throw new Error('private details'); } }, { isInitialized: () => false },
    { isInitialized() { throw new Error('private details'); } }]) {
    const runtime = createRuntime({ root: __dirname, host: '127.0.0.1', getPort: () => 3101,
      getRooms: () => new Map(), isInitialized: () => true, env: {}, ...overrides });
    assert.equal(runtime.snapshot().roomStatus, 'UNKNOWN');
    assert.equal(runtime.snapshot().blockingRooms, null);
    assert.doesNotMatch(JSON.stringify(runtime.snapshot()), /private details/);
  }
});

test('missing, negative, inconsistent, or explicitly UNKNOWN summaries are rejected by health verification', () => {
  const valid = { schemaVersion: 1, releaseSha: SHA[0], ready: true, host: '127.0.0.1', port: 3000,
    draining: false, ...summarizeRooms(new Map()) };
  assert.equal(validateSnapshot(valid, SHA[0], 3000), valid);
  for (const changes of [{ roomStatus: 'UNKNOWN' }, { waitingRooms: 1 }, { blockingRooms: -1 },
    { totalRooms: undefined }, { activeGames: NaN }, { completedRooms: 1 }, { connectedPlayers: 1 }]) {
    assert.throws(() => validateSnapshot({ ...valid, ...changes }, SHA[0], 3000), { code: 'ROOMS_UNKNOWN' });
  }
});

for (const [kind, value] of [['waiting', room('lobby')], ['completed', room('playing', { winner: 0 })],
  ['expired', room('playing', {}, [])]]) {
  test(`${kind} retained rooms reject ordinary unattended deploy without switching or restarting`, async t => {
    const { controller, root, state, seed } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
    state.roomSnapshot = summarizeRooms(new Map([['room', value]]));
    await assert.rejects(controller.deploy(SHA[1], { yes: true }), { code: 'ROOMS_BLOCKED' });
    assert.equal(pointer(root, 'current'), SHA[0]); assert.equal(state.restarts, 0); assert.equal(state.draining, false);
    assert.equal(controller.history().at(-1).result, 'rejected');
  });
}

test('UNKNOWN with a misleading zero count, or inconsistent counts, cannot bypass unattended deployment', async t => {
  const { controller, root, state, seed } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  for (const override of [{ roomStatus: 'UNKNOWN' }, { waitingRooms: 1 }, { totalRooms: undefined }]) {
    state.roomSnapshot = { ...summarizeRooms(new Map()), ...override };
    await assert.rejects(controller.deploy(SHA[1], { yes: true, forceActive: true }), { code: 'ROOMS_BLOCKED' });
    assert.equal(pointer(root, 'current'), SHA[0]); assert.equal(state.restarts, 0);
  }
});

test('unknown room data prevents update readiness even when CI and the prepared candidate are valid', async t => {
  const { controller, state, seed, deps } = sandbox(t); await seed(); await controller.prepare(SHA[1]);
  deps.masterHead = async () => ({ repository: 'Polaris-deutsch/qingsi-games', branch: 'master', commitSha: SHA[1] });
  state.roomSnapshot = { ...summarizeRooms(new Map()), roomStatus: 'UNKNOWN' };
  const checked = await controller.checkUpdates(), status = await controller.status();
  assert.equal(checked.status, 'update-available'); assert.equal(status.roomStatus, 'UNKNOWN');
  assert.equal(status.releaseStatus, 'ROOMS_UNKNOWN'); assert.equal(state.restarts, 0);
});
