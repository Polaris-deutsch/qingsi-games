const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');
const { isAllowedWebSocketOrigin, validateClientMessage } = require('../internet-security');

const root = path.join(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function withServer(config, run) {
  const port = await freePort();
  const env = { ...process.env, NODE_ENV: 'test', PORT: String(port), ...config };
  for (const key of ['PUBLIC_BASE_URL', 'GAMENEST_DEBUG', 'MAX_ROOMS', 'MAX_CONNECTIONS', 'WS_MAX_PAYLOAD']) {
    if (!Object.hasOwn(config, key)) delete env[key];
  }
  // Only accelerate the disconnect grace period for the cleanup integration test.
  const script = config.TEST_FAST_CLEANUP
    ? "const original=setTimeout;global.setTimeout=(fn,ms,...args)=>original(fn,ms===30000?80:ms,...args);const si=setInterval,ci=clearInterval,live=new Set();global.setInterval=(fn,ms,...args)=>{const h=si(fn,ms,...args);if(ms===120)live.add(h);return h};global.clearInterval=h=>{if(live.delete(h))process.stdout.write('REALTIME_CLEARED\\n');return ci(h)};require('./server.js')"
    : config.TEST_UNO_CHALLENGE
      ? "const uno=require('./games/uno');const init=uno.initGame;uno.initGame=(state,n)=>{init(state,n);state.currentPlayer=0;state.currentColor='red';state.hands[0].push({color:'wild',value:'+4',id:'test-plus-four'},{color:'red',value:'1',id:'test-red'})};require('./server.js')"
    : "require('./server.js')";
  delete env.TEST_FAST_CLEANUP;
  delete env.TEST_UNO_CHALLENGE;
  const child = spawn(process.execPath, ['-e', script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const clients = [];
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server exited: ${output}`);
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch (_) {}
      await delay(50);
    }
    if (Date.now() >= deadline) throw new Error(`server did not start: ${output}`);
    const connect = options => new Promise((resolve, reject) => {
      const client = new WebSocket(wsUrl, { handshakeTimeout: 2000, ...options });
      clients.push(client);
      const timer = setTimeout(() => { client.terminate(); reject(new Error('WebSocket connect timeout')); }, 3000);
      client.once('open', () => { clearTimeout(timer); resolve(client); });
      client.once('error', err => { clearTimeout(timer); reject(err); });
    });
    await run({ base, wsUrl, connect, clients, getOutput: () => output });
  } finally {
    for (const client of clients) client.terminate();
    child.kill();
    if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

function nextMessage(ws, expected, ms = 2500, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Missing ${expected} message`)); }, ms);
    const onClose = () => { cleanup(); reject(new Error(`Closed before ${expected}`)); };
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (expected && message.type !== expected && message.code !== expected) return;
      if (!predicate(message)) return;
      cleanup(); resolve(message);
    };
    function cleanup() { clearTimeout(timer); ws.off('message', onMessage); ws.off('close', onClose); }
    ws.on('message', onMessage); ws.on('close', onClose);
  });
}

function sendAndWait(ws, type, data, expected = null) {
  const result = nextMessage(ws, expected);
  ws.send(JSON.stringify({ type, data }));
  return result;
}

async function readyRoom(clients) {
  for (let i = 0; i < clients.length - 1; i++) {
    await sendAndWait(clients[i], 'player_ready', {}, 'room_update');
  }
  const allReady = nextMessage(clients[0], 'room_update', 2500, message =>
    message.players.filter(player => !player.isBot).every(player => player.ready));
  clients[clients.length - 1].send(JSON.stringify({ type: 'player_ready' }));
  await allReady;
}

