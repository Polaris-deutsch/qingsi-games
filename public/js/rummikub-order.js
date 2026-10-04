// Pure visual ordering shared by Rummikub's renderer and normal table writes.
// These helpers never validate moves, change tile values or mutate input arrays.
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.rummikubOrder = api;
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';
  var COLORS = ['black', 'blue', 'red', 'orange'];
  function byId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
  function byColor(a, b) { return COLORS.indexOf(a.color) - COLORS.indexOf(b.color); }
  function compareHand(a, b, colorFirst) {
    if (!!a.wild !== !!b.wild) return a.wild ? 1 : -1;
    if (a.wild) return byId(a, b);
    return (colorFirst ? byColor(a, b) || a.num - b.num : a.num - b.num || byColor(a, b)) || byId(a, b);
  }
  function sortHandByNumber(hand) {
    return hand.slice().sort(function(a, b) { return compareHand(a, b, false); });
  }
  function sortHandByColor(hand) {
    return hand.slice().sort(function(a, b) { return compareHand(a, b, true); });
  }
  function reconcileManualOrder(hand, order) {
    var present = new Set(hand.map(function(tile) { return tile.id; }));
    var seen = new Set();
    var ids = [];
    order.concat(hand.map(function(tile) { return tile.id; })).forEach(function(id) {
      if (present.has(id) && !seen.has(id)) { ids.push(id); seen.add(id); }
    });
    return ids;
  }
  function tilesInOrder(hand, ids) {
    var tiles = new Map(hand.map(function(tile) { return [tile.id, tile]; }));
    return ids.map(function(id) { return tiles.get(id); });
  }
  function sameIds(a, b) {
    return a.length === b.length && a.every(function(id, i) { return id === b[i]; });
  }
  function reorderTiles(tiles, id, beforeId) {
    var ids = tiles.map(function(tile) { return tile.id; });
    if (ids.indexOf(id) < 0 || beforeId === id || (beforeId !== null && ids.indexOf(beforeId) < 0)) return tiles.slice();
    var rest = ids.filter(function(value) { return value !== id; });
    rest.splice(beforeId === null ? rest.length : rest.indexOf(beforeId), 0, id);
    return tilesInOrder(tiles, rest);
  }
  function HandOrder(style) { this.reset(style); }
  HandOrder.prototype.reset = function(style) {
    this.style = style === 'color' ? 'color' : 'number';
    this.mode = 'auto-' + this.style;
    this.manualHandOrder = [];
  };
  HandOrder.prototype.setAuto = function(style) { this.reset(style || this.style); };
  HandOrder.prototype.resolveDisplayHand = function(hand) {
    if (this.mode !== 'manual') return this.style === 'color' ? sortHandByColor(hand) : sortHandByNumber(hand);
    this.manualHandOrder = reconcileManualOrder(hand, this.manualHandOrder);
    return tilesInOrder(hand, this.manualHandOrder);
  };
  HandOrder.prototype.setManualOrder = function(hand, ids) {
    var before = this.resolveDisplayHand(hand).map(function(tile) { return tile.id; });
    var after = reconcileManualOrder(hand, ids);
    if (sameIds(before, after)) return false;
    this.mode = 'manual';
    this.manualHandOrder = after;
    return true;
  };
  HandOrder.prototype.reorder = function(hand, id, beforeId) {
    var display = this.resolveDisplayHand(hand);
    return this.setManualOrder(hand, reorderTiles(display, id, beforeId).map(function(tile) { return tile.id; }));
  };

  function isGroupLike(set) {
    if (set.length < 3 || set.length > 4) return false;
    var real = set.filter(function(tile) { return !tile.wild; });
    return real.length >= 2 && real.every(function(tile) { return tile.num === real[0].num; }) &&
      new Set(real.map(function(tile) { return tile.color; })).size === real.length;
  }
  function runStart(set) {
    if (set.length < 3 || set.length > 13) return null;
    var real = set.filter(function(tile) { return !tile.wild; });
    if (real.length < 2 || !real.every(function(tile) { return tile.color === real[0].color; })) return null;
    var nums = real.map(function(tile) { return tile.num; });
    if (new Set(nums).size !== nums.length || nums.some(function(num) { return !Number.isInteger(num) || num < 1 || num > 13; })) return null;
    var minimum = Math.min.apply(null, nums), maximum = Math.max.apply(null, nums);
    // Choose the largest possible start: internal gaps/right extension first.
    var start = Math.min(minimum, 14 - set.length);
    return start >= Math.max(1, maximum - set.length + 1) ? start : null;
  }
  function isRunLike(set) { return runStart(set) !== null; }
  function normalizeRunOrder(set) {
    var start = runStart(set);
    if (start === null) return set.slice();
    var real = new Map();
    var jokers = set.filter(function(tile) { return tile.wild; }).sort(byId);
    set.forEach(function(tile) { if (!tile.wild) real.set(tile.num, tile); });
    var result = [], jokerIndex = 0;
    for (var num = start; num < start + set.length; num++) result.push(real.get(num) || jokers[jokerIndex++]);
    return result;
  }
  function normalizeGroupOrder(set) {
    return isGroupLike(set) ? sortHandByColor(set) : set.slice();
  }
  function normalizeTableSet(set) {
    if (isGroupLike(set)) return normalizeGroupOrder(set);
    return normalizeRunOrder(set);
  }
  return {
    sortHandByNumber: sortHandByNumber, sortHandByColor: sortHandByColor,
    reconcileManualOrder: reconcileManualOrder, tilesInOrder: tilesInOrder,
    reorderTiles: reorderTiles, sameIds: sameIds, HandOrder: HandOrder,
    isRunLike: isRunLike, isGroupLike: isGroupLike,
    normalizeRunOrder: normalizeRunOrder, normalizeGroupOrder: normalizeGroupOrder,
    normalizeTableSet: normalizeTableSet
  };
});
