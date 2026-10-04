const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const WebSocket = require('ws');

function message(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(Error('Missing ' + type)); }, 4000);
    const receive = raw => {
      const value = JSON.parse(raw.toString());
      if (value.type === 'error' && type !== 'error') { cleanup(); reject(Error(value.message)); }
      else if (value.type === type) { cleanup(); resolve(value); }
    };
    function cleanup() { clearTimeout(timer); ws.off('message', receive); }
    ws.on('message', receive);
  });
}
function request(ws, type, data, expected) {
  const result = message(ws, expected);
  ws.send(JSON.stringify({ type, data }));
  return result;
}
function privateView(view, owner, privateIds) {
  for (let i = 0; i < view.hands.length; i++) {
    if (i !== owner) assert.ok(view.hands[i].every(tile => tile === null));
  }
  assert.ok(view.pool.every(tile => tile === null));
  assert.equal(Object.hasOwn(view,'chatAt'),false,'server cooldowns stay private');
  for (const event of view.activity.items) {
    if (event.type === 'rummikub.draw') assert.deepEqual(event.data,{});
    assert.equal(Object.hasOwn(event,'workspace'),false);
    assert.equal(Object.hasOwn(event,'savedHand'),false);
  }
  for (const id of privateIds) assert.equal(JSON.stringify(view).includes(id), false, id + ' leaked');
}

