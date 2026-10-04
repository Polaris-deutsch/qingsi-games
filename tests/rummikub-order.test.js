const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const order = require('../public/js/rummikub-order');
const game = require('../games/rummikub');
const tile = (num, color = 'red', copy = 'a') => Object.freeze({num, color, id:`${color}-${num}-${copy}`});
const joker = index => Object.freeze({num:0, color:'joker', wild:true, id:'joker-'+index});
const ids = tiles => tiles.map(tile => tile.id);
const nums = tiles => tiles.map(tile => tile.wild ? '★' : tile.num);

 test('hand auto-order is number first, then fixed color, then identity; inputs stay unchanged', () => {
  const hand = Object.freeze([tile(3),tile(1,'orange'),tile(2),tile(1,'red'),tile(1,'blue'),tile(1,'black','b'),tile(1,'black')]);
  assert.deepEqual(ids(order.sortHandByNumber(hand)), ['black-1-a','black-1-b','blue-1-a','red-1-a','orange-1-a','red-2-a','red-3-a']);
  assert.deepEqual(nums(order.sortHandByNumber([tile(3),tile(1),tile(2)])),[1,2,3]);
  assert.equal(hand[0].num,3);
});

test('color-first is independent, and hand jokers follow every real tile deterministically', () => {
  const hand = Object.freeze([joker(1),tile(1,'red'),tile(9,'black'),joker(0),tile(2,'blue')]);
  assert.deepEqual(ids(order.sortHandByColor(hand)), ['black-9-a','blue-2-a','red-1-a','joker-0','joker-1']);
  assert.deepEqual(nums(order.sortHandByNumber(hand)), [1,2,9,'★','★']);
});

test('auto → real reorder → manual; unchanged/invalid reorder cannot enable manual', () => {
  const model = new order.HandOrder(), hand=[tile(3),tile(1),tile(2)];
  assert.equal(model.mode,'auto-number');
  assert.equal(model.reorder(hand,'red-1-a','red-2-a'),false);
  assert.equal(model.reorder(hand,'missing',null),false);
  assert.equal(model.reorder(hand,'red-1-a','red-1-a'),false);
  assert.equal(model.mode,'auto-number');
  assert.equal(model.reorder(hand,'red-3-a','red-1-a'),true);
  assert.equal(model.mode,'manual');
  assert.deepEqual(nums(model.resolveDisplayHand(hand)),[3,1,2]);
  assert.deepEqual(model.manualHandOrder,['red-3-a','red-1-a','red-2-a']);
});

test('manual survives identical sync and changed server array order', () => {
  const model=new order.HandOrder(), hand=[tile(1),tile(3),tile(5),tile(7),tile(9)];
  model.reorder(hand,'red-9-a','red-3-a');
  assert.deepEqual(nums(model.resolveDisplayHand(structuredClone(hand))),[1,9,3,5,7]);
  assert.deepEqual(nums(model.resolveDisplayHand(hand.slice().reverse())),[1,9,3,5,7]);
});

test('manual appends new tiles, removes played IDs and retains every remaining relative position', () => {
  const model=new order.HandOrder(), hand=[tile(1),tile(3),tile(5),tile(7),tile(9)];
  model.reorder(hand,'red-9-a','red-3-a');
  const drawn=[tile(2),...hand];
  assert.deepEqual(nums(model.resolveDisplayHand(drawn)),[1,9,3,5,7,2]);
  assert.deepEqual(nums(model.resolveDisplayHand(drawn.filter(tile=>![3,7].includes(tile.num)))),[1,9,5,2]);
  assert.deepEqual(model.manualHandOrder,['red-1-a','red-9-a','red-5-a','red-2-a']);
});

test('explicit auto restores automatic sorting for subsequent draws; resets never reuse another game order', () => {
  const model=new order.HandOrder(), hand=[tile(1),tile(3),tile(5)];
  model.reorder(hand,'red-5-a','red-1-a'); model.setAuto();
  assert.equal(model.mode,'auto-number'); assert.deepEqual(model.manualHandOrder,[]);
  assert.deepEqual(nums(model.resolveDisplayHand([...hand,tile(2)])),[1,2,3,5]);
  model.setAuto('color'); assert.equal(model.mode,'auto-color');
  model.reorder(hand,'red-5-a','red-1-a'); model.reset('color');
  assert.equal(model.mode,'auto-color'); assert.deepEqual(model.manualHandOrder,[]);
});

test('reconciliation discards stale and duplicate IDs without duplicating any live tile', () => {
  assert.deepEqual(order.reconcileManualOrder([tile(1),tile(2),tile(3)], ['stale','red-3-a','red-3-a','red-1-a']), ['red-3-a','red-1-a','red-2-a']);
});

for(const [name, input, expected] of [
  ['plain run',[tile(7),tile(5),tile(6)],[5,6,7]],
  ['Joker fills 2',[tile(1),tile(3),joker(0)],[1,'★',3]],
  ['Joker fills 11',[tile(9,'blue'),tile(10,'blue'),tile(12,'blue'),joker(0)],[9,10,'★',12]],
  ['Joker fills 3',[tile(4),joker(0),tile(2),tile(1)],[1,2,'★',4]],
  ['bounded by 13',[tile(12),tile(13),joker(0)],['★',12,13]],
  ['bounded by 1',[tile(1),tile(2),joker(0)],[1,2,'★']],
  ['prefer right extension',[joker(0),tile(6),tile(5)],[5,6,'★']],
  ['two jokers',[tile(6),joker(1),tile(3),joker(0)],[3,'★','★',6]],
]) test('canonical run: '+name,()=>{
  const frozen=Object.freeze(input.slice());
  const normalized=order.normalizeRunOrder(frozen);
  assert.deepEqual(nums(normalized),expected);
  assert.deepEqual(ids(order.normalizeRunOrder(frozen.slice().reverse())),ids(normalized));
  assert.deepEqual(ids(order.normalizeRunOrder(normalized)),ids(normalized));
  assert.deepEqual(ids(frozen),ids(input));
  for(const result of normalized)assert.ok(frozen.includes(result),'keep original tile object and values');
});