function closedWith(ws, code, ms = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Missing close ${code}`)), ms);
    ws.once('close', actual => {
      clearTimeout(timer);
      try { assert.equal(actual, code); resolve(); } catch (err) { reject(err); }
    });
  });
}

function rejected(url, options, status) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { handshakeTimeout: 2000, ...options });
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Missing HTTP rejection')); }, 3000);
    ws.once('unexpected-response', (_, response) => {
      clearTimeout(timer);
      response.resume();
      try { assert.equal(response.statusCode, status); resolve(); } catch (err) { reject(err); }
    });
    ws.once('open', () => { clearTimeout(timer); ws.terminate(); reject(new Error('Unexpectedly accepted')); });
    ws.once('error', err => { clearTimeout(timer); reject(err); });
  });
}

test('production, LAN and missing-Origin WebSocket policy', async () => {
  await withServer({ PUBLIC_BASE_URL: 'https://games.qingsiphotograph.com' }, async ({ wsUrl, connect }) => {
    const publicHost = { headers: { Host: 'games.qingsiphotograph.com' } };
    const publicClient = await connect({ ...publicHost, origin: 'https://games.qingsiphotograph.com' });
    assert.equal(publicClient.readyState, WebSocket.OPEN);
    await rejected(wsUrl, { ...publicHost, origin: 'https://evil.example' }, 403);
    await rejected(wsUrl, publicHost, 403);
    const lanClient = await connect({ origin: `http://127.0.0.1:${new URL(wsUrl).port}` });
    assert.equal(lanClient.readyState, WebSocket.OPEN);
    const missingOriginLan = await connect();
    assert.equal(missingOriginLan.readyState, WebSocket.OPEN);
  });
  // Browser WebViews send Origin; non-browser Android/LAN clients may omit it.
  assert.equal(isAllowedWebSocketOrigin({ headers: { host: '192.168.1.2:3000' }, socket: { remoteAddress: '192.168.1.3' } }, null), true);
  assert.equal(isAllowedWebSocketOrigin({ headers: { host: 'games.qingsiphotograph.com' }, socket: { remoteAddress: '192.168.1.3' } }, 'https://games.qingsiphotograph.com'), false);
});

test('payload cap rejects oversized frames; malformed JSON, unknown types and prototype keys remain safe', async () => {
  await withServer({ WS_MAX_PAYLOAD: '65536' }, async ({ base, connect }) => {
    const ws = await connect();
    ws.send('{bad json');
    ws.send(JSON.stringify({ type: 'unknown_event', data: { harmless: true } }));
    const invalid = nextMessage(ws, 'INVALID_MESSAGE');
    ws.send('{"type":"set_option","data":{"key":"__proto__","value":{"polluted":true}}}');
    assert.equal((await invalid).code, 'INVALID_MESSAGE');
    assert.equal((await sendAndWait(ws, 'create_room', { game: 'gomoku' }, 'room_created')).type, 'room_created');
    const close = closedWith(ws, 1009);
    ws.send('x'.repeat(65537));
    await close;
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    assert.equal(health.status, 200);
  });
  assert.equal({}.polluted, undefined);
});

test('create, join, room and connection abuse limits', async () => {
  await withServer({ MAX_ROOMS: '1', MAX_CONNECTIONS: '2' }, async ({ wsUrl, connect }) => {
    const host = await connect();
    const created = await sendAndWait(host, 'create_room', { game: 'gomoku' }, 'room_created');
    assert.match(created.roomId, /^[A-HJ-NP-Z2-9]{3,4}$/);
    assert.equal((await sendAndWait(host, 'create_room', { game: 'gomoku' }, 'CREATE_COOLDOWN')).code, 'CREATE_COOLDOWN');
    const joiner = await connect();
    assert.equal((await sendAndWait(joiner, 'join_room', { roomId: 'ZZZ' }, 'ROOM_NOT_FOUND')).code, 'ROOM_NOT_FOUND');
    assert.equal((await sendAndWait(joiner, 'join_room', { roomId: 'ZZZ' }, 'ROOM_NOT_FOUND')).code, 'ROOM_NOT_FOUND');
    for (let i = 0; i < 4; i++) await sendAndWait(joiner, 'join_room', { roomId: 'ZZZ' }, 'ROOM_NOT_FOUND');
    assert.equal((await sendAndWait(joiner, 'join_room', { roomId: 'ZZZ' }, 'JOIN_RATE_LIMIT')).code, 'JOIN_RATE_LIMIT');
    assert.equal((await sendAndWait(joiner, 'create_room', { game: 'gomoku' }, 'ROOM_LIMIT')).code, 'ROOM_LIMIT');
    await rejected(wsUrl, {}, 503);
  });
});

