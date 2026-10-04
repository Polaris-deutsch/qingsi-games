const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the actual room render entry point with a result-overlay spy.
// The live browser QA also checks chat after the overlay has closed.
function harness(game) {
  const source = fs.readFileSync(path.join(__dirname, '../public/js/room-client.js'), 'utf8');
  const render = source.slice(source.indexOf('  function renderGame() {'), source.indexOf('  function showResult(winner) {'));
  const results = [], rendered = [];
  const renderer = { render: state => rendered.push(state.timelineSeq) };
  const context = vm.createContext({
    game, state: null, players: ['host', 'guest'], playerIndex: 0,
    currentRenderer: renderer, currentRendererKey: game, rummikubResultKey: null,
    rendererKeyFor: value => value, el: {boardArea: {}},
    window: {}, showResult: winner => results.push(winner),
  });
  vm.runInContext(render, context);
  return {results, rendered, update(state) {context.state = state;context.renderGame();}};
}

test('postgame Rummikub chat renders without reopening the result or resetting its timer', () => {
  const h = harness('rummikub');
  h.update({winner: 0, timelineId: 'match-a', timelineSeq: 7});
  h.update({winner: 0, timelineId: 'match-a', timelineSeq: 8});
  h.update({winner: 0, timelineId: 'match-a', timelineSeq: 9});
  assert.deepEqual(h.results, [0]);
  assert.deepEqual(h.rendered, [7, 8, 9], 'chat still reaches the feed');
  h.update({winner: null, timelineId: 'match-b', timelineSeq: 1});
  h.update({winner: 0, timelineId: 'match-b', timelineSeq: 5});
  assert.deepEqual(h.results, [0, 0], 'a new match shows its result even with the same winner');
  h.update({winner: -1, timelineId: 'match-c', timelineSeq: 3});
  assert.deepEqual(h.results, [0, 0, -1], 'a restored finished match also shows its result');
});

test('Rummikub result deduplication leaves other games on their existing render path', () => {
  const h = harness('uno');
  h.update({winner: 0});h.update({winner: 0});
  assert.deepEqual(h.results, [0, 0]);
});