test('all displayable one/two-Joker runs fit 1–13 and are independent of original array order',()=>{
  let checked=0;
  for(let mask=1;mask<(1<<13);mask++) {
    const real=[];
    for(let bit=0;bit<13;bit++)if(mask&(1<<bit))real.push(tile(bit+1));
    for(const wilds of [1,2]) {
      const input=real.concat(Array.from({length:wilds},(_,i)=>joker(i)));
      if(!order.isRunLike(input))continue;
      const result=order.normalizeRunOrder(input), reversed=order.normalizeRunOrder(input.slice().reverse());
      assert.deepEqual(ids(result),ids(reversed));
      const firstReal=result.findIndex(t=>!t.wild),start=result[firstReal].num-firstReal;
      assert.ok(start>=1 && start+result.length-1<=13);
      result.forEach((tile,index)=>{if(!tile.wild)assert.equal(tile.num,start+index);});
      assert.equal(new Set(ids(result)).size,input.length);
      checked++;
    }
  }
  assert.ok(checked>500,'exercise many interval/gap patterns');
});

test('same-number groups use fixed colors; Joker stays last without run inference',()=>{
  const group=Object.freeze([tile(6,'orange'),joker(1),tile(6,'black'),tile(6,'red')]);
  assert.deepEqual(ids(order.normalizeTableSet(group)),['black-6-a','red-6-a','orange-6-a','joker-1']);
  assert.equal(order.isGroupLike(group),true);
  assert.equal(order.isRunLike(group),false);
});

test('incomplete/invalid workspace groups remain unchanged instead of guessing tile values',()=>{
  for(const input of [[tile(1),tile(5),joker(0)],[tile(1),tile(1,'red','b'),joker(0)],[tile(1),joker(0),joker(1)],[joker(0),joker(1)],[tile(1,'red'),tile(2,'blue'),tile(3,'red')]]) {
    assert.deepEqual(ids(order.normalizeTableSet(input)),ids(input));
  }
});

function state(hand) {
  return {...game.createState(),hands:[hand,[tile(4,'black')]],pool:[],hasBroken:[true,true],playedThisTurn:[false,false],requireBreak:true};
}

test('normal new groups and additions are canonical on the server without changing group indices',()=>{
  const s=state([tile(1),tile(3),joker(0),tile(4),tile(8,'blue')]);
  s.table=[[tile(7,'black'),tile(8,'black'),tile(9,'black')]];
  const first=s.table[0];
  assert.equal(game.handleMove({tileIds:['red-3-a','joker-0','red-1-a']},s,0),null);
  assert.deepEqual(nums(s.table[1]),[1,'★',3]);
  assert.equal(s.table[0],first);
  assert.equal(game.handleMove({tileIds:['red-4-a'],targetSet:1},s,0),null);
  assert.deepEqual(nums(s.table[1]),[1,'★',3,4]);
  assert.equal(s.table[0],first);
});

test('manipulate submit preserves the explicit tile order, while server hand sorting stays unchanged',()=>{
  const s=state([tile(4),tile(1,'blue')]);
  s.table=[[tile(1),tile(2),tile(3)]];
  assert.equal(game.handleMove({action:'start_manipulate'},s,0),null);
  const requested=[tile(4),tile(2),tile(1),tile(3)];
  assert.equal(game.handleMove({action:'submit',groups:[requested]},s,0),null);
  assert.deepEqual(ids(s.table[0]),ids(requested));
  assert.deepEqual(ids(s.hands[0]),['blue-1-a']);
});

test('sorting changes neither the 30-point break, Joker score, nor invalid-run decisions',()=>{
  const low=state([tile(1),tile(1,'blue'),tile(1,'black'),tile(10)]);low.hasBroken[0]=false;
  assert.equal(game.handleMove({tileIds:ids(low.hands[0].slice(0,3))},low,0),'rk_need_break_ice');
  assert.equal(low.table.length,0);
  const wild=state([tile(1),tile(3),joker(0),tile(10)]);wild.hasBroken[0]=false;
  assert.equal(game.handleMove({tileIds:['red-1-a','red-3-a','joker-0']},wild,0),null);
  assert.equal(wild.hasBroken[0],true);
  const invalid=state([tile(1),tile(5),joker(0),tile(10)]);
  assert.equal(game.handleMove({tileIds:['red-1-a','red-5-a','joker-0']},invalid,0),'rk_cannot_form_set');
  assert.equal(invalid.table.length,0);
});

test('browser and Node use the same pure ordering helper loaded before the Rummikub renderer',()=>{
  const root=path.join(__dirname,'..'),context=vm.createContext({window:{}});
  vm.runInContext(fs.readFileSync(path.join(root,'public/js/rummikub-order.js'),'utf8'),context);
  assert.equal(typeof context.window.rummikubOrder.normalizeTableSet,'function');
  const input=[tile(1),tile(3),joker(0)];
  assert.deepEqual(Array.from(context.window.rummikubOrder.normalizeTableSet(input),tile=>tile.id),ids(order.normalizeTableSet(input)));
  const html=fs.readFileSync(path.join(root,'public/game.html'),'utf8');
  assert.ok(html.indexOf('/js/rummikub-order.js')<html.indexOf('/js/renderers/rummikub.js'));
});
