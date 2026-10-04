const test=require('node:test');
const assert=require('node:assert/strict');
const game=require('../games/drawguess');
const {startServer,message,request}=require('./helpers/ws-server');
function stage(count,options={}){const state=game.createState();state._options={mode:'stage',wordChoices:1,...options};game.initGame(state,count);return state;}
for(const count of [2,4])test(`${count}-player stage rotates every drawer and ends after all rounds`,()=>{
  const state=stage(count);
  for(let round=1;round<=count;round++){
    assert.equal(state.round,round);assert.equal(state.drawerIndex,round-1);assert.equal(state.phase,'playing');
    for(let seat=0;seat<count;seat++)if(seat!==state.drawerIndex)assert.equal(game.handleMove({type:'stage_guess',text:state.word},state,seat),null);
    assert.equal(state.phase,'round_result');assert.equal(game.onTimeout(state),true);
  }
  assert.equal(state.phase,'gameover');assert.notEqual(state.winner,null);
});
test('choosing timeout and nobody-correct drawing timeout both continue into the next round',()=>{
  const state=stage(2,{wordChoices:3});assert.equal(state.phase,'choosing');game.onTimeout(state);assert.equal(state.phase,'playing');
  game.onTimeout(state);assert.equal(state.phase,'round_result');game.onTimeout(state);assert.equal(state.round,2);assert.equal(state.phase,'choosing');
});
test('server replaces the timer after early correct guesses, including unlimited drawing and reconnect',async t=>{
  const server=await startServer(t),host=await server.connect(),guest=await server.connect();
  const created=await request(host,'create_room',{game:'drawguess'},'room_created');
  const joined=await request(guest,'join_room',{roomId:created.roomId},'room_joined');
  for(const [key,value]of Object.entries({mode:'stage',drawTime:0,wordChoices:1}))await request(host,'set_option',{key,value},'room_update',m=>m.options&&m.options[key]===value);
  await request(host,'player_ready',{},'room_update',m=>m.players.find(p=>p.index===0).ready);await request(guest,'player_ready',{},'room_update',m=>m.players.find(p=>p.index===1).ready);
  const start=await request(host,'start_game',{},'game_started');assert.equal(start.state.drawerIndex,0);assert.equal(start.state.stepDeadline,0);
  const result=await request(guest,'game_move',{type:'stage_guess',text:start.state.myTask.word},'game_state');
  assert.equal(result.state.phase,'round_result');assert.ok(result.state.stepDeadline-Date.now()>4500);assert.ok(result.state.stepDeadline-Date.now()<=5000);
  const resume=await server.connect();const restored=await request(resume,'join_room',{roomId:created.roomId,resumeToken:joined.resumeToken},'room_joined');
  assert.equal(restored.state.stepDeadline,result.state.stepDeadline);
  const second=await message(resume,'game_state',m=>m.state.round===2,6500);assert.equal(second.state.drawerIndex,1);assert.equal(second.state.phase,'playing');
  const word=second.state.myTask.word;await request(host,'game_move',{type:'stage_guess',text:word},'game_state');
  const over=await message(host,'game_state',m=>m.state.phase==='gameover',6500);assert.notEqual(over.state.winner,null);
});
test('drawing strokes, wrong guesses and a partial correct guess preserve the active deadline',async t=>{
  const server=await startServer(t),clients=await Promise.all([server.connect(),server.connect(),server.connect()]),host=clients[0];
  const created=await request(host,'create_room',{game:'drawguess'},'room_created');
  for(const ws of clients.slice(1))await request(ws,'join_room',{roomId:created.roomId},'room_joined');
  await request(host,'set_option',{key:'wordChoices',value:1},'room_update');
  for(const [seat,ws]of clients.entries())await request(ws,'player_ready',{},'room_update',m=>m.players.find(p=>p.index===seat).ready);
  const start=await request(host,'start_game',{},'game_started'),deadline=start.state.stepDeadline;
  const stroke=await request(host,'game_move',{type:'stage_stroke',stroke:{pts:[{x:0,y:0},{x:1,y:1}]}},'game_state');assert.equal(stroke.state.stepDeadline,deadline);
  assert.equal((await request(clients[1],'game_move',{type:'stage_guess',text:'definitely wrong'},'error')).code,'dg_wrong_try_again');
  const partial=await request(clients[1],'game_move',{type:'stage_guess',text:start.state.myTask.word},'game_state');assert.equal(partial.state.stepDeadline,deadline);assert.equal(partial.state.phase,'playing');
});

test('authoritative choosing/drawing/result timers advance without guesses and ignore replaced match state',()=>{
  const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync('server.js','utf8');
  const timerSource=source.slice(source.indexOf('function scheduleDrawguessTimer(room) {'),source.indexOf('function stopRealtimeGame(room) {'));
  let now=10000,id=0;const timers=new Map(),broadcasts=[];const state=stage(2,{wordChoices:3,drawTime:2}),room={state,_roomId:'ABC'};
  const context={rooms:new Map([['ABC',room]]),gameRegistry:{drawguess:game},Date:{now:()=>now},setTimeout:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimeout:key=>timers.delete(key),broadcastGameView:room=>broadcasts.push(room.state.phase)};
  vm.createContext(context);vm.runInContext(timerSource,context);context.scheduleDrawguessTimer(room);
  function fire(){const [key,timer]=timers.entries().next().value;timers.delete(key);now+=timer.ms;timer.fn();return timer.ms;}
  assert.equal(fire(),17000);assert.equal(state.phase,'playing');assert.equal(fire(),4000);assert.equal(state.phase,'round_result');assert.equal(state.stepDeadline,now+5000);
  assert.equal(fire(),5000);assert.equal(state.round,2);assert.equal(state.drawerIndex,1);assert.equal(state.phase,'choosing');
  const pending=[...timers.values()][0];room.state=stage(2);pending.fn();assert.deepEqual(broadcasts,['playing','round_result','choosing']);
});
