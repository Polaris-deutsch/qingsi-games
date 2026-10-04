const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {startServer,request}=require('./helpers/ws-server');
function catalog(){const ctx={window:{}};vm.runInNewContext(fs.readFileSync('public/js/game-catalog.js','utf8'),ctx);return Array.from(ctx.window.gameCatalog.list());}
test('every playable catalog ID has a registered module and a renderer in the game shell',()=>{
  const html=fs.readFileSync('public/game.html','utf8');
  for(const {id}of catalog()){
    const game=require('../games/'+id);assert.equal(game.name,id);assert.equal(typeof game.createState,'function');assert.equal(typeof game.handleMove,'function');
    const script=id.startsWith('mahjong-')?'mahjong':id;assert.ok(html.includes('/js/renderers/'+script+'.js'),id);
    const ctx={window:{rummikubOrder:require('../public/js/rummikub-order')},Map,document:{addEventListener:()=>{},querySelector:()=>null},setInterval:()=>0,setTimeout:()=>0};vm.runInNewContext(fs.readFileSync('public/js/renderers/'+script+'.js','utf8'),ctx);
    assert.ok(ctx.window.gameRenderers.has(id),id+' renderer registration');
    const state=game.createState();assert.ok(state&&typeof state==='object');assert.doesNotThrow(()=>JSON.stringify(state));
  }
});
test('all registered games can create, resume and join a lobby, then initialize and serialize player views',async t=>{
  const server=await startServer(t);
  const ids=fs.readdirSync('games').filter(file=>file.endsWith('.js')).map(file=>require('../games/'+file)).filter(game=>typeof game.createState==='function'&&typeof game.handleMove==='function').map(game=>game.name);
  for(const id of ids)await t.test(id,async()=>{
    const host=await server.connect();const created=await request(host,'create_room',{game:id},'room_created');assert.equal(created.game,id);assert.ok(created.resumeToken);
    const resume=await server.connect();const restored=await request(resume,'join_room',{roomId:created.roomId,resumeToken:created.resumeToken},'room_joined');
    assert.equal(restored.phase,'lobby');assert.equal(restored.state,null);assert.equal(restored.playerIndex,0);
    const guest=await server.connect();assert.equal((await request(guest,'join_room',{roomId:created.roomId},'room_joined')).state,null);
    const game=require('../games/'+id),count=game.minPlayers||2;
    for(let seat=2;seat<count;seat++){const extra=await server.connect();await request(extra,'join_room',{roomId:created.roomId},'room_joined');await request(extra,'player_ready',{},'room_update',m=>m.players.find(p=>p.index===seat).ready);}
    await request(resume,'player_ready',{},'room_update',m=>m.players.find(p=>p.index===0).ready);await request(guest,'player_ready',{},'room_update',m=>m.players.find(p=>p.index===1).ready);
    const start=await request(resume,'start_game',{},'game_started');assert.ok(start.state);assert.doesNotThrow(()=>JSON.stringify(start.state));
    await request(resume,'return_to_room',{},'room_update',m=>m.phase==='lobby').catch(error=>{throw Error(id+': '+error.message+' logs: '+server.logs());});
    host.terminate();resume.terminate();guest.terminate();
  });
  assert.equal(/playerView failed|createState failed/.test(server.logs()),false,server.logs());
});
test('invalid factories and IDs return explicit errors and keep other games available',async t=>{
  const server=await startServer(t,"require('./games/tictactoe').createState=()=>undefined;");
  const bad=await server.connect();assert.equal((await request(bad,'create_room',{game:'tictactoe'},'error')).code,'CREATE_ROOM_FAILED');
  const unknown=await server.connect();assert.equal((await request(unknown,'create_room',{game:'missing-game'},'error')).code,'INVALID_GAME');
  const good=await server.connect();assert.equal((await request(good,'create_room',{game:'gomoku'},'room_created')).game,'gomoku');
  assert.match(server.logs(),/createState failed.*tictactoe/);
});

test('playing playerView failures are diagnosed and sent as errors instead of leaving a join pending',async t=>{
  const server=await startServer(t,"require('./games/tictactoe').playerView=(state,seat)=>{if(seat===1)return undefined;throw Error('test view failure');};");
  const host=await server.connect(),guest=await server.connect();const created=await request(host,'create_room',{game:'tictactoe'},'room_created');
  await request(guest,'join_room',{roomId:created.roomId},'room_joined');
  await request(host,'player_ready',{},'room_update',m=>m.players.find(p=>p.index===0).ready);
  await request(guest,'player_ready',{},'room_update',m=>m.players.find(p=>p.index===1).ready);
  assert.equal((await request(host,'start_game',{},'error')).code,'GAME_VIEW_FAILED');
  const resumed=await server.connect();assert.equal((await request(resumed,'join_room',{roomId:created.roomId,resumeToken:created.resumeToken},'error')).code,'GAME_VIEW_FAILED');
  assert.match(server.logs(),/playerView failed: game=tictactoe player=0 phase=playing/);assert.match(server.logs(),/test view failure/);assert.match(server.logs(),/playerView must return an object/);
});
