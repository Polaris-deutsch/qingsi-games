const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const activityDOM = require('./helpers/activity-dom');
function item(seq,type='demo.move',data={value:5}){return {seq,type,player:0,time:10000+seq,data};}
function activity(items){return {version:1,seq:items.at(-1)?.seq||0,items};}
function setup(extra={}) {
  const h=activityDOM(),mount=h.createElement(),moves=[];let names=['<player>'],formats=0;
  const options={mount,playerIndex:0,getPlayerName:index=>names[index]||'guest',
    formatEvent:(event,context)=>{formats++;return {text:context.getPlayerName(event.player)+' moved '+event.data.value,kind:'system',parts:[{text:'Value '+event.data.value,className:'demo-value'}]};},
    sendChat:text=>moves.push({chat:text}),sendReaction:emoji=>moves.push({reaction:emoji}),
    strings:{title:'Activity',send:'Send',placeholder:'Message',inputLabel:'Send a message',collapse:'Close',expand:'Open',empty:'Empty',ended:'Ended',chatEmpty:'Empty message',chatTooLong:'Too long',reactions:'Reactions',sendReaction:emoji=>'Send '+emoji,newItems:n=>n+' new'},...extra};
  const feed=h.create(options);
  return {h,mount,feed,moves,node:cls=>mount.querySelector('.'+cls),rows:()=>mount.querySelectorAll('.ga-item'),names:value=>{names=value;},get formats(){return formats;}};
}

