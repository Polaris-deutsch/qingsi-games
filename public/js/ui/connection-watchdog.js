// A response deadline, independent of WebSocket retries or a game's rules.
(function() {
  window.ConnectionWatchdog = {create:function(options) {
    var timer = null, destroyed = false;
    function stop(){clearTimeout(timer);timer=null;}
    return {
      start:function(context){if(destroyed||timer!==null)return;timer=setTimeout(function(){timer=null;console.warn('[GameNest] connection timeout',context);options.onTimeout(context);},options.timeoutMs||8000);},
      stop:stop,
      destroy:function(){destroyed=true;stop();}
    };
  }};
})();
