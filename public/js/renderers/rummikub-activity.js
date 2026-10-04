// Only event semantics and compact public tile badges live in this adapter.
(function() {
  'use strict';
  window.formatRummikubActivity=function(item,context) {
    var type=item.type.replace(/^rummikub\./,''),data=item.data||{},player=context.getPlayerName(item.player),text='';
    switch(type) {
      case 'game_start':text=_t('rk_feed_start');break;
      case 'play_set':text=_tf('rk_feed_play',player);break;
      case 'add_to_set':text=_tf('rk_feed_add',player);break;
      case 'manipulate':text=_tf('rk_feed_manipulate',player,data.usedHandTilesCount||0);break;
      case 'draw':text=_tf('rk_feed_draw',player);break;
      case 'end_turn':text=_tf('rk_feed_end_turn',player);break;
      case 'turn':text=_tf('rk_feed_turn',player);break;
      case 'game_end':text=data.winner===-1?_t('rk_feed_draw_game'):_tf('rk_feed_win',context.getPlayerName(data.winner));break;
    }
    var tiles=type==='play_set'?data.tiles:type==='add_to_set'?[data.tile]:[];
    return {text:text,kind:'system',muted:type==='end_turn'||type==='turn',parts:(tiles||[]).map(window.rummikubActivity.publicTile).filter(Boolean).map(function(tile){
      return {text:tile.wild?'★':_t('rk_color_'+tile.color)+tile.num,className:'rk-event-tile-'+tile.color};
    })};
  };
})();
