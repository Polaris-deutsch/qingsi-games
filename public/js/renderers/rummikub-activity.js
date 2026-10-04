// Persistent, incremental Rummikub activity UI. Game feedback/order stay in the game renderer.
(function() {
  'use strict';
  window.createRummikubActivity = function(host, options) {
    var protocol = window.rummikubActivity;
    var seq = 0, seen = 0, match = null, baseline = true, unread = 0;
    var rows = new Map(), wide = null, expanded = false, self = null, namesKey = '';
    var pending = null, sendUntil = 0, cooldownTimer = null;
    var observer = null, disposed = false;
    var followingBottom = true, scrollFrame = null;
    function node(tag, cls, text) {
      var el = document.createElement(tag); el.className = cls || '';
      if (text !== undefined) el.textContent = text;
      return el;
    }
    function identified(tag, cls, id, text) { var el = node(tag, cls, text); el.id = id; return el; }
    var panel = node('aside', 'rk-activity-panel');
    var toggle = identified('button','rk-activity-header','rkActivityToggle');toggle.type = 'button';
    toggle.setAttribute('aria-controls','rkActivityBody');
    toggle.appendChild(node('span','',options.t('rk_activity')));
    var badge = identified('span','rk-activity-unread','rkActivityUnread');badge.hidden = true;toggle.appendChild(badge);panel.appendChild(toggle);
    var body = identified('div','rk-activity-body','rkActivityBody');panel.appendChild(body);
    var tools = node('div','rk-activity-tools');
    var latest = identified('button','rk-feed-latest','rkFeedLatest');latest.type='button';latest.hidden=true;tools.appendChild(latest);
    var close = identified('button','rk-activity-close','rkActivityClose',options.t('rk_activity_close'));close.type='button';tools.appendChild(close);body.appendChild(tools);
    var feed = identified('div','rk-feed','rkFeed');feed.setAttribute('role','log');feed.setAttribute('aria-label',options.t('rk_activity'));feed.setAttribute('aria-live','off');body.appendChild(feed);
    var empty = identified('p','rk-feed-empty','rkFeedEmpty',options.t('rk_activity_empty'));feed.appendChild(empty);
    var announcement = identified('span','rk-visually-hidden','rkFeedAnnouncement');announcement.setAttribute('role','status');announcement.setAttribute('aria-live','polite');announcement.setAttribute('aria-atomic','true');panel.appendChild(announcement);
    var picker = identified('div','rk-reaction-picker','rkReactionPicker');picker.hidden=true;body.appendChild(picker);
    var reactionButtons = [];
    protocol.REACTIONS.forEach(function(emoji) {
      var button=node('button','rk-reaction-button',emoji);button.type='button';button.dataset.emoji=emoji;
      button.setAttribute('aria-label',options.tf('rk_reaction_send',emoji));
      button.addEventListener('click',function() { if (sendSocial({action:'reaction',emoji:emoji})) hidePicker(); });
      reactionButtons.push(button);picker.appendChild(button);
    });
    var compose=node('form','rk-chat-compose');body.appendChild(compose);
    var input=identified('input','rk-chat-input','rkChatInput');input.type='text';input.value='';input.maxLength=protocol.CHAT_MAX*2;
    input.placeholder=options.t('rk_chat_placeholder');input.setAttribute('aria-label',options.t('rk_chat_label'));input.autocomplete='off';compose.appendChild(input);
    var emojiToggle=identified('button','rk-emoji-toggle','rkReactionToggle','😊');emojiToggle.type='button';
    emojiToggle.setAttribute('aria-label',options.t('rk_reactions'));emojiToggle.setAttribute('aria-controls','rkReactionPicker');emojiToggle.setAttribute('aria-expanded','false');compose.appendChild(emojiToggle);
    var send=identified('button','rk-chat-send','rkChatSend',options.t('rk_chat_send'));send.type='submit';compose.appendChild(send);
    var status=identified('span','rk-chat-status','rkChatStatus');status.setAttribute('role','status');body.appendChild(status);
    host.appendChild(panel);

    function nearBottom() { return feed.scrollHeight-feed.scrollTop-feed.clientHeight<50; }
    function updateUnread() {
      badge.hidden=!unread;badge.textContent=String(unread);
      latest.hidden=!unread;latest.textContent=options.tf('rk_activity_new',unread)+' ↓';
    }
    function toBottom() { feed.scrollTop=feed.scrollHeight;followingBottom=true;unread=0;updateUnread(); }
    function followAfterLayout() {
      if (!window.requestAnimationFrame) return;
      if (scrollFrame !== null) window.cancelAnimationFrame(scrollFrame);
      var position=feed.scrollTop;
      scrollFrame=window.requestAnimationFrame(function() {
        scrollFrame=null;
        if (!disposed && !body.hidden && feed.scrollTop===position) toBottom();
      });
    }
    function hidePicker() { picker.hidden=true;emojiToggle.setAttribute('aria-expanded','false'); }
    function applyExpanded() {
      body.hidden=!(wide||expanded);panel.classList.toggle('rk-activity-expanded',!!expanded);
      toggle.setAttribute('aria-expanded',String(!!(wide||expanded)));toggle.setAttribute('aria-disabled',String(!!wide));
      if (wide||expanded) { if (!unread) toBottom(); }
      else hidePicker();
    }
    function layout() {
      if (disposed) return;
      var tile=document.querySelector('#rkHand .rk-tile, #rkTable .rk-tile');
      var tileWidth=tile && window.getComputedStyle ? parseFloat(window.getComputedStyle(tile).width) : 38;
      // 13 tiles + 12 three-pixel gaps + group/table padding, then a 280px
      // sidebar, a 12px gutter and breathing room. Never squeeze a full run.
      var canFit=host.clientWidth>=13*tileWidth+36+12+24+280+12+64;
      if (canFit!==wide) { wide=canFit;host.classList.toggle('rk-activity-wide',wide);applyExpanded(); }
      var viewport=window.visualViewport;
      var keyboard=viewport && document.activeElement===input ? Math.max(0,window.innerHeight-viewport.height-viewport.offsetTop) : 0;
      panel.style.setProperty('--rk-keyboard-bottom',keyboard+'px');
      var visibleHeight=viewport ? viewport.height : window.innerHeight;
      panel.classList.toggle('rk-keyboard-open',!wide && document.activeElement===input && (keyboard>100 || visibleHeight<600));
      if (!body.hidden && followingBottom) followAfterLayout();
    }
    toggle.addEventListener('click',function() { if (!wide) { expanded=!expanded;applyExpanded();if(expanded)toBottom(); } });
    close.addEventListener('click',function() { expanded=false;applyExpanded();input.blur(); });
    latest.addEventListener('click',toBottom);
    feed.addEventListener('scroll',function() {
      followingBottom=nearBottom();
      if (!body.hidden && followingBottom) { unread=0;updateUnread(); }
    });
    emojiToggle.addEventListener('click',function() { picker.hidden=!picker.hidden;emojiToggle.setAttribute('aria-expanded',String(!picker.hidden)); });
    input.addEventListener('focus',layout);input.addEventListener('blur',layout);
    input.addEventListener('input',function() {
      var chars=Array.from(input.value);if(chars.length>protocol.CHAT_MAX)input.value=chars.slice(0,protocol.CHAT_MAX).join('');
      status.textContent='';
    });
    ['keydown','keyup','keypress'].forEach(function(type) { input.addEventListener(type,function(event) {
      event.stopPropagation();
      if(type==='keydown' && event.key==='Enter' && !event.isComposing && event.keyCode!==229) { event.preventDefault();sendChat(); }
    }); });
    compose.addEventListener('submit',function(event) { event.preventDefault();sendChat(); });

    function updateCooldown() {
      var cooling=Date.now()<sendUntil;send.disabled=cooling||self===null;
      input.disabled=self===null;emojiToggle.disabled=self===null;
      reactionButtons.forEach(function(button) { button.disabled=cooling||self===null; });
    }
    function sendSocial(data) {
      if(self===null || Date.now()<sendUntil)return false;
      status.textContent='';sendUntil=Date.now()+protocol.CHAT_GAP;updateCooldown();
      clearTimeout(cooldownTimer);cooldownTimer=setTimeout(updateCooldown,protocol.CHAT_GAP+5);
      options.send(data);return true;
    }
    function sendChat() {
      var text=protocol.normalizeChat(input.value);
      if(!text){status.textContent=options.t('rk_chat_empty');return;}
      if(Array.from(text).length>protocol.CHAT_MAX){status.textContent=options.t('rk_chat_too_long');return;}
      if(sendSocial({action:'chat',text:text}))pending={text:text,draft:input.value};
    }
    function name(index) { return options.name(index); }
    function description(event) {
      var player=name(event.player),data=event.data||{};
      switch(event.type) {
        case 'game_start': return options.t('rk_feed_start');
        case 'play_set': return options.tf('rk_feed_play',player);
        case 'add_to_set': return options.tf('rk_feed_add',player);
        case 'manipulate': return options.tf('rk_feed_manipulate',player,data.usedHandTilesCount||0);
        case 'draw': return options.tf('rk_feed_draw',player);
        case 'end_turn': return options.tf('rk_feed_end_turn',player);
        case 'turn': return options.tf('rk_feed_turn',player);
        case 'game_end': return data.winner===-1 ? options.t('rk_feed_draw_game') : options.tf('rk_feed_win',name(data.winner));
        case 'chat': case 'reaction': return player;
        default: return '';
      }
    }
    function tileLabel(tile) { return tile.wild ? '★' : options.t('rk_color_'+tile.color)+tile.num; }
    function rowFor(event,live) {
      var row=node('div','rk-event rk-event-'+event.type);row.dataset.seq=String(event.seq);
      var date=new Date(event.time),time=node('time','rk-event-time',String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0'));row.appendChild(time);
      var title=node('span','rk-event-title',description(event));row.appendChild(title);
      var data=event.data||{};
      if(event.type==='chat') row.appendChild(node('span','rk-event-chat-text',data.text));
      if(event.type==='reaction') {
        row.appendChild(node('span','rk-event-emoji',data.emoji));
        if(live) {row.classList.add('rk-reaction-new');row.addEventListener('animationend',function(){row.classList.remove('rk-reaction-new');});}
      }
      var tiles=event.type==='play_set'?data.tiles:event.type==='add_to_set'?[data.tile]:[];
      (tiles||[]).forEach(function(tile){var safe=protocol.publicTile(tile);if(safe)row.appendChild(node('span','rk-event-tile rk-event-tile-'+safe.color,tileLabel(safe)));});
      return {node:row,title:title,event:event};
    }
    function resetMatch(id) {
      match=id;seq=0;seen=0;unread=0;namesKey='';baseline=true;rows.clear();
      feed.replaceChildren(empty);input.value='';pending=null;sendUntil=0;hidePicker();status.textContent='';announcement.textContent='';updateUnread();
    }
    function render(state,index) {
      // Static assets can update while a local service still runs the previous
      // game module. Never send new actions to a match without this protocol.
      self=typeof state.timelineId==='string'&&Array.isArray(state.timeline)?index:null;
      var timeline=state.timeline||[];
      if(match!==state.timelineId)resetMatch(state.timelineId);
      layout();updateCooldown();
      if(self===null)status.textContent=options.t('rk_chat_unavailable');
      var initial=rows.size===0,following=!body.hidden&&nearBottom();var added=0;var removedHeight=0;
      var present=new Set(timeline.map(function(event){return event.seq;}));
      rows.forEach(function(row,id){if(!present.has(id)){if(row.node.offsetTop+row.node.offsetHeight<=feed.scrollTop)removedHeight+=row.node.offsetHeight;row.node.remove();rows.delete(id);}});
      timeline.forEach(function(event) {
        if(event.seq<=seq)return;
        var live=!baseline&&event.seq>seen;
        var row=rowFor(event,live);feed.appendChild(row.node);rows.set(event.seq,row);seq=event.seq;
        if(live)added++;
        if(event.type==='chat'&&event.player===self&&pending&&event.data.text===pending.text) {
          if(input.value===pending.draft)input.value='';pending=null;
        }
      });
      empty.hidden=rows.size>0;
      var key=state.hands.map(function(_,i){return name(i);}).join('\u0000');
      if(key!==namesKey){rows.forEach(function(row){row.title.textContent=description(row.event);});namesKey=key;}
      if((baseline&&initial)||following) {if(!body.hidden){toBottom();followAfterLayout();}}
      else {
        // A scroll event can arrive after this state update. Cancel a layout
        // follow queued from the previous bottom position before preserving history.
        followingBottom=false;
        if(scrollFrame!==null){window.cancelAnimationFrame(scrollFrame);scrollFrame=null;}
        feed.scrollTop=Math.max(0,feed.scrollTop-removedHeight);unread+=added;updateUnread();
      }
      if(added){announcement.textContent=options.tf('rk_activity_new',added);}
      else if(baseline)announcement.textContent='';
      seen=Math.max(seen,state.timelineSeq||seq);baseline=false;
    }
    function resetSync() {
      baseline=true;pending=null;announcement.textContent='';
      rows.forEach(function(row){row.node.classList.remove('rk-reaction-new');});
    }
    function error(code,message) {pending=null;status.textContent=message||options.t(code);}
    if(window.addEventListener)window.addEventListener('resize',layout);
    if(window.visualViewport)window.visualViewport.addEventListener('resize',layout);
    if(window.ResizeObserver){observer=new window.ResizeObserver(layout);observer.observe(host);}
    applyExpanded();updateCooldown();
    return {render:render,resetSync:resetSync,error:error,dispose:function(){
      disposed=true;clearTimeout(cooldownTimer);if(observer)observer.disconnect();
      if(scrollFrame!==null)window.cancelAnimationFrame(scrollFrame);
      if(window.removeEventListener)window.removeEventListener('resize',layout);
      if(window.visualViewport)window.visualViewport.removeEventListener('resize',layout);
    }};
  };
})();
