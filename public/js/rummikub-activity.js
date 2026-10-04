// Public event projection for this game. Generic social validation lives in Activity.
(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.rummikubActivity = api;
})(typeof window !== 'undefined' ? window : this, function() {
  'use strict';
  var TYPES = ['game_start','play_set','add_to_set','manipulate','draw','end_turn','turn','game_end'];
  var COLORS = ['black','blue','red','orange'];
  function publicTile(tile) {
    if (!tile || typeof tile !== 'object') return null;
    if (tile.wild === true) return {color:'joker', num:0, wild:true};
    if (!COLORS.includes(tile.color) || !Number.isInteger(tile.num) || tile.num < 1 || tile.num > 13) return null;
    return {color:tile.color, num:tile.num, wild:false};
  }
  function projectData(type, data) {
    var short = type.replace(/^rummikub\./, '');
    if (!TYPES.includes(short)) return null;
    var safe = {};
    if (short === 'play_set') safe.tiles = (Array.isArray(data.tiles) ? data.tiles : []).map(publicTile).filter(Boolean).slice(0,13);
    if (short === 'add_to_set') {
      safe.tile = publicTile(data.tile);
      if (Number.isInteger(data.targetSet) && data.targetSet >= 0) safe.targetSet = data.targetSet;
    }
    if (short === 'manipulate' && Number.isInteger(data.usedHandTilesCount)) safe.usedHandTilesCount = Math.max(0, Math.min(106, data.usedHandTilesCount));
    if (short === 'game_end') safe.winner = Number.isInteger(data.winner) && data.winner >= -1 && data.winner <= 3 ? data.winner : -1;
    return safe;
  }
  return {publicTile:publicTile, projectData:projectData};
});
