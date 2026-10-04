// Adapt the same rule modules used by Node to one human or one human + local AI.
(function() {
  ['2048','sudoku','minesweeper','gomoku'].forEach(function(id) {
    var game=window.LocalGameCores[id];
    SoloRuntime.register(id, {
      create:function(){var state=game.createState();state._options={};if(game.initGame)game.initGame(state,id==='gomoku'?2:1);return state;},
      move:game.handleMove,
      view:function(state){
        if(game.playerView)return game.playerView(state,0);
        if(game.playerBoardView)return Object.assign({},state,{board:game.playerBoardView(state,0),revealedCount:state.cellsRevealed[0]});
        return state;
      },
      ai:id==='gomoku'?function(state){return GomokuAI.getMove(state,1);}:null,
      isDraw:id==='gomoku'?function(state){return state.board.every(function(row){return row.every(function(cell){return cell!==null;});});}:null
    });
  });
})();