test('normal unicode names and realtime Snake input pass; flood is disconnected', async () => {
  await withServer({}, async ({ connect }) => {
    const ws = await connect();
    await sendAndWait(ws, 'create_room', { game: 'snakebattle' }, 'room_created');
    const invalid = nextMessage(ws, 'INVALID_MESSAGE');
    ws.send(JSON.stringify({ type: 'set_name', data: { name: '<img>' } }));
    await invalid;
    assert.equal((await sendAndWait(ws, 'set_name', { name: '青丝🎮' }, 'room_update')).players[0].name, '青丝🎮');
    assert.equal((await sendAndWait(ws, 'set_name', { name: 'a'.repeat(20) }, 'INVALID_MESSAGE')).code, 'INVALID_MESSAGE');
    await sendAndWait(ws, 'add_bot', {}, 'room_update');
    await sendAndWait(ws, 'player_ready', {}, 'room_update');
    const started = await sendAndWait(ws, 'start_game', {}, 'game_started');
    assert.equal(started.state.realtime, true);
    assert.equal((await nextMessage(ws, 'game_state')).state.realtime, true);
    for (let i = 0; i < 30; i++) {
      ws.send(JSON.stringify({ type: 'game_move', data: { direction: 'up' } }));
      await delay(25);
    }
    assert.equal(ws.readyState, WebSocket.OPEN);
    const close = closedWith(ws, 1008);
    for (let i = 0; i < 150; i++) ws.send(JSON.stringify({ type: 'unknown_event' }));
    await close;
  });
});

test('UNO views keep hands and deck private across start and reconnect', async () => {
  await withServer({}, async ({ base, connect }) => {
    const host = await connect();
    const created = await sendAndWait(host, 'create_room', { game: 'uno' }, 'room_created');
    const existsWithoutToken = await fetch(`${base}/api/room-exists/${created.roomId}`, { signal: AbortSignal.timeout(1500) });
    assert.deepEqual(await existsWithoutToken.json(), { exists: false });
    const existsWithToken = await fetch(`${base}/api/room-exists/${created.roomId}`, {
      headers: { 'X-Resume-Token': created.resumeToken }, signal: AbortSignal.timeout(1500),
    });
    assert.deepEqual(await existsWithToken.json(), { exists: true });
    const guest = await connect();
    const joined = await sendAndWait(guest, 'join_room', { roomId: created.roomId }, 'room_joined');
    await readyRoom([host, guest]);
    const hostStarted = nextMessage(host, 'game_started');
    const guestStarted = nextMessage(guest, 'game_started');
    host.send(JSON.stringify({ type: 'start_game' }));
    const [a, b] = await Promise.all([hostStarted, guestStarted]);
    for (const view of [a.state, b.state]) {
      assert.equal(view.hands.length, 2);
      assert.equal(view.hands[0].length, 7);
      assert.equal(view.hands[1].length, 7);
      assert.ok(view.deck.every(card => card === null));
      assert.equal(view.pendingChallenge, null);
    }
    assert.ok(a.state.hands[0].every(card => card && card.id));
    assert.ok(a.state.hands[1].every(card => card === null));
    assert.ok(b.state.hands[0].every(card => card === null));
    assert.ok(b.state.hands[1].every(card => card && card.id));
    guest.terminate();
    const resumed = await connect();
    const view = (await sendAndWait(resumed, 'join_room', { roomId: created.roomId, resumeToken: joined.resumeToken }, 'room_joined')).state;
    assert.ok(view.hands[0].every(card => card === null));
    assert.ok(view.hands[1].every(card => card && card.id));
    assert.ok(view.deck.every(card => card === null));
  });
});

test('UNO +4 challenge snapshot stays server-side and result appears only after resolution', async () => {
  await withServer({ TEST_UNO_CHALLENGE: '1' }, async ({ connect }) => {
    const host = await connect();
    const created = await sendAndWait(host, 'create_room', { game: 'uno' }, 'room_created');
    const guest = await connect();
    await sendAndWait(guest, 'join_room', { roomId: created.roomId }, 'room_joined');
    await readyRoom([host, guest]);
    await sendAndWait(host, 'start_game', {}, 'game_started');
    const pendingHost = nextMessage(host, 'game_state');
    const pendingGuest = nextMessage(guest, 'game_state');
    host.send(JSON.stringify({ type: 'game_move', data: { cardId: 'test-plus-four', chosenColor: 'blue' } }));
    for (const message of await Promise.all([pendingHost, pendingGuest])) {
      assert.equal(message.state.pendingChallenge.by, 0);
      assert.equal(message.state.pendingChallenge.target, 1);
      assert.equal(Object.hasOwn(message.state.pendingChallenge, 'handSnapshot'), false);
      assert.equal(message.state.lastChallengeResult, null);
    }
    const resolvedHost = nextMessage(host, 'game_state');
    const resolvedGuest = nextMessage(guest, 'game_state');
    guest.send(JSON.stringify({ type: 'game_move', data: { challengeResponse: 'challenge' } }));
    for (const message of await Promise.all([resolvedHost, resolvedGuest])) {
      assert.equal(message.state.pendingChallenge, null);
      assert.deepEqual(message.state.lastChallengeResult, { by: 0, hadMatch: true });
    }
  });
});

