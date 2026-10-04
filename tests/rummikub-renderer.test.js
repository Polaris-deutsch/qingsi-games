const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const game = require('../games/rummikub');
const root = path.join(__dirname, '..');

// Run the real renderer with a minimal DOM and deterministic clock.
// Real layout and workspace interactions are additionally checked with Playwright.
function harness({ sound = null, sort = null, blockedStorage = false } = {}) {
  const ids = new Map(), timers = new Map(), events = new Map(), frames = new Map();
  const storage = new Map(sound === null ? [] : [['qingsi.rummikub.turnSound', sound]]);
  if (sort) storage.set('qingsi.rummikub.handSort', sort);
  let now = 0, timerId = 0, chimes = 0, contexts = 0;
  class Element {
    constructor() {
      this.className = ''; this.style = {setProperty(name,value){this[name]=value;}}; this.dataset = {};
      this.value='';this.scrollTop=0;this.scrollHeight=100;this.clientHeight=100;this.clientWidth=1000;
      this.listeners = {}; this.nodes = []; this.attributes = {}; this.textContent = '';
      this.classList = {
        add: (...names) => { this.className = [...new Set(this.className.split(/\s+/).filter(Boolean).concat(names))].join(' '); },
        remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
        contains: name => this.className.split(/\s+/).includes(name),
        toggle: (name,force) => {if(force)this.classList.add(name);else this.classList.remove(name);},
      };
    }
    set innerHTML(html) {
      for (const node of this.nodes) if (node.id) ids.delete(node.id);
      this.nodes = []; this.html = html;
      var box = null;
      for (const [, attrs] of html.matchAll(/<(?:div|button|span|details|summary)\b([^>]*)>/g)) {
        const node = new Element();
        node.id = (attrs.match(/\bid="([^"]*)"/) || [])[1];
        node.className = (attrs.match(/\bclass="([^"]*)"/) || [])[1] || '';
        if (node.classList.contains('rk-box')) box = node;
        node.box = box;
        node.parentElement = node.classList.contains('rk-tile') && box ? box : this;
        if (node.parentElement !== this) node.parentElement.nodes.push(node);
        for (const [, key, value] of attrs.matchAll(/data-([\w-]+)="([^"]*)"/g)) node.dataset[key] = value;
        node.style.animationDelay = (attrs.match(/animation-delay:([^";]+)/) || [])[1] || '';
        if (node.id) ids.set(node.id, node);
        this.nodes.push(node);
      }
    }
    get innerHTML() { return this.html || ''; }
    get children() { return this.nodes.filter(node => node.classList.contains('rk-tile')); }
    replaceChildren(...nodes) {this.nodes=[];for(const node of nodes)this.appendChild(node);}
    focus(){document.activeElement=this;}
    blur(){document.activeElement=null;}
    querySelectorAll(selector) {
      return this.nodes.filter(node => selector.split(',').some(part => {
        const cls = (part.trim().match(/^\.([\w-]+)/) || [])[1];
        const attr = (part.match(/\[data-([\w-]+)/) || [])[1];
        return cls && node.classList.contains(cls) && (!attr || Object.hasOwn(node.dataset, attr));
      }));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) {
      if (selector === '.rk-box') return this.box;
      if (selector === '.rk-tile, .rk-box' && (this.classList.contains('rk-tile') || this.classList.contains('rk-box'))) return this;
      return null;
    }
    contains(target) { return this === target || this.nodes.some(node => node.contains(target)); }
    getBoundingClientRect() {
      if (this.classList.contains('rk-tile')) {
        const index = this.parentElement.children.indexOf(this);
        return {left:10 + index * 43, right:48 + index * 43, top:100, bottom:154, width:38, height:54};
      }
      return {left:10, right:610, top:100, bottom:254, width:600, height:154};
    }
    cloneNode() { const node = new Element(); node.className = this.className; return node; }
    removeAttribute(name) { if (name === 'data-id') delete this.dataset.id; }
    remove() { this.parentElement.nodes = this.parentElement.nodes.filter(node => node !== this); }
    setPointerCapture(id) { this.capture = id; }
    hasPointerCapture(id) { return this.capture === id; }
    releasePointerCapture() { this.capture = null; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(node) { this.nodes.push(node); node.parentElement = this; if (node.id) ids.set(node.id, node); }
    click() {
      const event = { target: this, stopped: false, stopPropagation() {}, preventDefault() {}, stopImmediatePropagation() { this.stopped = true; } };
      events.get('click')?.(event);
      if (!event.stopped) this.listeners.click?.(event);
    }
  }
  const document = {
    getElementById: id => ids.get(id) || null,
    createElement: () => new Element(), body: new Element(), head: new Element(),
    addEventListener: (name, fn) => events.set(name, fn),
    querySelectorAll: selector => [...ids.values()].flatMap(node => node.querySelectorAll(selector)),
    querySelector: () => null,
  };
  class AudioContext {
    constructor() { contexts++; this.state = 'running'; this.currentTime = 0; }
    createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() { return { frequency: {}, connect() {}, disconnect() {}, start() { chimes++; }, stop() {} }; }
  }
  const moves = [];
  const window = {
    requestAnimationFrame: fn => { const id=++timerId;frames.set(id,fn);return id; },
    cancelAnimationFrame: id => frames.delete(id),
    AudioContext, makeGameMove: move => moves.push(move), getPlayerName: i => i === 1 ? '<guest>' : 'Player ' + i,
    localStorage: {
      getItem: key => { if (blockedStorage) throw Error('denied'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (blockedStorage) throw Error('denied'); storage.set(key, value); },
    },
  };
  const context = vm.createContext({ window, document, _t: key => key, _tf: (key, value) => key + value,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/style-utils.js'), 'utf8'), context);
  context.injectStylesOnce = window.injectStylesOnce;
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/rummikub-order.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/rummikub-activity.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/renderers/rummikub-activity.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(root, 'public/js/renderers/rummikub.js'), 'utf8'), context);
  const container = new Element(), renderer = window.gameRenderers.get('rummikub');
  renderer.init(container);
  function advance(ms) {
    const end = now + ms;
    while (true) {
      const entry = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      now = entry[1].at; timers.delete(entry[0]); entry[1].fn();
    }
    now = end;
  }
  function drag(id, beforeId, zone = 'rkHand', options = {}) {
    const el = ids.get(zone).querySelectorAll('.rk-tile').find(node => node.dataset.id === id);
    const start = el.getBoundingClientRect();
    const event = {button:0, isPrimary:true, pointerId:1, pointerType:options.touch ? 'touch' : 'mouse', cancelable:true,
      clientX:start.left+19, clientY:127, preventDefault() {}};
    el.listeners.pointerdown(event);
    const peers = el.parentElement.children.filter(node => node !== el);
    const target = beforeId === null ? peers.at(-1) : peers.find(node => node.dataset.id === beforeId);
    const box = target.getBoundingClientRect();
    if (options.vertical) event.clientY += 30;
    else event.clientX = beforeId === null ? box.right-2 : box.left+2;
    events.get('pointermove')(event);
    events.get('pointerup')(event);
    if (options.nativeClick !== false) el.click(); // A native click follows pointerup.
  }
  return { renderer, storage, moves, advance, document,
    flushFrames() { const pending=[...frames.values()];frames.clear();pending.forEach(fn=>fn()); },
    drag,
    pointerClick: id => {
      const el = ids.get('rkHand').querySelectorAll('.rk-tile').find(node => node.dataset.id === id);
      el.listeners.pointerdown({button:0, isPrimary:true, pointerId:1, pointerType:'mouse', clientX:20, clientY:120});
      events.get('pointerup')({pointerId:1}); el.click();
    },
    render: (state, index = 0) => renderer.render(state, container, index, state.winner),
    gesture: () => events.get('pointerdown')(), node: id => document.getElementById(id),
    tiles: (id, cls) => document.getElementById(id).querySelectorAll('.' + cls),
    get chimes() { return chimes; }, get contexts() { return contexts; },
  };
}
const tile = (color, num) => ({ color, num, id: `${color}-${num}-a` });
const joker = { color: 'joker', num: 0, id: 'joker-0', wild: true };
function state(count = 2) {
  return { ...game.createState(),
    hands: [[tile('red', 10), tile('blue', 10), tile('orange', 10), tile('red', 4), joker],
      ...Array.from({ length: count - 1 }, () => Array(14).fill(null))],
    table: [[tile('black', 1), tile('black', 2), tile('black', 3)]], pool: Array(20).fill(null),
    hasBroken: Array(count).fill(false), playedThisTurn: Array(count).fill(false),
  };
}
function drawn(previous) {
  const next = structuredClone(previous);
  next.hands[0].push(tile('orange', 13)); next.pool.pop(); next.currentPlayer = 1;
  return next;
}

test('turn notice triggers once on other → self, not initialization or repeated renders', () => {
  const h = harness(), s = state(4); h.render(s);
  assert.equal(h.node('rkTurnNotice').classList.contains('show'), false);
  s.currentPlayer = 3; h.render(s); s.currentPlayer = 0; h.render(s);
  assert.equal(h.node('rkTurnNotice').textContent, 'rk_your_turn');
  assert.equal(h.chimes, 0);
  h.advance(1000); h.render(s); h.advance(900);
  assert.equal(h.node('rkTurnNotice').classList.contains('show'), false);
  assert.equal(h.node('rkTurnNotice').textContent, '');
});

test('audio is gesture-gated, does not repeat and persists the Rummikub mute preference', () => {
  const h = harness(), s = state(); s.currentPlayer = 1; h.render(s);
  h.gesture(); s.currentPlayer = 0; h.render(s);
  assert.equal(h.chimes, 2); h.render(s); assert.equal(h.chimes, 2);
  h.node('rkSoundBtn').click();
  assert.equal(h.storage.get('qingsi.rummikub.turnSound'), 'off');
  assert.equal(h.node('rkSoundBtn').attributes['aria-pressed'], 'false');
  s.currentPlayer = 1; h.render(s); s.currentPlayer = 0; h.render(s);
  assert.equal(h.chimes, 2);
  const refreshed = harness({ sound: 'off' }); refreshed.gesture();
  assert.equal(refreshed.contexts, 0);
  assert.equal(refreshed.node('rkSoundBtn').textContent, 'rk_sound_off');
  refreshed.node('rkSoundBtn').click();
  assert.equal(refreshed.storage.get('qingsi.rummikub.turnSound'), 'on');
  const denied = harness({ blockedStorage: true });
  assert.doesNotThrow(() => denied.node('rkSoundBtn').click());
});

test('exactly one normal draw highlights the owner tile and expires despite rerenders', () => {
  const h = harness(), s = state(); h.render(s); const next = drawn(s); h.render(next);
  assert.deepEqual(h.tiles('rkHand', 'rk-tile--new').map(node => node.dataset.id), ['orange-13-a']);
  assert.equal(h.tiles('rkTable', 'rk-tile--new').length, 0);
  const highlighted=h.tiles('rkHand','rk-tile--new')[0];
  h.advance(700); h.render(next);
  assert.equal(h.tiles('rkHand','rk-tile--new')[0],highlighted,'unchanged sync must keep the ongoing tile animation');
  h.advance(1500); assert.equal(h.tiles('rkHand', 'rk-tile--new').length, 0);
});

test('initialization, reconnect, cancel and unrelated hand changes do not simulate draws', () => {
  const cases = [
    s => { const next = drawn(s); next.pool.push(null); return next; },
    s => { const next = drawn(s); next.hands[0].push(tile('blue', 13)); return next; },
    s => { const next = drawn(s); next.currentPlayer = 0; return next; },
    s => { const next = drawn(s); next.hands[0].shift(); return next; },
    s => { const next = structuredClone(s); next.currentPlayer = 1; return next; },
  ];
  for (const change of cases) {
    const h = harness(), s = state(); h.render(s); h.render(change(s));
    assert.equal(h.tiles('rkHand', 'rk-tile--new').length, 0);
  }
  const h = harness(), s = state(); h.render(drawn(s));
  assert.equal(h.tiles('rkHand', 'rk-tile--new').length, 0);
  h.render(s); h.renderer.resetFeedback(); h.render(drawn(s));
  assert.equal(h.tiles('rkHand', 'rk-tile--new').length, 0);
  const own = state(); h.render(own); own.phase = 'manipulate'; h.render(own);
  own.phase = 'play'; h.render(own);
  assert.equal(h.tiles('rkHand', 'rk-tile--new').length, 0);
  assert.equal(h.tiles('rkTable', 'rk-tile--played').length, 0);
});

test('successful plays highlight only hand → table tiles, including consecutive plays and jokers', () => {
  const h = harness(), s = state(); h.render(s);
  assert.equal(game.handleMove({ tileIds: s.hands[0].slice(0, 3).map(tile => tile.id) }, s, 0), null); h.render(s);
  assert.equal(h.tiles('rkTable', 'rk-tile--played').length, 3); h.advance(800);
  assert.equal(game.handleMove({ tileIds: [joker.id], targetSet: 0 }, s, 0), null); h.render(s);
  assert.equal(h.tiles('rkTable', 'rk-tile--played').length, 4); h.advance(700);
  assert.deepEqual(h.tiles('rkTable', 'rk-tile--played').map(node => node.dataset.id), [joker.id]);
  h.advance(800); assert.equal(h.tiles('rkTable', 'rk-tile--played').length, 0);
});

test('manipulate submit highlights contributions, while cancel/rejected moves never highlight old table tiles', () => {
  const h = harness(), s = state(); s.hasBroken[0] = true; h.render(s);
  assert.equal(game.handleMove({ action: 'start_manipulate' }, s, 0), null); h.render(s);
  assert.equal(h.node('rkHandWrap').hidden, true);
  const groups = [s.table[0], s.hands[0].slice(0, 3)];
  assert.equal(game.handleMove({ action: 'submit', groups }, s, 0), null); h.render(s);
  assert.equal(h.node('rkHandWrap').hidden, false);
  assert.deepEqual(h.tiles('rkTable', 'rk-tile--played').map(node => node.dataset.id), groups[1].map(tile => tile.id));
  h.renderer.resetFeedback(); h.render(s);
  assert.equal(game.handleMove({ action: 'start_manipulate' }, s, 0), null); h.render(s);
  assert.equal(game.handleMove({ action: 'cancel' }, s, 0), null); h.render(s);
  assert.equal(h.tiles('rkTable', 'rk-tile--played').length, 0);
  assert.notEqual(game.handleMove({ tileIds: ['missing'] }, s, 0), null); h.render(s);
  assert.equal(h.tiles('rkTable', 'rk-tile--played').length, 0);
});

test('winning tiles highlight; terminal games and seat changes do not trigger turn notices', () => {
  const h = harness(), s = state(); s.hands[0] = s.hands[0].slice(0, 3); h.render(s);
  assert.equal(game.handleMove({ tileIds: s.hands[0].map(tile => tile.id) }, s, 0), null); h.render(s);
  assert.equal(h.tiles('rkTable', 'rk-tile--played').length, 3);
  s.currentPlayer = 1; h.render(s); s.currentPlayer = 0; h.render(s);
  assert.equal(h.node('rkTurnNotice').classList.contains('show'), false);
  h.renderer.resetFeedback(); const other = state(); other.currentPlayer = 1; h.render(other);
  other.currentPlayer = 0; other.hands[1] = [tile('blue', 1)]; h.render(other, 1);
  assert.equal(h.node('rkTurnNotice').classList.contains('show'), false);
});

test('manipulation selects multiple tiles within one box before moving them to a different box', () => {
  const h = harness(), s = state(); s.phase = 'manipulate'; h.render(s);
  for (const id of ['red-10-a', 'blue-10-a', 'orange-10-a']) {
    h.tiles('rkTable', 'rk-tile').find(node => node.dataset.id === id).click();
  }
  assert.equal(h.tiles('rkTable', 'selected').length, 3);
  h.node('rkTable').querySelector('.rk-box-new').click();
  h.node('rkSubmitBtn').click();
  assert.equal(h.moves.length, 1);
  assert.equal(h.moves[0].action, 'submit');
  assert.deepEqual(Array.from(h.moves[0].groups[1], tile => tile.id), ['blue-10-a', 'red-10-a', 'orange-10-a']);
});

test('active-player cards include self, escape names and do not read concealed hands', () => {
  const h = harness(), s = state(4); h.render(s);
  assert.equal(h.node('rkOpps').querySelectorAll('.rk-opp').length, 4);
  assert.equal(h.node('rkOpps').querySelectorAll('.active').length, 1);
  assert.match(h.node('rkOpps').innerHTML, /&lt;guest&gt;/);
  assert.equal(h.tiles('rkHand', 'rk-tile').length, s.hands[0].length);
});

test('shared client resets feedback at lifecycle boundaries and scopes the layout to Rummikub', () => {
  const client = fs.readFileSync(path.join(root, 'public/js/room-client.js'), 'utf8');
  assert.match(client, /function resetRummikubFeedback\(\)[\s\S]*?game === 'rummikub'/);
  for (const prefix of ['game_started(msg) {', 'function handleRoomJoined(msg) {', 'ws.onclose = () => {', 'function showLobby() {']) {
    const start = client.indexOf(prefix); assert.ok(start >= 0);
    assert.match(client.slice(start, start + 250), /resetRummikubFeedback\(\)/);
  }
  assert.match(client, /if \(game === 'rummikub'\) document.body.classList.add\('rk-playing'\)/);
});

function handIds(h, zone = 'rkHand') { return h.tiles(zone, 'rk-tile').map(tile => tile.dataset.id); }

test('normal clicks only select; genuine pointer reorder enables manual without selecting the dragged tile', () => {
  const h = harness(), s = state(); h.render(s);
  assert.deepEqual(handIds(h), ['red-4-a','blue-10-a','red-10-a','orange-10-a','joker-0']);
  h.tiles('rkHand','rk-tile')[0].click();
  assert.equal(h.tiles('rkHand','selected').length,1);
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_auto_number ▾');
  h.drag('joker-0','red-4-a');
  assert.deepEqual(handIds(h),['joker-0','red-4-a','blue-10-a','red-10-a','orange-10-a']);
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_manual ▾');
  assert.equal(h.tiles('rkHand','selected').length,1);
  assert.equal(h.moves.length,0,'visual ordering must not send game moves');
});

test('a drag ending at the same slot keeps auto mode; auto button restores sorting without clearing selection', () => {
  const h=harness(),s=state();h.render(s);
  h.drag('red-4-a','blue-10-a');
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_auto_number ▾');
  h.advance(400);
  h.tiles('rkHand','rk-tile')[0].click();
  h.drag('joker-0','red-4-a');
  h.node('rkAutoHandBtn').click();
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_auto_number ▾');
  assert.deepEqual(handIds(h),['red-4-a','blue-10-a','red-10-a','orange-10-a','joker-0']);
  assert.equal(h.tiles('rkHand','selected').length,1);
});

test('a fresh click immediately after a rebuilt drag is not swallowed by drag click suppression', () => {
  const h=harness(),s=state();h.render(s);
  h.drag('joker-0','red-4-a','rkHand',{nativeClick:false});
  h.pointerClick('red-4-a');
  assert.deepEqual(h.tiles('rkHand','selected').map(tile=>tile.dataset.id),['red-4-a']);
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_manual ▾');
});

test('vertical touch gestures keep automatic order; horizontal touch reorders without selecting', () => {
  const h=harness(),s=state();h.render(s);const before=handIds(h);
  h.drag('joker-0','red-4-a','rkHand',{touch:true,vertical:true,nativeClick:false});
  assert.deepEqual(handIds(h),before);
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_auto_number ▾');
  h.drag('joker-0','red-4-a','rkHand',{touch:true});
  assert.deepEqual(handIds(h),['joker-0',...before.filter(id=>id!=='joker-0')]);
  assert.equal(h.tiles('rkHand','selected').length,0);
});

test('manual renderer order survives server reshuffling, opponent turns and same-page reconnect', () => {
  const h=harness(),s=state();h.render(s);h.drag('joker-0','red-4-a');
  const expected=handIds(h);s.hands[0].reverse();s.currentPlayer=1;h.render(s);
  assert.deepEqual(handIds(h),expected);
  h.renderer.resetFeedback();h.render(structuredClone(s));
  assert.deepEqual(handIds(h),expected);
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_manual ▾');
});

test('manual draw appends while auto draw inserts, with ID-based highlighting correct in both modes', () => {
  for (const manual of [false,true]) {
    const h=harness(),s=state();h.render(s);
    if(manual)h.drag('joker-0','red-4-a');
    const before=handIds(h),next=drawn(s);
    next.hands[0][next.hands[0].length-1]=tile('black',1);
    h.render(next);
    assert.deepEqual(handIds(h),manual?[...before,'black-1-a']:['black-1-a',...before]);
    assert.deepEqual(h.tiles('rkHand','rk-tile--new').map(tile=>tile.dataset.id),['black-1-a']);
  }
});

test('manual order seeds manipulate, survives cancel and filters contributed tiles after submit', () => {
  const h=harness(),s=state();h.render(s);h.drag('joker-0','red-4-a');
  const expected=handIds(h);s.hasBroken[0]=true;
  assert.equal(game.handleMove({action:'start_manipulate'},s,0),null);h.render(s);
  const workspaceHand=()=>h.tiles('rkTable','rk-tile').filter(tile=>tile.box?.dataset.hand).map(tile=>tile.dataset.id);
  assert.deepEqual(workspaceHand(),expected);
  assert.equal(game.handleMove({action:'cancel'},s,0),null);h.render(s);
  assert.deepEqual(handIds(h),expected);
  assert.equal(game.handleMove({action:'start_manipulate'},s,0),null);h.render(s);
  const groups=[s.table[0],s.hands[0].filter(tile=>tile.num===10)];
  assert.equal(game.handleMove({action:'submit',groups},s,0),null);h.render(s);
  assert.deepEqual(handIds(h),expected.filter(id=>!id.includes('-10-')));
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_manual ▾');
  assert.equal(h.tiles('rkTable','rk-tile--played').length,3);
});

test('workspace hand drag preserves temporarily placed tile slots when manipulation is canceled', () => {
  const h=harness(),s=state();s.hasBroken[0]=true;h.render(s);h.drag('joker-0','red-4-a');
  assert.equal(game.handleMove({action:'start_manipulate'},s,0),null);h.render(s);
  h.tiles('rkTable','rk-tile').find(tile=>tile.dataset.id==='red-4-a').click();
  h.tiles('rkTable','rk-tile').find(tile=>tile.dataset.id==='black-1-a').click();
  h.drag('orange-10-a','joker-0','rkTable');
  assert.equal(game.handleMove({action:'cancel'},s,0),null);h.render(s);
  assert.deepEqual(handIds(h),['orange-10-a','red-4-a','joker-0','blue-10-a','red-10-a']);
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_manual ▾');
});

test('explicit table tidy is independent of hand mode, preserves set indices and submit supersedes old overrides', () => {
  const h=harness(),s=state();s.table[0].reverse();s.hasBroken[0]=true;h.render(s);
  h.drag('joker-0','red-4-a');const hand=handIds(h);
  h.node('rkArrangeTableBtn').click();
  assert.deepEqual(h.tiles('rkTable','rk-tile').map(tile=>tile.dataset.id),['black-1-a','black-2-a','black-3-a']);
  assert.deepEqual(s.table[0].map(tile=>tile.id),['black-3-a','black-2-a','black-1-a'],'tidy cannot mutate server state');
  assert.deepEqual(handIds(h),hand);
  assert.equal(game.handleMove({action:'start_manipulate'},s,0),null);h.render(s);
  assert.equal(game.handleMove({action:'cancel'},s,0),null);h.render(s);
  assert.deepEqual(h.tiles('rkTable','rk-tile').map(tile=>tile.dataset.id),['black-1-a','black-2-a','black-3-a']);
  assert.equal(game.handleMove({action:'start_manipulate'},s,0),null);h.render(s);
  const groups=[s.table[0],s.hands[0].filter(tile=>tile.num===10).reverse()];
  assert.equal(game.handleMove({action:'submit',groups},s,0),null);h.render(s);
  assert.deepEqual(h.tiles('rkTable','rk-tile').slice(0,3).map(tile=>tile.dataset.id),['black-3-a','black-2-a','black-1-a']);
  h.render(s);
  assert.deepEqual(h.tiles('rkTable','rk-tile').slice(0,3).map(tile=>tile.dataset.id),['black-3-a','black-2-a','black-1-a']);
});

test('color preference persists, but starting a new game or changing seat resets manual IDs', () => {
  const h=harness({sort:'color'}),s=state();h.render(s);
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_auto_color ▾');
  h.node('rkOrderNumberBtn').click();assert.equal(h.storage.get('qingsi.rummikub.handSort'),'number');
  h.drag('joker-0','red-4-a');h.renderer.resetHandOrder();h.render(s);
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_auto_number ▾');
  h.drag('joker-0','red-4-a');
  s.hands[1]=[tile('black',9),tile('blue',1)];h.render(s,1);
  assert.deepEqual(handIds(h),['blue-1-a','black-9-a']);
  assert.equal(h.node('rkOrderSummary').textContent,'rk_order_auto_number ▾');
});

test('another player’s submitted order supersedes local table tidy even with unchanged group membership', () => {
  const h=harness(),s=state();s.table[0].reverse();s.currentPlayer=1;h.render(s);
  h.node('rkArrangeTableBtn').click();
  assert.deepEqual(handIds(h,'rkTable'),['black-1-a','black-2-a','black-3-a']);
  s.phase='manipulate';h.render(s);
  s.phase='play';s.table[0]=[s.table[0][1],s.table[0][0],s.table[0][2]];h.render(s);
  assert.deepEqual(handIds(h,'rkTable'),['black-2-a','black-3-a','black-1-a']);
});

function activityState() {
  const s=state();s.timelineId='match-test';s.timelineSeq=1;
  s.timeline=[{seq:1,type:'game_start',player:null,time:1000,data:{}}];return s;
}
function event(s,type,player,data={}) {s.timeline.push({seq:++s.timelineSeq,type,player,time:1000+s.timelineSeq,data});}

test('off-turn incoming/own chats preserve manual order, selection, input identity, focus and cursor', () => {
  const h=harness(),s=activityState();h.render(s);h.drag('joker-0','red-4-a');h.pointerClick('red-4-a');
  const order=handIds(h),tile=h.tiles('rkHand','rk-tile')[0],input=h.node('rkChatInput');input.value='还没写完';input.focus();input.selectionStart=2;input.selectionEnd=3;
  event(s,'chat',1,{text:'hello'});h.render(s);
  assert.deepEqual(handIds(h),order);assert.equal(h.tiles('rkHand','rk-tile')[0],tile);assert.equal(h.node('rkChatInput'),input);
  assert.equal(h.document.activeElement,input);assert.equal(input.value,'还没写完');assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,3);
  event(s,'chat',0,{text:'other device'});h.render(s);assert.deepEqual(handIds(h),order);assert.equal(h.tiles('rkHand','selected').length,1);
});

test('activity appends stable nodes once; reconnect renders unseen historical reactions without animations or sound', () => {
  const h=harness(),s=activityState();h.render(s);const first=h.node('rkFeed').querySelector('.rk-event');
  event(s,'reaction',1,{emoji:'😂'});h.render(s);assert.equal(h.node('rkFeed').querySelectorAll('.rk-reaction-new').length,1);
  h.render(s);assert.equal(h.node('rkFeed').querySelectorAll('.rk-event').length,2);assert.equal(h.node('rkFeed').querySelector('.rk-event'),first);
  h.renderer.resetFeedback();event(s,'reaction',1,{emoji:'👍'});h.render(s);
  assert.equal(h.node('rkFeed').querySelectorAll('.rk-reaction-new').length,0);assert.equal(h.chimes,0);assert.equal(h.node('rkFeedAnnouncement').textContent,'');
  s.timelineId='new-match';s.timelineSeq=1;s.timeline=s.timeline.slice(0,1);h.render(s);
  assert.equal(h.node('rkFeed').querySelectorAll('.rk-event').length,1);
});

test('history scrolling stays put on new events, exposes unread and scrolls only when requested or already near bottom', () => {
  const h=harness(),s=activityState();h.render(s);const feed=h.node('rkFeed');feed.scrollHeight=1000;feed.clientHeight=100;feed.scrollTop=100;
  event(s,'chat',1,{text:'new'});h.render(s);h.flushFrames();assert.equal(feed.scrollTop,100,'a pending layout callback must not override history scroll before its scroll event arrives');assert.equal(h.node('rkActivityUnread').textContent,'1');assert.equal(h.node('rkFeedLatest').hidden,false);
  h.renderer.resetFeedback();event(s,'reaction',1,{emoji:'👍'});h.render(s);assert.equal(feed.scrollTop,100,'reconnect should preserve history reading position');
  h.node('rkFeedLatest').click();assert.equal(feed.scrollTop,1000);assert.equal(h.node('rkActivityUnread').hidden,true);
  event(s,'turn',0);h.render(s);assert.equal(feed.scrollTop,1000);assert.equal(h.node('rkActivityUnread').hidden,true);
});

test('chat input Enter sends through makeGameMove, guards IME, keeps rejected drafts and clears only matching successful drafts', () => {
  const h=harness(),s=activityState();s.currentPlayer=1;h.render(s);const input=h.node('rkChatInput');input.value='  你好  ';
  const key={key:'Enter',isComposing:true,stopPropagation(){},preventDefault(){}};input.listeners.keydown(key);assert.equal(h.moves.length,0);
  key.isComposing=false;input.listeners.keydown(key);assert.deepEqual(JSON.parse(JSON.stringify(h.moves[0])),{action:'chat',text:'你好'});assert.equal(input.value,'  你好  ');
  h.renderer.activityError('rk_chat_too_fast','wait');assert.equal(input.value,'  你好  ');assert.equal(h.node('rkChatStatus').textContent,'wait');
  h.advance(805);input.listeners.keydown(key);event(s,'chat',0,{text:'你好'});h.render(s);assert.equal(input.value,'');
  h.advance(805);input.value='sent';input.listeners.keydown(key);input.value='next draft';event(s,'chat',0,{text:'sent'});h.render(s);assert.equal(input.value,'next draft');
});

test('chat text and names are literal text nodes, never interpolated markup', () => {
  const h=harness(),s=activityState();const payload='<img src=x onerror=alert(1)><script>1</script>';event(s,'chat',1,{text:payload});h.render(s);
  const row=h.node('rkFeed').querySelectorAll('.rk-event').at(-1);
  assert.equal(row.querySelector('.rk-event-chat-text').textContent,payload);assert.equal(row.querySelector('.rk-event-title').textContent,'<guest>');
  assert.equal(row.innerHTML,'');assert.equal(h.moves.length,0);
});

test('matches from an older running server disable social actions instead of sending an unsupported game move', () => {
  const h=harness(),s=state();delete s.timelineId;delete s.timeline;h.render(s);
  assert.equal(h.node('rkChatSend').disabled,true);assert.equal(h.node('rkChatInput').disabled,true);
  assert.equal(h.node('rkReactionToggle').disabled,true);assert.equal(h.node('rkChatStatus').textContent,'rk_chat_unavailable');
  h.node('rkChatInput').value='hello';h.node('rkChatInput').listeners.keydown({key:'Enter',stopPropagation(){},preventDefault(){}});
  h.node('rkReactionPicker').querySelectorAll('.rk-reaction-button')[0].click();
  assert.deepEqual(h.moves,[]);assert.equal(h.tiles('rkHand','rk-tile').length,s.hands[0].length,'existing game UI still works');
});

test('chat updates leave locally edited manipulation boxes and selection intact', () => {
  const h=harness(),s=activityState();s.hasBroken[0]=true;h.render(s);game.handleMove({action:'start_manipulate'},s,0);h.render(s);
  h.tiles('rkTable','rk-tile').find(tile=>tile.dataset.id==='red-4-a').click();
  const selected=h.tiles('rkTable','selected')[0];event(s,'chat',1,{text:'thinking'});h.render(s);
  assert.equal(h.tiles('rkTable','selected')[0],selected);assert.equal(h.node('rkHandWrap').hidden,true);
});
