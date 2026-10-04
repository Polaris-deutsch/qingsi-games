// Rummikub activity protocol values and public-data projections, shared by Node/browser.
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.rummikubActivity = api;
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';
  var REACTIONS = Object.freeze(['😂','🤣','😎','😭','😱','🤔','😏','👍','👏','🔥','💀','❤️']);
  var TYPES = ['game_start','play_set','add_to_set','manipulate','draw','end_turn','turn','game_end','chat','reaction'];
  var COLORS = ['black','blue','red','orange'];
  function normalizeChat(text) { return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : ''; }
  function publicTile(tile) {
    if (!tile || typeof tile !== 'object') return null;
    if (tile.wild === true) return { color:'joker', num:0, wild:true };
    if (!COLORS.includes(tile.color) || !Number.isInteger(tile.num) || tile.num < 1 || tile.num > 13) return null;
    return { color:tile.color, num:tile.num, wild:false };
  }
  // Whitelist fields rather than serializing arbitrary event data or tile objects.
  function publicEvent(event) {
    if (!event || !TYPES.includes(event.type) || !Number.isSafeInteger(event.seq) || event.seq < 1 || !Number.isFinite(event.time)) return null;
    var data = event.data || {}, safe = {};
    if (event.type === 'play_set') safe.tiles = (Array.isArray(data.tiles) ? data.tiles : []).map(publicTile).filter(Boolean).slice(0,13);
    if (event.type === 'add_to_set') {
      safe.tile = publicTile(data.tile);
      if (Number.isInteger(data.targetSet) && data.targetSet >= 0) safe.targetSet = data.targetSet;
    }
    if (event.type === 'manipulate' && Number.isInteger(data.usedHandTilesCount)) safe.usedHandTilesCount = Math.max(0, Math.min(106, data.usedHandTilesCount));
    if (event.type === 'game_end') safe.winner = Number.isInteger(data.winner) && data.winner >= -1 && data.winner <= 3 ? data.winner : -1;
    if (event.type === 'chat') safe.text = Array.from(normalizeChat(data.text)).slice(0,120).join('');
    if (event.type === 'reaction') { if (!REACTIONS.includes(data.emoji)) return null; safe.emoji = data.emoji; }
    return { seq:event.seq, type:event.type, player:Number.isInteger(event.player) && event.player >= 0 && event.player <= 3 ? event.player : null, time:event.time, data:safe };
  }
  function publicTimeline(timeline) { return (Array.isArray(timeline) ? timeline : []).map(publicEvent).filter(Boolean); }
  return { REACTIONS:REACTIONS, CHAT_MAX:120, CHAT_GAP:800, TIMELINE_MAX:500,
    normalizeChat:normalizeChat, publicTile:publicTile, publicEvent:publicEvent, publicTimeline:publicTimeline };
});