test('shared module is passive on load and a fake game adapter can render generic events',()=>{
  const h=activityDOM();assert.equal(h.listenerCount,0);assert.equal(h.observers.length,0);assert.equal(h.timerCount,0);
  const s=setup();s.feed.update(activity([item(1)]));assert.equal(s.node('ga-title').textContent,'<player> moved 5');assert.equal(s.node('ga-mini').textContent,'Value 5');
});
test('multiple instances have unique IDs, independent drafts, callbacks, unread and roots',()=>{
  const h=activityDOM(),a=h.createElement(),b=h.createElement(),sent=[];
  const first=h.create({mount:a,playerIndex:0,sendChat:text=>sent.push(['a',text]),strings:{newItems:n=>String(n)}});
  const second=h.create({mount:b,playerIndex:1,sendChat:text=>sent.push(['b',text]),strings:{newItems:n=>String(n)}});
  first.update(activity([item(1)]));second.update(activity([item(1)]));
  const ids=[...a.querySelectorAll('*'),...b.querySelectorAll('*')].filter(node=>node.id).map(node=>node.id);assert.equal(new Set(ids).size,ids.length);
  a.querySelector('.ga-input').value='first';b.querySelector('.ga-input').value='second';a.querySelector('.ga-input').emit('keydown',{key:'Enter'});
  assert.deepEqual(sent,[['a','first']]);assert.equal(b.querySelector('.ga-input').value,'second');first.destroy();assert.equal(a.nodes.length,0);assert.equal(b.querySelectorAll('.ga-panel').length,1);second.destroy();assert.equal(h.listenerCount,0);
});
test('incremental updates preserve row identities and only format new items',()=>{
  const s=setup(),items=[item(1),item(2)];s.feed.update(activity(items));const first=s.rows()[0],input=s.node('ga-input');
  input.value='draft';input.focus();input.selectionStart=1;input.selectionEnd=3;
  s.feed.update(activity(items.concat(item(3))));s.feed.update(activity(items.concat(item(3))));
  assert.equal(s.rows().length,3);assert.equal(s.rows()[0],first);assert.equal(s.formats,3);assert.equal(s.node('ga-input'),input);assert.equal(s.h.document.activeElement,input);assert.equal(input.value,'draft');assert.equal(input.selectionStart,1);assert.equal(input.selectionEnd,3);
});
test('500-entry retention preserves overlapping rows and history scroll while appending once',()=>{
  const s=setup(),items=Array.from({length:500},(_,i)=>item(i+1));s.feed.update(activity(items));const anchor=s.rows()[299];
  s.node('ga-feed').scrollTop=4000;s.feed.update(activity(items.slice(1).concat(item(501))));s.h.flushFrames();
  assert.equal(s.rows().length,500);assert.equal(s.rows()[0].dataset.seq,'2');assert.equal(s.rows()[298],anchor);assert.equal(s.formats,501);assert.equal(s.node('ga-feed').scrollTop,3960);assert.equal(s.node('ga-unread').textContent,'1');
});
test('a disjoint retained history rebuilds statically without losing the active draft',()=>{
  const s=setup();s.feed.update(activity([item(1)]));const input=s.node('ga-input');input.value='keep';input.focus();input.selectionStart=2;
  s.feed.resetSync();s.feed.update(activity([item(501,'reaction',{emoji:'😂'}),item(502)]));
  assert.deepEqual(s.rows().map(row=>row.dataset.seq),['501','502']);assert.equal(s.mount.querySelectorAll('.ga-reaction-new').length,0);assert.equal(input.value,'keep');assert.equal(s.h.document.activeElement,input);assert.equal(input.selectionStart,2);
});
test('sequence rollback and a new reset key both clear old history, unread and draft',()=>{
  const s=setup();s.feed.update(activity([item(99)]),{resetKey:'a'});s.node('ga-input').value='old';
  s.feed.update(activity([item(1)]),{resetKey:'b'});assert.equal(s.rows().length,1);assert.equal(s.rows()[0].dataset.seq,'1');assert.equal(s.node('ga-input').value,'');
  const row=s.rows()[0];s.feed.update(activity([item(1)]),{resetKey:'c'});assert.notEqual(s.rows()[0],row,'same sequence in another match must rebuild');
  s.feed.update(activity([]));assert.equal(s.rows().length,0);assert.equal(s.node('ga-empty').hidden,false);assert.equal(s.node('ga-unread').hidden,true);
});
test('initial and reconnect histories are silent; only new reactions animate and announce',()=>{
  const s=setup();s.feed.update(activity([item(1,'reaction',{emoji:'😂'})]));assert.equal(s.mount.querySelectorAll('.ga-reaction-new').length,0);assert.equal(s.node('ga-visually-hidden').textContent,'');
  const items=[item(1,'reaction',{emoji:'😂'}),item(2,'reaction',{emoji:'👍'})];s.feed.update(activity(items));assert.equal(s.mount.querySelectorAll('.ga-reaction-new').length,1);assert.equal(s.node('ga-visually-hidden').textContent,'1 new');
  s.feed.resetSync();s.feed.update(activity(items.concat(item(3,'reaction',{emoji:'👏'}))));assert.equal(s.mount.querySelectorAll('.ga-reaction-new').length,0);assert.equal(s.node('ga-visually-hidden').textContent,'');
});
test('history reading stays put before a scroll event fires; bottom following and unread are local',()=>{
  const s=setup(),items=Array.from({length:10},(_,i)=>item(i+1));s.feed.update(activity(items));s.node('ga-feed').scrollTop=80;
  s.feed.update(activity(items.concat(item(11))));s.h.flushFrames();assert.equal(s.node('ga-feed').scrollTop,80);assert.equal(s.node('ga-latest').hidden,false);
  s.node('ga-latest').click();assert.equal(s.node('ga-unread').hidden,true);s.feed.update(activity(items.concat(item(11),item(12))));assert.equal(s.node('ga-feed').scrollTop,s.node('ga-feed').scrollHeight-s.node('ga-feed').clientHeight);
});
test('collapse, docking, disabled state and mobile keyboard controls are instance APIs',()=>{
  const s=setup({docked:false,collapsed:true});s.feed.update(activity([item(1)]));assert.equal(s.node('ga-body').hidden,true);s.feed.setCollapsed(false);assert.equal(s.node('ga-body').hidden,false);
  s.feed.setDisabled(true,'Unavailable');assert.equal(s.node('ga-input').disabled,true);assert.equal(s.node('ga-status').textContent,'Unavailable');s.node('ga-input').value='no';s.node('ga-input').emit('keydown',{key:'Enter'});assert.deepEqual(s.moves,[]);
  s.feed.setDisabled(false);s.node('ga-input').focus();s.h.window.visualViewport.height=400;s.h.window.visualViewport.emit('resize');assert.equal(s.node('ga-panel').classList.contains('ga-keyboard-open'),true);assert.equal(s.node('ga-panel').style['--ga-keyboard-bottom'],'500px');
  s.feed.setDocked(true);assert.equal(s.node('ga-panel').classList.contains('ga-docked'),true);assert.equal(s.node('ga-panel').classList.contains('ga-keyboard-open'),false);assert.equal(s.node('ga-head').getAttribute('aria-label'),'Activity');
});
test('Enter guards composing text; normalized sends await matching acknowledgements and preserve new drafts',()=>{
  const s=setup();s.feed.update(activity([]));const input=s.node('ga-input');input.value=' hi   there ';
  input.emit('keydown',{key:'Enter',isComposing:true});input.emit('keydown',{key:'Enter',keyCode:229});assert.deepEqual(s.moves,[]);
  input.emit('keydown',{key:'Enter'});assert.deepEqual(s.moves,[{chat:'hi there'}]);assert.equal(input.value,' hi   there ');
  s.feed.showError('Slow down');assert.equal(input.value,' hi   there ');assert.equal(s.node('ga-status').textContent,'Slow down');
  s.h.advance(805);input.emit('keydown',{key:'Enter'});input.value='next draft';s.feed.update(activity([item(1,'chat',{text:'hi there'})]));assert.equal(input.value,'next draft');
  s.h.advance(805);input.emit('keydown',{key:'Enter'});s.feed.update(activity([item(1,'chat',{text:'hi there'}),item(2,'chat',{text:'next draft'})]));assert.equal(input.value,'');
});
test('chat and reactions share client cooldown and use injected callbacks/configuration',()=>{
  const s=setup({reactions:['✅'],chatGapMs:100,chatMaxLength:3});s.feed.update(activity([]));assert.equal(s.mount.querySelectorAll('.ga-reaction-button').length,1);assert.equal(s.node('ga-reaction-button').getAttribute('aria-label'),'Send ✅');
  s.node('ga-input').value='😂😂😂😂';s.node('ga-input').emit('input');assert.equal(s.node('ga-input').value,'😂😂😂');s.node('ga-input').emit('keydown',{key:'Enter'});
  s.node('ga-reaction-button').emit('click');assert.equal(s.moves.length,1);s.h.advance(105);s.node('ga-reaction-button').click();assert.deepEqual(s.moves,[{chat:'😂😂😂'},{reaction:'✅'}]);
});
test('chat, player names and formatter descriptors are literal text; raw HTML formatters are unsupported',()=>{
  const payload='<img src=x onerror=alert(1)>';
  const s=setup({formatEvent:()=>({text:payload,parts:[{text:payload}]})});s.feed.update(activity([item(1),item(2,'chat',{text:payload})]));assert.equal(s.rows()[0].querySelector('.ga-title').textContent,payload);assert.equal(s.node('ga-mini').textContent,payload);assert.equal(s.node('ga-chat-text').textContent,payload);
  assert.equal(s.rows()[1].querySelector('.ga-title').textContent,'<player>');assert.equal(s.rows()[0].innerHTML,undefined);
  const raw=setup({formatEvent:()=>payload});raw.feed.update(activity([item(1)]));assert.equal(raw.node('ga-title').textContent,'demo.move');
});
test('a names version refreshes historical names without replacing row or composer nodes',()=>{
  const s=setup(),items=[item(1),item(2,'chat',{text:'hello'})];s.feed.update(activity(items),{namesVersion:'a'});const row=s.rows()[0],input=s.node('ga-input');
  s.names(['renamed']);s.feed.update(activity(items),{namesVersion:'b'});assert.equal(s.rows()[0],row);assert.equal(s.node('ga-input'),input);assert.equal(s.rows()[0].querySelector('.ga-title').textContent,'renamed moved 5');assert.equal(s.rows()[1].querySelector('.ga-title').textContent,'renamed');
});
test('destroy removes local/global listeners, observers, timers, pending frames and panel; repeated lifecycle sends once',()=>{
  const s=setup();s.feed.update(activity([item(1)]));const oldInput=s.node('ga-input');oldInput.value='hello';oldInput.emit('keydown',{key:'Enter'});assert.equal(s.h.timerCount,1);assert.ok(s.h.listenerCount>0);
  s.feed.destroy();s.feed.destroy();assert.equal(s.h.listenerCount,0);assert.equal(s.h.timerCount,0);assert.equal(s.h.frameCount,0);assert.ok(s.h.observers.every(observer=>observer.disconnected));assert.equal(s.mount.nodes.length,0);
  oldInput.emit('keydown',{key:'Enter'});s.feed.update(activity([item(2)]));assert.equal(s.moves.length,1);assert.equal(s.mount.nodes.length,0);
  const next=s.h.create({mount:s.mount,playerIndex:0,sendChat:text=>s.moves.push({chat:text})});const input=s.node('ga-input');input.value='new';input.emit('keydown',{key:'Enter'});assert.equal(s.moves.length,2);next.destroy();assert.equal(s.h.listenerCount,0);
});
test('shared sources have no game-specific selectors or transport and CSS honors reduced motion',()=>{
  const client=fs.readFileSync(require.resolve('../public/js/ui/activity-feed'),'utf8'),server=fs.readFileSync(require.resolve('../games/lib/activity'),'utf8');
  for(const source of [client,server])assert.doesNotMatch(source,/rummikub|rk-|魔力桥|Joker|牌组/);
  assert.doesNotMatch(client,/getElementById|makeGameMove|#rkHand|#rkTable|_t\(/);
  assert.match(fs.readFileSync(require.resolve('../public/style.css'),'utf8'),/@media \(prefers-reduced-motion: reduce\) \{ \.ga-reaction-new \.ga-emoji \{ animation: none;/);
});
