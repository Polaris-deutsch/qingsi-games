// Solo shell shares game.html and its renderers; room-client exits before any session access.
(function() {
  'use strict';
  var params=new URLSearchParams(location.search);
  window.__SOLO_MODE=params.get('mode')==='solo';
  window.startSoloGame=function() {
    document.body.classList.add('solo-mode');
    var id=params.get('game'),info=window.gameCatalog.byId(id),board=document.getElementById('boardArea');
    var stage=document.getElementById('gameStage'),actions=document.getElementById('gameActions');
    document.getElementById('waitingRoom').style.display='none';stage.style.display='';actions.style.display='';
    document.getElementById('activeGameName').textContent=info?info.name:_t('solo_mode');
    document.getElementById('activeGameSubtitle').textContent=_t('solo_mode');
    document.getElementById('stageGameName').textContent=info?info.name:_t('solo_mode');
    document.getElementById('stageRoomFacts').textContent=_t('solo_mode');
    document.getElementById('stageMeta').textContent='';document.title='QingSi Games — '+(info?info.name:_t('solo_mode'));
    var status=document.getElementById('status');status.style.display='';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    var restart=actions.querySelector('button'),back=actions.querySelectorAll('button')[1];
    restart.textContent=_t('restart');back.textContent=_t('back_to_lobby');
    var runtime=null,resultShown=false;
    var saved={};['makeGameMove','GameRuntime','doRestart','doReturnToRoom','doLeaveRoom','getPlayerName','showToast','_players'].forEach(function(key){saved[key]={own:Object.prototype.hasOwnProperty.call(window,key),value:window[key]};});
    function message(value){status.textContent=value||'';}
    function leave(){if(runtime)runtime.destroy();location.href='/';}
    window.doLeaveRoom=leave;window.doReturnToRoom=leave;
    window.doRestart=function(){if(runtime){resultShown=false;document.getElementById('overlay').style.display='none';runtime.restart();}};
    window.makeGameMove=function(data){return runtime?runtime.makeMove(data):false;};
    window.getPlayerName=function(seat){return _t(seat===0?'solo_you':'solo_ai');};window.showToast=message;
    window._players=[{name:_t('solo_you'),index:0,isBot:false},{name:_t('solo_ai'),index:1,isBot:true}];
    restart.onclick=window.doRestart;back.onclick=leave;
    function cleanup(){
      document.removeEventListener('visibilitychange',visibility);window.removeEventListener('pagehide',pagehide);
      Object.keys(saved).forEach(function(key){if(saved[key].own)window[key]=saved[key].value;else delete window[key];});
    }
    function visibility(){if(runtime){if(document.hidden)runtime.pause();else runtime.resume();}}
    function pagehide(){if(runtime)runtime.destroy();}
    if(!info||!info.solo) {message(_t('solo_unsupported'));restart.disabled=true;return;}
    if(!window.SoloRuntime||!SoloRuntime.has(id)){message(_t('solo_load_failed'));restart.disabled=true;return;}
    try {
      runtime=SoloRuntime.create({game:id,mount:board,renderer:window.gameRenderers.get(id),
        strings:{thinking:_t('solo_thinking'),paused:_t('solo_paused')},onStatus:message,
        onError:function(code){if(code==='g2048_no_move')return;message(_t(code==='su_wrong'?'solo_wrong_number':'solo_invalid_move'));if(window._gameErrorHandler)window._gameErrorHandler(code);},
        onState:function(state){
          if(id==='2048'){
            var best=0;try{best=Number(localStorage.getItem('solo:2048:best'))||0;best=Math.max(best,state.scores[0]);localStorage.setItem('solo:2048:best',String(best));}catch(e){best=state.scores[0];}
            document.getElementById('g2048Best').textContent=best;
            if(state.winner!==null&&state.boards[0].every(function(row){return row.every(function(n){return n<2048;});}))document.getElementById('g2048Hint').textContent=_t('solo_finished');
          }
          if(state.winner!==null&&!resultShown){
            resultShown=true;document.getElementById('overlay').style.display='flex';
            var won=state.winner===0&&(id!=='2048'||state.boards[0].some(function(row){return row.some(function(n){return n>=2048;});}));
            document.getElementById('resultText').textContent=_t(won?'solo_complete':'solo_finished');
            document.getElementById('resultSub').textContent=_t('solo_restart_hint');
          }
        },onDestroy:cleanup
      });
      window.GameRuntime=runtime;
      document.addEventListener('visibilitychange',visibility);window.addEventListener('pagehide',pagehide);
    } catch(error){message(_t('solo_load_failed'));console.error('[GameNest] local game failed: '+id,error);restart.disabled=true;}
    var overlay=document.getElementById('overlay'),buttons=overlay.querySelectorAll('button');
    buttons[0].textContent=_t('play_again');buttons[1].hidden=true;buttons[2].textContent=_t('back_to_lobby');
  };
})();
