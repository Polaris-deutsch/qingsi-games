// Local state, renderer dispatch and AI scheduling. No rooms, sockets or HTTP calls.
(function() {
  'use strict';
  var adapters = new Map();
  window.SoloRuntime = {
    register:function(id, adapter){adapters.set(id,adapter);},
    has:function(id){return adapters.has(id);},
    create:function(options) {
      var adapter=adapters.get(options.game);if(!adapter)throw new Error('Unsupported local game: '+options.game);
      var renderer=options.renderer;if(!renderer)throw new Error('Missing game renderer');
      var strings=options.strings||{};
      var state,disposed=false,paused=false,pauseAt=0,aiTimer=null;
      function status(message){if(options.onStatus)options.onStatus(message);}
      function render(){if(disposed)return;renderer.render(adapter.view(state),options.mount,0,state.winner);if(options.onState)options.onState(state);}
      function cancelAI(){clearTimeout(aiTimer);aiTimer=null;}
      function finishDraw(){if(adapter.isDraw&&state.winner===null&&adapter.isDraw(state))state.winner=-1;}
      function scheduleAI(){
        if(disposed||paused||state.winner!==null||!adapter.ai||state.currentPlayer!==1)return;
        status(strings.thinking);aiTimer=setTimeout(function(){
          aiTimer=null;if(disposed||paused||state.winner!==null||state.currentPlayer!==1)return;
          var move=adapter.ai(state);if(move){var error=adapter.move(move,state,1);if(error&&options.onError)options.onError(error);}finishDraw();render();status('');
        },options.aiDelayMs===undefined?300:options.aiDelayMs);
      }
      function restart(){if(disposed)return;cancelAI();state=adapter.create(options);paused=false;pauseAt=0;
        renderer.init(options.mount);render();status('');scheduleAI();}
      function makeMove(data){
        if(disposed||paused||state.winner!==null||(adapter.ai&&state.currentPlayer!==0))return false;
        var error=adapter.move(data,state,0);finishDraw();render();
        if(error){if(options.onError)options.onError(error);return false;}scheduleAI();return true;
      }
      var api={mode:'solo',makeMove:makeMove,restart:restart,getState:function(){return state;},
        pause:function(){if(disposed||paused)return;paused=true;pauseAt=Date.now();cancelAI();status(strings.paused);},
        resume:function(){if(disposed||!paused)return;paused=false;if(state.startTime)state.startTime+=Date.now()-pauseAt;render();status('');scheduleAI();},
        destroy:function(){if(disposed)return;disposed=true;cancelAI();if(renderer.destroy)renderer.destroy();if(options.onDestroy)options.onDestroy();}
      };
      restart();return api;
    }
  };
})();
