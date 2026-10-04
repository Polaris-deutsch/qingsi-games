// Instance-local public activity UI. Layout placement and event semantics belong to adapters.
(function() {
  'use strict';
  var nextInstance = 0;
  window.ActivityFeed = {create:function(options) {
    var protocol = window.ActivityProtocol, host = options.mount, strings = options.strings || {};
    var prefix = 'ga-' + (++nextInstance) + '-';
    var maxLength = options.chatMaxLength || protocol.CHAT_MAX_LENGTH;
    var gap = options.chatGapMs === undefined ? protocol.CHAT_GAP_MS : options.chatGapMs;
    var reactions = options.reactions || protocol.DEFAULT_REACTIONS;
    var lastRenderedSeq = 0, lastSeenTimelineSeq = 0, resetKey, baseline = true, unread = 0;
    var rows = new Map(), docked = options.docked !== false, collapsed = options.collapsed === true;
    var self = options.playerIndex == null ? null : options.playerIndex, namesVersion;
    var disabled = !!options.disabled, disabledMessage = '', pending = null, sendUntil = 0;
    var cooldownTimer = null, observer = null, disposed = false, followingBottom = true, scrollFrame = null;
    var listeners = new Set();
    function listen(target, type, fn, once) {
      function cleanup() { target.removeEventListener(type, callback);listeners.delete(cleanup); }
      function callback(event) { if(once)cleanup();if(!disposed)fn(event); }
      target.addEventListener(type,callback);listeners.add(cleanup);return cleanup;
    }
    function text(key, value) {
      var s=strings[key];return typeof s==='function'?s(value):(s===undefined?'':String(s));
    }
    function node(tag, cls, value) {
      var el=document.createElement(tag);el.className=cls||'';
      if(value!==undefined)el.textContent=value;return el;
    }
    function identified(tag, cls, role, value) {var el=node(tag,cls,value);el.id=prefix+role;return el;}
    var panel=identified('aside','ga-panel','panel');
    var toggle=identified('button','ga-head','toggle');toggle.type='button';
    toggle.appendChild(node('span','',text('title')));
    var badge=identified('span','ga-unread','unread');badge.hidden=true;toggle.appendChild(badge);panel.appendChild(toggle);
    var body=identified('div','ga-body','body');panel.appendChild(body);toggle.setAttribute('aria-controls',body.id);
    var tools=node('div','ga-tools');
    var latest=identified('button','ga-latest','latest');latest.type='button';latest.hidden=true;tools.appendChild(latest);
    var close=identified('button','ga-close','close',text('collapse'));close.type='button';tools.appendChild(close);body.appendChild(tools);
    var feed=identified('div','ga-feed','feed');feed.setAttribute('role','log');feed.setAttribute('aria-label',text('title'));feed.setAttribute('aria-live','off');body.appendChild(feed);
    var empty=identified('p','ga-empty','empty',text('empty'));feed.appendChild(empty);
    var announcement=identified('span','ga-visually-hidden','announcement');announcement.setAttribute('role','status');announcement.setAttribute('aria-live','polite');announcement.setAttribute('aria-atomic','true');panel.appendChild(announcement);
    var picker=identified('div','ga-reactions','reactions');picker.hidden=true;body.appendChild(picker);
    var reactionButtons=[];
    reactions.forEach(function(emoji) {
      var button=node('button','ga-reaction-button',emoji);button.type='button';button.dataset.emoji=emoji;
      button.setAttribute('aria-label',text('sendReaction',emoji));
      listen(button,'click',function(){if(sendSocial('reaction',emoji))hidePicker();});reactionButtons.push(button);picker.appendChild(button);
    });
    var compose=node('form','ga-compose');body.appendChild(compose);
    var input=identified('input','ga-input','input');input.type='text';input.value='';input.maxLength=maxLength*2;
    input.placeholder=text('placeholder');input.setAttribute('aria-label',text('inputLabel'));input.autocomplete='off';compose.appendChild(input);
    var emojiToggle=identified('button','ga-emoji-toggle','emoji','😊');emojiToggle.type='button';emojiToggle.setAttribute('aria-label',text('reactions'));emojiToggle.setAttribute('aria-controls',picker.id);emojiToggle.setAttribute('aria-expanded','false');compose.appendChild(emojiToggle);
    var send=identified('button','ga-send','send',text('send'));send.type='submit';compose.appendChild(send);
    var status=identified('span','ga-status','status');status.setAttribute('role','status');body.appendChild(status);host.appendChild(panel);

    function nearBottom(){return feed.scrollHeight-feed.scrollTop-feed.clientHeight<(options.nearBottomPx||50);}
    function updateUnread(){badge.hidden=!unread;badge.textContent=String(unread);latest.hidden=!unread;latest.textContent=text('newItems',unread)+' ↓';}
    function cancelFollow(){if(scrollFrame!==null){window.cancelAnimationFrame(scrollFrame);scrollFrame=null;}}
    function scrollToBottom(){if(disposed)return;feed.scrollTop=feed.scrollHeight;followingBottom=true;unread=0;updateUnread();}
    function followAfterLayout(){
      if(!window.requestAnimationFrame)return;cancelFollow();var position=feed.scrollTop;
      scrollFrame=window.requestAnimationFrame(function(){scrollFrame=null;if(!disposed&&!body.hidden&&feed.scrollTop===position)scrollToBottom();});
    }
    function hidePicker(){picker.hidden=true;emojiToggle.setAttribute('aria-expanded','false');}
    function applyCollapsed(){
      body.hidden=!docked&&collapsed;panel.classList.toggle('ga-docked',docked);
      toggle.setAttribute('aria-expanded',String(!body.hidden));toggle.setAttribute('aria-disabled',String(docked));
      toggle.setAttribute('aria-label',text(docked?'title':body.hidden?'expand':'collapse')||text('title'));
      if(body.hidden)hidePicker();else if(followingBottom&&!unread)scrollToBottom();layout();
    }
    function layout(){
      if(disposed)return;var viewport=window.visualViewport;
      var keyboard=viewport&&document.activeElement===input?Math.max(0,window.innerHeight-viewport.height-viewport.offsetTop):0;
      panel.style.setProperty('--ga-keyboard-bottom',keyboard+'px');
      var height=viewport?viewport.height:window.innerHeight;
      panel.classList.toggle('ga-keyboard-open',!docked&&document.activeElement===input&&(keyboard>100||height<600));
      if(!body.hidden&&followingBottom)followAfterLayout();
    }
    function updateCooldown(){
      var blocked=disabled||self===null,cooling=Date.now()<sendUntil;
      input.disabled=blocked||typeof options.sendChat!=='function';send.disabled=input.disabled||cooling;
      emojiToggle.disabled=blocked||typeof options.sendReaction!=='function';reactionButtons.forEach(function(button){button.disabled=emojiToggle.disabled||cooling;});
    }
    function showError(message){if(disposed)return;pending=null;status.textContent=message||'';}
    function sendSocial(type,value){
      if(disabled||self===null||Date.now()<sendUntil)return false;
      var callback=type==='chat'?options.sendChat:options.sendReaction;if(typeof callback!=='function')return false;
      status.textContent='';sendUntil=Date.now()+gap;updateCooldown();clearTimeout(cooldownTimer);cooldownTimer=setTimeout(updateCooldown,gap+5);
      if(type==='chat')pending={text:value,draft:input.value};
      try{callback(value);}catch(error){showError(error.message);return false;}return true;
    }
    function sendChat(){
      if(disabled||self===null)return;
      var value=protocol.normalizeChat(input.value);
      if(!value){showError(text('chatEmpty'));return;}
      if(Array.from(value).length>maxLength){showError(text('chatTooLong'));return;}sendSocial('chat',value);
    }
    function name(index){return options.getPlayerName?options.getPlayerName(index):String(index==null?'':index);}
    function descriptor(item){
      if(item.type==='chat'||item.type==='reaction')return {text:name(item.player),kind:item.type};
      var result=options.formatEvent?options.formatEvent(item,{getPlayerName:name}):null;
      // Descriptors are text and optional text badges, never raw HTML.
      return result&&typeof result==='object'?result:{text:item.type,kind:'system'};
    }
    function refreshRow(row){
      var result=descriptor(row.item),kind=result.kind==='chat'||result.kind==='reaction'?result.kind:'system';
      row.node.classList.remove('ga-item-system','ga-item-chat','ga-item-reaction','ga-item-muted');row.node.classList.add('ga-item-'+kind);
      if(result.muted)row.node.classList.add('ga-item-muted');row.title.textContent=result.text||'';
      row.parts.forEach(function(part){part.remove();});row.parts=[];
      (Array.isArray(result.parts)?result.parts:[]).forEach(function(part){var el=node('span','ga-mini '+(part.className||''),part.text);row.node.appendChild(el);row.parts.push(el);});
    }
    function rowFor(item,live){
      var el=node('div','ga-item');el.dataset.seq=String(item.seq);
      var date=new Date(item.time);el.appendChild(node('time','ga-time',String(date.getHours()).padStart(2,'0')+':'+String(date.getMinutes()).padStart(2,'0')));
      var title=node('span','ga-title');el.appendChild(title);
      var row={node:el,title:title,item:item,parts:[],stopAnimation:null};refreshRow(row);
      if(item.type==='chat')el.appendChild(node('span','ga-chat-text',(item.data||{}).text));
      if(item.type==='reaction'){
        el.appendChild(node('span','ga-emoji',(item.data||{}).emoji));
        if(live){el.classList.add('ga-reaction-new');row.stopAnimation=listen(el,'animationend',function(){el.classList.remove('ga-reaction-new');row.stopAnimation=null;},true);}
      }
      return row;
    }
    function clearRows(){rows.forEach(function(row){if(row.stopAnimation)row.stopAnimation();});rows.clear();feed.replaceChildren(empty);}
    function resetTimeline(key){
      cancelFollow();resetKey=key;lastRenderedSeq=0;lastSeenTimelineSeq=0;unread=0;namesVersion=undefined;baseline=true;clearRows();
      input.value='';pending=null;sendUntil=0;clearTimeout(cooldownTimer);hidePicker();status.textContent=disabledMessage;announcement.textContent='';updateUnread();
    }
    function firstNewIndex(items){
      var low=0,high=items.length;while(low<high){var mid=(low+high)>>>1;if(items[mid].seq<=lastRenderedSeq)low=mid+1;else high=mid;}return low;
    }
    function update(activity,context){
      if(disposed||!activity||activity.version!==protocol.VERSION||!Array.isArray(activity.items))return;
      context=context||{};if(context.playerIndex!==undefined)self=context.playerIndex;
      if((context.resetKey!==undefined&&context.resetKey!==resetKey)||activity.seq<lastRenderedSeq)resetTimeline(context.resetKey);
      var items=activity.items,first=items.length?items[0].seq:activity.seq+1;
      var following=!body.hidden&&nearBottom(),initial=rows.size===0;
      if(lastRenderedSeq&&first>lastRenderedSeq+1){clearRows();lastRenderedSeq=first-1;baseline=true;initial=true;unread=0;}
      var oldScroll=feed.scrollTop,oldHeight=feed.scrollHeight;
      // Ordered retention removes a prefix; ordinary updates only visit new items.
      for(var entry of rows){if(entry[0]>=first)break;var obsolete=entry[1];if(obsolete.stopAnimation)obsolete.stopAnimation();obsolete.node.remove();rows.delete(entry[0]);}
      var removedHeight=Math.max(0,oldHeight-feed.scrollHeight),added=0;
      for(var i=firstNewIndex(items);i<items.length;i++){
        var item=items[i],live=!baseline&&item.seq>lastSeenTimelineSeq,row=rowFor(item,live);feed.appendChild(row.node);rows.set(item.seq,row);lastRenderedSeq=item.seq;
        if(live)added++;
        if(item.type==='chat'&&item.player===self&&pending&&item.data.text===pending.text){if(input.value===pending.draft)input.value='';pending=null;}
      }
      empty.hidden=rows.size>0;
      if(context.namesVersion!==namesVersion){rows.forEach(refreshRow);namesVersion=context.namesVersion;}
      if((baseline&&initial)||following){if(!body.hidden){scrollToBottom();followAfterLayout();}}
      else {followingBottom=false;cancelFollow();feed.scrollTop=Math.max(0,oldScroll-removedHeight);unread+=added;updateUnread();}
      if(added)announcement.textContent=text('newItems',added);else if(baseline)announcement.textContent='';
      lastSeenTimelineSeq=Math.max(lastSeenTimelineSeq,activity.seq);baseline=false;updateCooldown();
    }
    function resetSync(){
      if(disposed)return;baseline=true;pending=null;announcement.textContent='';
      rows.forEach(function(row){row.node.classList.remove('ga-reaction-new');if(row.stopAnimation){row.stopAnimation();row.stopAnimation=null;}});
    }
    listen(toggle,'click',function(){if(!docked){collapsed=!collapsed;applyCollapsed();if(!collapsed)scrollToBottom();}});
    listen(close,'click',function(){collapsed=true;applyCollapsed();input.blur();});listen(latest,'click',scrollToBottom);
    listen(feed,'scroll',function(){followingBottom=nearBottom();if(!body.hidden&&followingBottom){unread=0;updateUnread();}});
    listen(emojiToggle,'click',function(){picker.hidden=!picker.hidden;emojiToggle.setAttribute('aria-expanded',String(!picker.hidden));});
    listen(input,'focus',layout);listen(input,'blur',layout);
    listen(input,'input',function(){var chars=Array.from(input.value);if(chars.length>maxLength)input.value=chars.slice(0,maxLength).join('');status.textContent=disabledMessage;});
    ['keydown','keyup','keypress'].forEach(function(type){listen(input,type,function(event){event.stopPropagation();if(type==='keydown'&&event.key==='Enter'&&!event.isComposing&&event.keyCode!==229){event.preventDefault();sendChat();}});});
    listen(compose,'submit',function(event){event.preventDefault();sendChat();});
    if(window.addEventListener)listen(window,'resize',layout);
    if(window.visualViewport)listen(window.visualViewport,'resize',layout);
    if(window.ResizeObserver){observer=new window.ResizeObserver(layout);observer.observe(panel);}
    applyCollapsed();updateCooldown();
    return {update:update,resetSync:resetSync,showError:showError,scrollToBottom:scrollToBottom,
      setDisabled:function(value,message){
        if(disposed)return;var next=!!value,nextMessage=next?(message||text('ended')):'';
        if(next!==disabled||nextMessage!==disabledMessage){disabled=next;disabledMessage=nextMessage;if(disabled)hidePicker();status.textContent=disabledMessage;}
        updateCooldown();
      },
      setCollapsed:function(value){if(disposed)return;collapsed=!!value;applyCollapsed();},
      setDocked:function(value){if(disposed||docked===!!value)return;docked=!!value;applyCollapsed();},
      destroy:function(){if(disposed)return;disposed=true;clearTimeout(cooldownTimer);cancelFollow();if(observer)observer.disconnect();listeners.forEach(function(cleanup){cleanup();});rows.clear();panel.remove();pending=null;}
    };
  }};
})();
