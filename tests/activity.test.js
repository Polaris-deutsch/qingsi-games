const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Activity = require('../games/lib/activity');
const Protocol = require('../public/js/activity-protocol');
function clock(t){let now=10000;t.mock.method(Date,'now',()=>now);return ms=>{now+=ms;};}
function social(state,text='hello',player=0,options={}){return Activity.handleSocialAction({action:'activity_chat',text},state,player,options);}

test('init creates only the versioned public schema and is idempotent',()=>{
  const state={currentPlayer:3};const a=Activity.init(state);assert.deepEqual(a,{version:1,seq:0,items:[]});
  Activity.push(state,{type:'demo.move',player:0,data:{value:5}});const item=a.items[0];
  assert.equal(Activity.init(state),a);assert.equal(a.items[0],item);assert.equal(a.seq,1);
  assert.deepEqual(Object.keys(state),['currentPlayer','activity']);assert.deepEqual(Object.keys(a),['version','seq','items']);
});
test('reset clears events and private cooldown without resetting configured options',t=>{
  clock(t);const state={};Activity.init(state,{maxItems:2});assert.equal(social(state).error,null);
  Activity.reset(state);assert.deepEqual(state.activity,{version:1,seq:0,items:[]});assert.equal(social(state).error,null);
  for(let i=0;i<3;i++)Activity.push(state,{type:'demo.move',data:{value:i}});assert.equal(state.activity.items.length,2);
});
test('push supplies strictly increasing sequences and server timestamps, and copies public data',t=>{
  clock(t);const state={},data={value:5,list:[1,2]};
  const item=Activity.push(state,{type:'demo.move',player:0,time:1,seq:99,data});
  assert.deepEqual(item,{seq:1,type:'demo.move',player:0,time:10000,data});data.list.push(3);assert.deepEqual(item.data.list,[1,2]);
  Activity.push(state,{type:'demo.finish',data:{}});assert.equal(state.activity.seq,2);assert.equal(state.activity.items[1].player,null);
});
test('capacity trims oldest items without renumbering; default retains 500',()=>{
  const state={};Activity.init(state,{maxItems:2});for(let i=0;i<5;i++)Activity.push(state,{type:'demo.move'});
  assert.deepEqual(state.activity.items.map(item=>item.seq),[4,5]);assert.equal(state.activity.seq,5);
  const normal={};for(let i=0;i<510;i++)Activity.push(normal,{type:'demo.move'});
  assert.equal(normal.activity.items.length,500);assert.equal(normal.activity.items[0].seq,11);assert.equal(normal.activity.seq,510);
});
test('chat normalizes whitespace, uses the authenticated seat and discards spoofed fields',()=>{
  const state={};assert.deepEqual(Activity.handleSocialAction({action:'activity_chat',text:'  hi\n\t there  ',player:3,playerIndex:3,name:'fake',private:{secret:1}},state,1,{playerCount:4}),{handled:true,error:null});
  assert.equal(state.activity.items[0].player,1);assert.deepEqual(state.activity.items[0].data,{text:'hi there'});
  assert.equal(JSON.stringify(state).includes('fake'),false);
});
test('empty and wrong-type chats are rejected without adding activity',()=>{
  const state={};Activity.init(state);for(const value of ['', ' \t ',null,{},['hello']])assert.equal(social(state,value).error,'activity_chat_empty');
  assert.equal(state.activity.seq,0);
});
test('Unicode length boundaries reject overlong messages and allow a configured limit',t=>{
  const advance=clock(t),state={};assert.equal(social(state,'😂'.repeat(120)).error,null);advance(800);
  assert.equal(social(state,'😂'.repeat(121)).error,'activity_chat_too_long');
  assert.equal(social({},'abcd',0,{chatMaxLength:3}).error,'activity_chat_too_long');
});
test('per-state, per-seat rate limits share chat/reaction cooldown and respect exact boundaries',t=>{
  const advance=clock(t),state={};assert.equal(social(state).error,null);
  assert.equal(Activity.handleSocialAction({action:'activity_reaction',emoji:'👍'},state,0).error,'activity_chat_fast');
  assert.equal(social(state,'guest',1).error,null);assert.equal(social({}).error,null);
  advance(799);assert.equal(social(state).error,'activity_chat_fast');advance(1);assert.equal(social(state).error,null);
  const custom={};assert.equal(social(custom,'a',0,{chatGapMs:50}).error,null);advance(49);assert.equal(social(custom).error,'activity_chat_fast');advance(1);assert.equal(social(custom).error,null);
});
test('init does not clear an existing private cooldown',t=>{
  clock(t);const state={};social(state);Activity.init(state);assert.equal(social(state).error,'activity_chat_fast');
});
test('default reactions are immutable and valid; custom whitelists are supported',t=>{
  const advance=clock(t),state={};assert.deepEqual(Activity.getDefaultReactions(),['😂','🤣','😎','😭','😱','🤔','😏','👍','👏','🔥','💀','❤️']);assert.ok(Object.isFrozen(Activity.DEFAULT_REACTIONS));
  for(const emoji of Activity.DEFAULT_REACTIONS){assert.equal(Activity.handleSocialAction({action:'activity_reaction',emoji},state,2).error,null);assert.deepEqual(state.activity.items.at(-1).data,{emoji});advance(800);}
  const custom={};Activity.init(custom,{reactions:['✅']});assert.equal(Activity.handleSocialAction({action:'activity_reaction',emoji:'👍'},custom,0).error,'activity_invalid_reaction');
  assert.equal(Activity.handleSocialAction({action:'activity_reaction',emoji:'✅'},custom,0).error,null);
});
test('invalid reactions do not consume cooldown or serialize arbitrary content',()=>{
  const state={};for(const emoji of ['<img>', '😂😂','👍🏻',null])assert.equal(Activity.handleSocialAction({action:'activity_reaction',emoji},state,0).error,'activity_invalid_reaction');
  assert.equal(social(state).error,null);assert.equal(state.activity.items.length,1);
});
test('social actions change only activity, even for an unrelated game state',()=>{
  const state={currentPlayer:3,hands:[[1],[2]],table:[3],phase:'editing',winner:2,playedThisTurn:true,workspace:{secret:42}};
  const before=structuredClone(state);assert.equal(social(state,'gg',0).error,null);
  const {activity,...rest}=state;assert.deepEqual(rest,before);assert.equal(activity.items.length,1);
});
test('unknown actions are unhandled and never initialize activity',()=>{
  const state={};for(const data of [null,{}, {action:'play'},{action:'message'}])assert.deepEqual(Activity.handleSocialAction(data,state,0),{handled:false});assert.deepEqual(state,{});
});
test('canonical actions and only the two previous aliases are recognized',()=>{
  for(const action of ['activity_chat','activity_reaction','chat','reaction'])assert.equal(Activity.isSocialAction({action}),true);
  for(const action of ['send_chat','emoji','message','play'])assert.equal(Activity.isSocialAction({action}),false);
  assert.equal(Activity.handleSocialAction({action:'chat',text:'old client'}, {},0).error,null);
  assert.equal(Activity.handleSocialAction({action:'reaction',emoji:'😂'}, {},0).error,null);
});
test('invalid seats and disabled social actions fail without initializing activity',()=>{
  for(const player of [-1,NaN,1.5,'0',4]){const state={};assert.equal(social(state,'a',player,{playerCount:4}).error,'activity_bad_player');assert.deepEqual(state,{});}
  const state={};assert.equal(social(state,'a',0,{enabled:false}).error,'activity_unavailable');assert.deepEqual(state,{});
});
test('private metadata never appears in enumerable state, JSON or public views',t=>{
  clock(t);const state={};social(state);const view=Activity.publicView(state);
  assert.deepEqual(Object.keys(state),['activity']);assert.deepEqual(Object.keys(view),['version','seq','items']);
  assert.equal(/socialAt|chatAt|options|reactions|chatGap/.test(JSON.stringify(state)),false);
  assert.equal(social(state).error,'activity_chat_fast');view.items[0].data.text='changed';assert.equal(state.activity.items[0].data.text,'hello');
});
test('an adapter projector defines public game fields both at push and view boundaries',()=>{
  const state={},options={projectData:(type,data)=>type==='demo.move'?{value:data.value}:null};
  Activity.push(state,{type:'demo.move',data:{value:5,secret:'hidden'}},options);assert.deepEqual(state.activity.items[0].data,{value:5});
  state.activity.items[0].data.secret='accidental';assert.deepEqual(Activity.publicView(state).items[0].data,{value:5});
  assert.equal(Activity.push(state,{type:'unknown',data:{secret:'hidden'}}),null);assert.equal(state.activity.seq,1);
});
test('invalid event envelopes do not consume a sequence',()=>{
  const state={};for(const event of [{type:''},{type:7},{type:'demo.move',player:-1},{type:'demo.move',data:[]}])assert.equal(Activity.push(state,event),null);
  assert.equal(state.activity.seq,0);
});
test('missing activity on an existing game state is initialized defensively',()=>{
  const state={currentPlayer:1,phase:'playing'};assert.equal(social(state).error,null);assert.equal(state.currentPlayer,1);assert.equal(state.activity.seq,1);
});
test('browser and server consume exactly the same protocol defaults',()=>{
  const context=vm.createContext({window:{}});vm.runInContext(fs.readFileSync(require.resolve('../public/js/activity-protocol'),'utf8'),context);
  assert.deepEqual(Array.from(context.window.ActivityProtocol.DEFAULT_REACTIONS),Activity.DEFAULT_REACTIONS);assert.equal(context.window.ActivityProtocol.CHAT_MAX_LENGTH,Protocol.CHAT_MAX_LENGTH);
});