test('other known card and tile games hide opponent hands and concealed draws', async () => {
  await withServer({}, async ({ connect }) => {
    for (const game of ['doudizhu', 'bigtwo', 'oldmaid', 'exploding-kittens', 'rummikub', 'liarsbar']) {
      const clients = [await connect()];
      const created = await sendAndWait(clients[0], 'create_room', { game }, 'room_created');
      const count = game === 'doudizhu' ? 3 : 2;
      for (let i = 1; i < count; i++) {
        clients.push(await connect());
        await sendAndWait(clients[i], 'join_room', { roomId: created.roomId }, 'room_joined');
      }
      await readyRoom(clients);
      const started = clients.map(client => nextMessage(client, 'game_started'));
      clients[0].send(JSON.stringify({ type: 'start_game' }));
      const views = (await Promise.all(started)).map(message => message.state);
      for (let viewer = 0; viewer < count; viewer++) {
        const view = views[viewer];
        assert.ok(view.hands[viewer].length > 0, `${game}: own hand is present`);
        assert.ok(view.hands[viewer].some(card => card !== null), `${game}: own cards visible`);
        for (let other = 0; other < count; other++) {
          if (other === viewer) continue;
          assert.ok(view.hands[other].every(card => card === null), `${game}: opponent cards hidden`);
        }
        if (game === 'doudizhu') {
          assert.ok(view.bottomCards.every(card => card === null));
          assert.ok(view.board.hands[(viewer + 1) % count].every(card => card === null));
          assert.ok(view.board.bottomCards.every(card => card === null));
        }
        if (game === 'exploding-kittens') assert.ok(view.deck.every(card => card === null));
        if (game === 'rummikub') assert.ok(view.pool.every(tile => tile === null));
        if (game === 'liarsbar') assert.equal(Object.hasOwn(view, '_bulletChamber'), false);
      }
    }
  });
});

test('Old Maid draw and Liar’s Bar claim remain private after moves and reconnect', async () => {
  await withServer({}, async ({ connect }) => {
    const oldHost = await connect();
    const oldCreated = await sendAndWait(oldHost, 'create_room', { game: 'oldmaid' }, 'room_created');
    const oldGuest = await connect();
    const oldJoined = await sendAndWait(oldGuest, 'join_room', { roomId: oldCreated.roomId }, 'room_joined');
    await readyRoom([oldHost, oldGuest]);
    const oldStartHost = nextMessage(oldHost, 'game_started');
    const oldStartGuest = nextMessage(oldGuest, 'game_started');
    oldHost.send(JSON.stringify({ type: 'start_game' }));
    await Promise.all([oldStartHost, oldStartGuest]);
    const oldMoveHost = nextMessage(oldHost, 'game_state');
    const oldMoveGuest = nextMessage(oldGuest, 'game_state');
    oldHost.send(JSON.stringify({ type: 'game_move', data: { cardIndex: 0 } }));
    const [oldActor, oldObserver] = (await Promise.all([oldMoveHost, oldMoveGuest])).map(message => message.state);
    assert.ok(oldActor.lastDraw.card);
    assert.equal(oldObserver.lastDraw.card, null);
    assert.ok(oldActor.messages.some(message => message.cardDrawn));
    assert.ok(oldObserver.messages.every(message => !Object.hasOwn(message, 'cardDrawn')));
    oldGuest.terminate();
    const oldResumed = await connect();
    const oldResumeView = (await sendAndWait(oldResumed, 'join_room', {
      roomId: oldCreated.roomId, resumeToken: oldJoined.resumeToken,
    }, 'room_joined')).state;
    assert.equal(oldResumeView.lastDraw.card, null);
    assert.ok(oldResumeView.messages.every(message => !Object.hasOwn(message, 'cardDrawn')));

    const liarHost = await connect();
    const liarCreated = await sendAndWait(liarHost, 'create_room', { game: 'liarsbar' }, 'room_created');
    const liarGuest = await connect();
    const liarJoined = await sendAndWait(liarGuest, 'join_room', { roomId: liarCreated.roomId }, 'room_joined');
    await readyRoom([liarHost, liarGuest]);
    const liarStartHost = nextMessage(liarHost, 'game_started');
    const liarStartGuest = nextMessage(liarGuest, 'game_started');
    liarHost.send(JSON.stringify({ type: 'start_game' }));
    const initial = (await Promise.all([liarStartHost, liarStartGuest])).map(message => message.state);
    const actor = initial[0].currentPlayer;
    const liarClients = [liarHost, liarGuest];
    const cardId = initial[actor].hands[actor][0].id;
    const liarMoved = liarClients.map(client => nextMessage(client, 'game_state'));
    liarClients[actor].send(JSON.stringify({ type: 'game_move', data: { action: 'play', cardIds: [cardId] } }));
    for (const message of await Promise.all(liarMoved)) {
      const view = message.state;
      assert.equal(Object.hasOwn(view, '_bulletChamber'), false);
      assert.ok(view.pileCards.every(card => card === null));
      assert.ok(view.lastPlayedCards.every(card => card === null));
      assert.equal(view.pileClaims.at(-1).cardCount, 1);
      assert.equal(Object.hasOwn(view.pileClaims.at(-1), 'cardIds'), false);
    }
    liarGuest.terminate();
    const liarResumed = await connect();
    const liarResumeView = (await sendAndWait(liarResumed, 'join_room', {
      roomId: liarCreated.roomId, resumeToken: liarJoined.resumeToken,
    }, 'room_joined')).state;
    assert.equal(Object.hasOwn(liarResumeView, '_bulletChamber'), false);
    assert.equal(Object.hasOwn(liarResumeView.pileClaims.at(-1), 'cardIds'), false);
  });
});

