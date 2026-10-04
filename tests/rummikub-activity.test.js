const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const game = require('../games/rummikub');
const activity = require('../public/js/rummikub-activity');
const tile=(num,color='red',copy='a')=>({num,color,id:`${color}-${num}-${copy}`});
const wild={num:0,color:'joker',wild:true,id:'joker-0'};
function state() {
  const s=game.createState();game.initGame(s,2);
  Object.assign(s,{hands:[[tile(1),tile(3),wild,tile(4),tile(10,'blue'),tile(10),tile(10,'orange')],[tile(8,'blue'),tile(8),tile(8,'orange'),tile(9,'blue')]],
    table:[[tile(1,'black'),tile(2,'black'),tile(3,'black')]],pool:[tile(2,'blue','b')],hasBroken:[true,true],playedThisTurn:[false,false]});
  return s;
}
const types=s=>s.timeline.map(event=>event.type);
function gameplay(s) {const {timeline,timelineSeq,chatAt,...rest}=s;return structuredClone(rest);}
function clock(t) {let now=10000;t.mock.method(Date,'now',()=>now);return ms=>{now+=ms;};}
const play=s=>game.handleMove({tileIds:['red-3-a','joker-0','red-1-a']},s,0);

test('new matches have one start event, fresh identity, sequence and cooldown; old history clears',()=>{
  const s=state(),old=s.timelineId;
  assert.deepEqual(types(s),['game_start']);assert.equal(s.timelineSeq,1);assert.equal(s.timeline[0].player,null);
  assert.equal(game.handleMove({action:'chat',text:'hello'},s,1),null);
  game.initGame(s,2);assert.notEqual(s.timelineId,old);assert.deepEqual(types(s),['game_start']);assert.equal(s.timelineSeq,1);assert.deepEqual(s.chatAt,{});
});
test('successful new sets produce one canonical public event with copied tile faces and no IDs',()=>{
  const s=state();assert.equal(play(s),null);
  assert.deepEqual(types(s),['game_start','play_set']);
  assert.deepEqual(s.timeline[1].data.tiles.map(t=>t.wild?'★':t.num),[1,'★',3]);
  assert.equal(s.timeline[1].player,0);assert.ok(s.timeline[1].data.tiles.every(t=>!Object.hasOwn(t,'id')));
  s.table.at(-1)[0].num=13;assert.equal(s.timeline[1].data.tiles[0].num,1);
});
test('failed game moves never write timeline events or bypass turn validation',()=>{
  for(const move of [{tileIds:['missing']},{tileIds:['red-1-a','red-4-a','blue-10-a']},{tileIds:['red-4-a'],targetSet:0}]) {
    const s=state(),before=structuredClone(s.timeline);assert.ok(game.handleMove(move,s,0));assert.deepEqual(s.timeline,before);
  }
  const s=state();assert.equal(game.handleMove({pass:true},s,1),'g_not_your_turn');assert.deepEqual(types(s),['game_start']);
});
test('adding one tile records exactly one public addition with stable target group',()=>{
  const s=state();s.hands[0].push(tile(4,'black'));assert.equal(game.handleMove({tileIds:['black-4-a'],targetSet:0},s,0),null);
  assert.deepEqual(types(s),['game_start','add_to_set']);assert.deepEqual(s.timeline[1].data,{tile:{num:4,color:'black',wild:false},targetSet:0});
});
for(const move of [{pass:true},{}])test('draw path '+JSON.stringify(move)+' emits one anonymous draw and one actual turn change',()=>{
  const s=state();assert.equal(game.handleMove(move,s,0),null);assert.deepEqual(types(s),['game_start','draw','turn']);
  assert.equal(s.timeline[1].player,0);assert.deepEqual(s.timeline[1].data,{});assert.equal(s.timeline[2].player,1);
  assert.equal(JSON.stringify(s.timeline).includes('blue-2-b'),false);assert.equal(s.currentPlayer,1);
});
test('end turn advances once and records weak end/turn events without another draw',()=>{
  const s=state();assert.equal(play(s),null);assert.equal(game.handleMove({endTurn:true},s,0),null);
  assert.deepEqual(types(s),['game_start','play_set','end_turn','turn']);assert.equal(s.currentPlayer,1);
  assert.equal(game.handleMove({endTurn:true},s,0),'g_not_your_turn');assert.equal(s.timeline.length,4);
});
test('manipulation start, cancel and rejected submit are silent; successful submit records a small summary',()=>{
  const s=state();assert.equal(game.handleMove({action:'start_manipulate'},s,0),null);
  assert.equal(game.handleMove({action:'submit',groups:[s.table[0]]},s,0),'rk_use_at_least_one_own');assert.deepEqual(types(s),['game_start']);
  assert.equal(game.handleMove({action:'cancel'},s,0),null);assert.deepEqual(types(s),['game_start']);
  game.handleMove({action:'start_manipulate'},s,0);
  assert.equal(game.handleMove({action:'submit',groups:[s.table[0],[s.hands[0][4],s.hands[0][5],s.hands[0][6]]]},s,0),null);
  assert.deepEqual(types(s),['game_start','manipulate']);assert.deepEqual(s.timeline[1].data,{usedHandTilesCount:3});
});
test('all winning play paths record one game_end; completed games can still chat',t=>{
  clock(t);
  for(const kind of ['play','add','submit']) {
    const s=state();
    if(kind==='play'){s.hands[0]=[tile(1),wild,tile(3)];assert.equal(play(s),null);}
    if(kind==='add'){s.hands[0]=[tile(4,'black')];assert.equal(game.handleMove({tileIds:['black-4-a'],targetSet:0},s,0),null);}
    if(kind==='submit'){s.hands[0]=[tile(4,'black')];game.handleMove({action:'start_manipulate'},s,0);assert.equal(game.handleMove({action:'submit',groups:[s.table[0].concat(s.hands[0])]},s,0),null);}
    assert.equal(s.phase,'over');assert.equal(s.timeline.filter(e=>e.type==='game_end').length,1);assert.deepEqual(s.timeline.at(-1).data,{winner:0});
    const before=gameplay(s);assert.equal(game.handleMove({action:'chat',text:'gg'},s,1),null);assert.deepEqual(gameplay(s),before);
    assert.equal(game.handleMove({pass:true},s,0),'g_game_over');
  }
});
test('empty-pool stalemate records a draw result without pretending a tile was drawn',()=>{
  const s=state();s.pool=[];assert.equal(game.handleMove({pass:true},s,0),null);assert.equal(game.handleMove({pass:true},s,1),null);
  assert.equal(s.winner,-1);assert.deepEqual(types(s),['game_start','turn','game_end']);assert.deepEqual(s.timeline.at(-1).data,{winner:-1});
});
test('off-turn chat normalizes whitespace and preserves every gameplay field',()=>{
  const s=state(),before=gameplay(s);assert.equal(game.handleMove({action:'chat',text:'  你\n\t 好   😂  ',player:0,name:'fake',data:{workspace:s.workspace}},s,1),null);
  assert.deepEqual(gameplay(s),before);assert.deepEqual(s.timeline.at(-1).data,{text:'你 好 😂'});assert.equal(s.timeline.at(-1).player,1);
  assert.equal(JSON.stringify(s.timeline).includes('fake'),false);
});
test('chat/reaction remain available during manipulation without touching private snapshots',t=>{
  const advance=clock(t),s=state();game.handleMove({action:'start_manipulate'},s,0);const before=gameplay(s);
  assert.equal(game.handleMove({action:'chat',text:'take your time'},s,1),null);advance(800);
  assert.equal(game.handleMove({action:'reaction',emoji:'🤔'},s,1),null);assert.deepEqual(gameplay(s),before);
});
test('empty, wrong-type and overlong chat is rejected; 120 Unicode code points are accepted',t=>{
  const advance=clock(t),s=state();
  for(const text of ['', ' \n\t ',null,{},['hello']])assert.equal(game.handleMove({action:'chat',text},s,1),'rk_chat_empty');
  for(const text of ['x'.repeat(121),'😂'.repeat(121)])assert.equal(game.handleMove({action:'chat',text},s,1),'rk_chat_too_long');
  assert.deepEqual(types(s),['game_start']);
  for(const text of ['x'.repeat(120),'😂'.repeat(120)]){assert.equal(game.handleMove({action:'chat',text},s,1),null);assert.equal(Array.from(s.timeline.at(-1).data.text).length,120);advance(800);}
});
test('shared 800ms cooldown covers chat/reactions, is per sender and rejects without adding events',t=>{
  const advance=clock(t),s=state();assert.equal(game.handleMove({action:'chat',text:'one'},s,1),null);
  assert.equal(game.handleMove({action:'reaction',emoji:'😂'},s,1),'rk_chat_too_fast');
  assert.equal(game.handleMove({action:'reaction',emoji:'😂'},s,0),null);
  advance(799);assert.equal(game.handleMove({action:'chat',text:'two'},s,1),'rk_chat_too_fast');advance(1);
  assert.equal(game.handleMove({action:'reaction',emoji:'👍'},s,1),null);assert.deepEqual(types(s),['game_start','chat','reaction','reaction']);
});
test('reaction whitelist accepts exactly the preset set and cannot serialize arbitrary Unicode or HTML',t=>{
  const advance=clock(t),s=state(),before=gameplay(s);
  for(const emoji of ['<img src=x>', '😂😂', 'hello',null,'👍🏻'])assert.equal(game.handleMove({action:'reaction',emoji},s,1),'rk_reaction_invalid');
  assert.equal(Object.hasOwn(s.chatAt,1),false);
  for(const emoji of activity.REACTIONS){assert.equal(game.handleMove({action:'reaction',emoji,player:0},s,1),null);assert.deepEqual(s.timeline.at(-1).data,{emoji});assert.equal(s.timeline.at(-1).player,1);advance(800);}
  assert.deepEqual(gameplay(s),before);
});
test('invalid senders and unstarted games cannot create social events or initialize a game',()=>{
  for(const index of [-1,4,0.5,'0',NaN]){const s=state();assert.equal(game.handleMove({action:'chat',text:'x'},s,index),'rk_chat_bad_player');assert.deepEqual(types(s),['game_start']);}
  const s=game.createState();assert.ok(game.handleMove({action:'chat',text:'x'},s,0));assert.deepEqual(s.hands,[]);assert.deepEqual(s.timeline,[]);
});
test('normal history is retained; the 500-item safety cap keeps monotonic unique sequences',t=>{
  const advance=clock(t),s=state();
  for(let i=0;i<199;i++){assert.equal(game.handleMove({action:'chat',text:String(i)},s,1),null);advance(800);}
  assert.equal(s.timeline.length,200);assert.equal(s.timeline[0].type,'game_start');
  for(let i=199;i<510;i++){game.handleMove({action:'chat',text:String(i)},s,1);advance(800);}
  assert.equal(s.timeline.length,500);assert.equal(s.timelineSeq,511);assert.equal(s.timeline[0].seq,12);assert.equal(new Set(s.timeline.map(e=>e.seq)).size,500);
});
test('public projection strips accidental private data even from draw, chat and system events',()=>{
  const privateTile={...tile(13,'blue'),hand:[tile(1)],secret:'private'};
  const timeline=[
    {seq:1,type:'draw',player:0,time:1,data:{tile:privateTile,id:'private',num:13,color:'blue'},workspace:[privateTile]},
    {seq:2,type:'chat',player:1,time:2,data:{text:'hello',savedHand:[privateTile]}},
    {seq:3,type:'play_set',player:0,time:3,data:{tiles:[privateTile],before:[privateTile]}},
    {seq:4,type:'manipulate',player:0,time:4,data:{usedHandTilesCount:2,table:[privateTile]}},
  ];
  const view=activity.publicTimeline(timeline);
  assert.deepEqual(view[0].data,{});assert.deepEqual(view[1].data,{text:'hello'});assert.deepEqual(view[2].data.tiles,[{color:'blue',num:13,wild:false}]);
  assert.deepEqual(view[3].data,{usedHandTilesCount:2});assert.equal(JSON.stringify(view).includes('private'),false);assert.equal(timeline[0].data.tile,privateTile);
});
test('client and server share the reaction whitelist and limits without a second transport',()=>{
  const context=vm.createContext({window:{}});vm.runInContext(fs.readFileSync(require.resolve('../public/js/rummikub-activity'),'utf8'),context);
  assert.deepEqual(Array.from(context.window.rummikubActivity.REACTIONS),activity.REACTIONS);assert.equal(context.window.rummikubActivity.CHAT_MAX,120);
  const client=fs.readFileSync(require.resolve('../public/js/room-client'),'utf8');assert.match(client,/window.makeGameMove = function\(data\)\s*\{\s*send\('game_move', data\)/);
});