test('Rummikub draws, manipulation snapshots and resumed views keep tile identities private', async () => {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  // Deterministic legal hands, supplied only to the isolated test process.
  const setup = `
    const game = require('./games/rummikub');
    const init = game.initGame;
    game.initGame = (state, count) => {
      init(state, count);
      const tiles = [...state.pool, ...state.hands.flat()];
      const take = id => tiles.splice(tiles.findIndex(tile => tile.id === id), 1)[0];
      state.hands[0] = ['blue-10-a','blue-11-a','blue-12-a','blue-13-a'].map(take).concat(tiles.splice(0,10));
      for (let i=1;i<count;i++) state.hands[i]=tiles.splice(0,14);
      state.pool=tiles;
    };
    require('./server.js');
  `;
  const env = { ...process.env, PORT: String(port), NODE_ENV: 'test' };
  delete env.PUBLIC_BASE_URL; delete env.GAMENEST_DEBUG;
  const server = spawn(process.execPath, ['-e', setup], {
    cwd: path.join(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', chunk => { output += chunk; });
  server.stderr.on('data', chunk => { output += chunk; });
  const clients = [];
  const url = `ws://127.0.0.1:${port}`;
  async function connect() {
    const ws = new WebSocket(url, { origin: `http://127.0.0.1:${port}`, handshakeTimeout: 2000 });
    clients.push(ws); await once(ws, 'open'); return ws;
  }
  try {
    const deadline = Date.now() + 6000;
    while (true) {
      if (server.exitCode !== null) throw Error(output);
      try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
      if (Date.now() > deadline) throw Error('Server startup timeout: ' + output);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const host = await connect(), guest = await connect();
    const created = await request(host, 'create_room', { game: 'rummikub' }, 'room_created');
    await request(guest, 'join_room', { roomId: created.roomId }, 'room_joined');
    await request(host, 'player_ready', {}, 'room_update');
    const ready = message(host, 'room_update');
    await request(guest, 'player_ready', {}, 'room_update'); await ready;
    const guestStart = message(guest, 'game_started');
    const start = await request(host, 'start_game', {}, 'game_started');
    privateView((await guestStart).state, 1, start.state.hands[0].map(tile => tile.id));
    assert.deepEqual(start.state.activity.items.map(e=>e.type),['rummikub.game_start']);

    const hostChat=message(host,'game_state');
    const chatted=await request(guest,'game_move',{action:'activity_chat',text:'  hello   <img src=x>  ',player:0,name:'fake',workspace:start.state.hands[0]},'game_state');
    const chattedHost=(await hostChat).state;
    assert.deepEqual(chatted.state.activity.items,chattedHost.activity.items);
    assert.equal(chatted.state.activity.items.at(-1).player,1);
    assert.deepEqual(chatted.state.activity.items.at(-1).data,{text:'hello <img src=x>'});
    assert.deepEqual(chattedHost.hands,start.state.hands);
    assert.deepEqual(chattedHost.table,start.state.table);
    assert.equal(chattedHost.currentPlayer,start.state.currentPlayer);
    privateView(chatted.state,1,start.state.hands[0].map(t=>t.id));
    const guestReaction=message(guest,'game_state');
    const reacted=await request(host,'game_move',{action:'activity_reaction',emoji:'👍'},'game_state');
    assert.deepEqual((await guestReaction).state.activity.items,reacted.state.activity.items);
    for (const [data,code] of [
      [{action:'activity_chat',text:' '},'activity_chat_empty'],
      [{action:'activity_chat',text:'x'.repeat(121)},'activity_chat_too_long'],
      [{action:'activity_reaction',emoji:'<img>'},'activity_invalid_reaction'],
      [{action:'activity_chat',text:'too soon'},'activity_chat_fast'],
    ]) assert.equal((await request(guest,'game_move',data,'error')).code,code);

    const guestDraw = message(guest, 'game_state');
    const draw = await request(host, 'game_move', { pass: true }, 'game_state');
    const newTiles = draw.state.hands[0].filter(tile => !start.state.hands[0].some(before => before.id === tile.id));
    assert.equal(newTiles.length, 1);
    assert.equal(draw.state.activity.items.filter(e=>e.type==='rummikub.draw').length,1);
    assert.deepEqual(draw.state.activity.items.find(e=>e.type==='rummikub.draw').data,{});
    privateView((await guestDraw).state, 1, [newTiles[0].id]);
    const hostTurn = message(host, 'game_state');
    await request(guest, 'game_move', { pass: true }, 'game_state'); await hostTurn;

    const guestPlay = message(guest, 'game_state');
    await request(host, 'game_move', { tileIds: ['blue-10-a','blue-11-a','blue-12-a'] }, 'game_state');
    await guestPlay;
    const guestWorkspace = message(guest, 'game_state');
    const workspace = await request(host, 'game_move', { action: 'start_manipulate' }, 'game_state');
    const observer = (await guestWorkspace).state;
    assert.equal(observer.workspace.length, 0);
    assert.equal(observer.savedHand, null);
    assert.equal(observer.savedHandIds, null);
    privateView(observer, 1, workspace.state.hands[0].map(tile => tile.id));
    await new Promise(resolve=>setTimeout(resolve,810));
    const hostWorkspaceChat=message(host,'game_state');
    const workspaceChat=await request(guest,'game_move',{action:'activity_chat',text:'thinking',savedHand:workspace.state.savedHand},'game_state');
    const ownerChat=(await hostWorkspaceChat).state;
    assert.equal(ownerChat.phase,'manipulate');assert.deepEqual(ownerChat.workspace,workspace.state.workspace);
    assert.deepEqual(ownerChat.savedHand,workspace.state.savedHand);
    privateView(workspaceChat.state,1,workspace.state.hands[0].map(t=>t.id));

    const guestCancel = message(guest, 'game_state');
    await request(host, 'game_move', { action: 'cancel' }, 'game_state'); await guestCancel;
    const guestRestartWorkspace = message(guest, 'game_state');
    const edit = await request(host, 'game_move', { action: 'start_manipulate' }, 'game_state');
    await guestRestartWorkspace;
    const extra = edit.state.hands[0].find(tile => tile.id === 'blue-13-a');
    const guestSubmit = message(guest, 'game_state');
    const submitted = await request(host, 'game_move', { action: 'submit', groups: [edit.state.table[0].concat(extra)] }, 'game_state');
    const publicTable = (await guestSubmit).state;
    assert.ok(publicTable.table[0].some(tile => tile.id === extra.id), 'played tiles become public');
    assert.deepEqual(publicTable.activity.items.at(-1).data,{usedHandTilesCount:1});
    privateView(publicTable, 1, [newTiles[0].id]);
    assert.equal(Object.hasOwn(submitted.state, 'lastDraw'), false, 'no new server feedback fields');

    const resumed = await connect();
    const view = await request(resumed, 'join_room', { roomId: created.roomId, resumeToken: created.resumeToken }, 'room_joined');
    assert.ok(view.state.hands[0].some(tile => tile.id === newTiles[0].id));
    privateView(view.state, 0, []);
    assert.deepEqual(view.state.activity.items,submitted.state.activity.items,'same match timeline restores on reconnect');
    const nextGuest=message(guest,'game_state');
    const next=await request(resumed,'game_restart',{},'game_state');
    assert.notEqual(next.state.matchId,view.state.matchId);
    assert.deepEqual(next.state.activity.items.map(e=>e.type),['rummikub.game_start']);
    assert.deepEqual((await nextGuest).state.activity.items,next.state.activity.items);
  } finally {
    for (const client of clients) client.terminate();
    server.kill('SIGTERM');
    if (server.exitCode === null) await once(server, 'exit');
  }
});