test('health, debug, private network endpoint and headers expose no public internals', async () => {
  await withServer({ PUBLIC_BASE_URL: 'https://games.qingsiphotograph.com', GAMENEST_DEBUG: '1', NODE_ENV: 'production' }, async ({ base }) => {
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) });
    assert.deepEqual(Object.keys(await health.json()).sort(), ['ok', 'service', 'version']);
    assert.equal(health.headers.get('cache-control'), 'no-store');
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.ok(health.headers.get('permissions-policy'));
    assert.equal(health.headers.get('access-control-allow-origin'), null);
    const debug = await fetch(`${base}/api/debug/rooms`, { signal: AbortSignal.timeout(2000) });
    assert.equal(debug.status, 404);
    const network = await fetch(`${base}/network-info`, { signal: AbortSignal.timeout(2000) });
    assert.equal(network.status, 404);
  });
  await withServer({}, async ({ base }) => {
    const localNetwork = await fetch(`${base}/network-info`, { signal: AbortSignal.timeout(2000) });
    assert.equal(localNetwork.status, 200);
  });
});

test('local debug POST body has a bounded, generic 413 response', async () => {
  await withServer({ GAMENEST_DEBUG: '1' }, async ({ base }) => {
    const response = await fetch(`${base}/api/debug/room/ZZZ/forceWin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(33000) }),
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'invalid request' });
  });
});

test('empty realtime room and its tick timer are removed after disconnect grace', async () => {
  await withServer({ TEST_FAST_CLEANUP: '1' }, async ({ base, connect, getOutput }) => {
    const ws = await connect();
    const created = await sendAndWait(ws, 'create_room', { game: 'snakebattle' }, 'room_created');
    await sendAndWait(ws, 'add_bot', {}, 'room_update');
    await sendAndWait(ws, 'player_ready', {}, 'room_update');
    await sendAndWait(ws, 'start_game', {}, 'game_started');
    ws.terminate();
    const check = () => fetch(`${base}/api/room-exists/${created.roomId}`, {
      headers: { 'X-Resume-Token': created.resumeToken }, signal: AbortSignal.timeout(1000),
    }).then(res => res.json());
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && (await check()).exists) await delay(40);
    assert.deepEqual(await check(), { exists: false });
    assert.match(getOutput(), /REALTIME_CLEARED/);
  });
});

test('prototype and transport validation reject dangerous structures without blocking Unicode', () => {
  assert.equal(validateClientMessage(JSON.parse('{"type":"game_move","data":{"__proto__":{"x":1}}}')), false);
  assert.equal(validateClientMessage({ type: 'set_option', data: { key: 'constructor', value: 1 } }), false);
  assert.equal(validateClientMessage({ type: 'set_option', data: { key: 'mode', value: '<img>' } }), false);
  assert.equal(validateClientMessage({ type: 'set_option', data: { key: 'categories', value: ['animal', 'movie'] } }), true);
  assert.equal(validateClientMessage({ type: 'set_option', data: { key: 'customWords', value: '青丝,游戏' } }), true);
  assert.equal(validateClientMessage({ type: 'set_name', data: { name: '青丝🎮' } }), true);
  assert.equal(validateClientMessage({ type: 'set_name', data: { name: '<svg onload=alert(1)>' } }), false);
  assert.equal(validateClientMessage({ type: 'game_move', data: { content: 'x'.repeat(257) } }), false);
});
