// public/js/renderers/rummikub.js
// 拉密 / 魔力桥 (Rummikub) renderer — with table manipulation, break-aware, clickable targets
(function() {
  window.gameRenderers = window.gameRenderers || new Map();

  var selectedTiles = {};
  var _targetSet = null;       // clicked table set index for adding 1 tile
  // ---- manipulate (box-based) state ----
  var _boxes = [];             // array of groups (each an array of tiles), seeded from the table
  var _handBox = [];           // tiles kept in hand during manipulate
  var _sel = {};               // selected tile ids (across all boxes + hand)
  var _manipInit = false;      // whether boxes have been seeded for this manipulate session
  var Ordering = window.rummikubOrder;
  var _handOrder = new Ordering.HandOrder('number');
  var _orderSelfIdx = null;
  var _viewState = null;
  var _viewSelf = null;
  var _activity = null;
  var _gameRenderKey = null;
  var _tableOrders = new Map(); // local, explicit group-internal display overrides
  var _lastOrderPhase = null;
  var _lastHandCount = 0;
  var _drag = null;
  var _suppressClickUntil = 0;
  var SORT_KEY = 'qingsi.rummikub.handSort';

  function preferredSort() {
    try { return window.localStorage.getItem(SORT_KEY) === 'color' ? 'color' : 'number'; }
    catch (e) { return 'number'; }
  }

  function resetHandOrder() {
    cancelDrag();
    _handOrder.reset(preferredSort());
    _orderSelfIdx = null;
    _tableOrders.clear();
    _lastOrderPhase = null;
    _manipInit = false;
    renderOrderControls();
  }

  function resolveDisplayHand(hand) { return _handOrder.resolveDisplayHand(hand || []); }

  function resolveDisplayTableSet(set, index) {
    var override = _tableOrders.get(index);
    if (!override) return set;
    var ids = set.map(function(tile) { return tile.id; });
    // Shared additions/reorders supersede an earlier local table arrangement.
    if (!Ordering.sameIds(ids, override.sourceIds)) {
      _tableOrders.delete(index);
      return set;
    }
    return Ordering.tilesInOrder(set, override.ids);
  }

  function renderOrderControls() {
    var summary = document.getElementById('rkOrderSummary');
    if (summary) summary.textContent = _t(_handOrder.mode === 'manual' ? 'rk_order_manual' :
      _handOrder.style === 'color' ? 'rk_order_auto_color' : 'rk_order_auto_number') + ' ▾';
    var number = document.getElementById('rkOrderNumberBtn');
    var color = document.getElementById('rkOrderColorBtn');
    if (number) number.textContent = (_handOrder.mode === 'auto-number' ? '✓ ' : '') + _t('rk_order_number');
    if (color) color.textContent = (_handOrder.mode === 'auto-color' ? '✓ ' : '') + _t('rk_order_color');
  }

  function renderOrderView() {
    if (!_viewState) return;
    renderOrderControls();
    if (_viewState.phase === 'manipulate' && _viewState.currentPlayer === _viewSelf) {
      renderManipulate(_viewState, _viewSelf);
    } else {
      renderHand(_viewState, _viewSelf);
      renderTable(_viewState, _viewSelf);
    }
  }

  function autoArrangeHand(style) {
    cancelDrag();
    _handOrder.setAuto(style);
    try { window.localStorage.setItem(SORT_KEY, _handOrder.style); } catch (e) {}
    if (_viewState && _viewState.phase === 'manipulate' && _viewState.currentPlayer === _viewSelf) {
      // Sort the current workspace hand without restoring tiles already placed.
      _handBox = resolveDisplayHand(_handBox);
    }
    document.getElementById('rkOrderMenu').open = false;
    renderOrderView();
  }

  function arrangeTable() {
    cancelDrag();
    if (!_viewState) return;
    if (_viewState.phase === 'manipulate' && _viewState.currentPlayer === _viewSelf) {
      _boxes = _boxes.map(Ordering.normalizeTableSet);
    } else {
      (_viewState.table || []).forEach(function(set, index) {
        var ordered = Ordering.normalizeTableSet(set);
        _tableOrders.set(index, { sourceIds: set.map(function(tile) { return tile.id; }),
          ids: ordered.map(function(tile) { return tile.id; }) });
      });
    }
    document.getElementById('rkOrderMenu').open = false;
    renderOrderView();
  }

  function cancelDrag() {
    if (!_drag) return;
    var drag = _drag;
    _drag = null;
    if (drag.active) _suppressClickUntil = Date.now() + 300;
    if (drag.ghost) drag.ghost.remove();
    drag.node.classList.remove('rk-drag-source');
    if (drag.marker) drag.marker.classList.remove('rk-drop-before', 'rk-drop-after');
    try { if (drag.node.hasPointerCapture(drag.pointerId)) drag.node.releasePointerCapture(drag.pointerId); } catch (e) {}
  }

  function beginDrag(event, node, kind, boxIndex) {
    if (!_viewState || _viewState.winner !== null || event.button !== 0 || event.isPrimary === false) return;
    cancelDrag();
    // A fresh gesture is a real click even if the preceding drag's synthetic
    // click was retargeted to the container after its tiles were rebuilt.
    _suppressClickUntil = 0;
    _drag = { pointerId: event.pointerId, pointerType: event.pointerType,
      x: event.clientX, y: event.clientY, node: node, parent: node.parentElement,
      id: node.dataset.id, kind: kind, boxIndex: boxIndex, active: false, inside: false };
  }

  function moveDrag(event) {
    var drag = _drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    var dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 8) return;
      // Vertical touch gestures remain native scrolling. Start touch reorder sideways.
      if (drag.pointerType === 'touch' && Math.abs(dy) >= Math.abs(dx)) { cancelDrag(); return; }
      drag.active = true;
      var rect = drag.node.getBoundingClientRect();
      drag.offsetX = drag.x - rect.left;
      drag.offsetY = drag.y - rect.top;
      drag.ghost = drag.node.cloneNode(true);
      drag.ghost.className = 'rk-tile rk-drag-ghost ' +
        (drag.node.className.match(/rk-tile-(?:black|blue|red|orange|joker)/) || [''])[0];
      drag.ghost.setAttribute('aria-hidden', 'true');
      drag.ghost.removeAttribute('data-id');
      drag.ghost.style.width = rect.width + 'px';
      drag.ghost.style.height = rect.height + 'px';
      document.body.appendChild(drag.ghost);
      drag.node.classList.add('rk-drag-source');
      try { drag.node.setPointerCapture(drag.pointerId); } catch (e) {}
    }
    if (event.cancelable) event.preventDefault();
    drag.ghost.style.left = (event.clientX - drag.offsetX) + 'px';
    drag.ghost.style.top = (event.clientY - drag.offsetY) + 'px';
    if (drag.marker) drag.marker.classList.remove('rk-drop-before', 'rk-drop-after');
    var bounds = drag.parent.getBoundingClientRect();
    drag.inside = event.clientX >= bounds.left - 12 && event.clientX <= bounds.right + 12 &&
      event.clientY >= bounds.top - 12 && event.clientY <= bounds.bottom + 12;
    if (!drag.inside) return;
    var tiles = Array.from(drag.parent.querySelectorAll('.rk-tile')).filter(function(tile) { return tile !== drag.node; });
    var closest = null, distance = Infinity;
    tiles.forEach(function(tile) {
      var box = tile.getBoundingClientRect();
      var rowDistance = Math.max(box.top - event.clientY, 0, event.clientY - box.bottom);
      var value = Math.hypot(event.clientX - (box.left + box.width / 2), rowDistance * 3);
      if (value < distance) { distance = value; closest = tile; }
    });
    drag.beforeId = null;
    if (closest) {
      var box = closest.getBoundingClientRect();
      var before = event.clientX < box.left + box.width / 2;
      var next = tiles[tiles.indexOf(closest) + 1];
      drag.beforeId = before ? closest.dataset.id : next ? next.dataset.id : null;
      drag.marker = closest;
      closest.classList.add(before ? 'rk-drop-before' : 'rk-drop-after');
    }
  }

  function endDrag(event) {
    var drag = _drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active) {
      _suppressClickUntil = Date.now() + 300;
      if (event.cancelable) event.preventDefault();
    }
    var commit = drag.active && drag.inside;
    cancelDrag();
    if (!commit) return;
    if (drag.kind === 'hand') {
      _handOrder.reorder(_viewState.hands[_viewSelf], drag.id, drag.beforeId);
    } else if (drag.kind === 'handbox') {
      _handBox = Ordering.reorderTiles(_handBox, drag.id, drag.beforeId);
      // Replace only the slots belonging to the current workspace hand. Tiles
      // temporarily placed in groups retain their previous slots for cancel.
      var hand = _viewState.hands[_viewSelf];
      var owned = new Set(hand.map(function(tile) { return tile.id; }));
      var subset = _handBox.filter(function(tile) { return owned.has(tile.id); }).map(function(tile) { return tile.id; });
      var members = new Set(subset), cursor = 0;
      var ids = resolveDisplayHand(hand).map(function(tile) { return members.has(tile.id) ? subset[cursor++] : tile.id; });
      _handOrder.setManualOrder(hand, ids);
    } else {
      _boxes[drag.boxIndex] = Ordering.reorderTiles(_boxes[drag.boxIndex], drag.id, drag.beforeId);
    }
    renderOrderView();
  }

  document.addEventListener('pointermove', moveDrag, { passive: false });
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', function() { cancelDrag(); });
  document.addEventListener('click', function(event) {
    if (Date.now() <= _suppressClickUntil && _suppressClickUntil && event.target.closest('.rk-tile, .rk-box')) {
      _suppressClickUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    var menu = document.getElementById('rkOrderMenu');
    if (menu && !menu.contains(event.target)) menu.open = false;
  }, true);
  // Feedback compares immutable, owner-only snapshots, never local workspace edits.
  var _previousState = null;
  var _newTiles = Object.create(null);
  var _playedTiles = Object.create(null);
  var _effectTimers = [];
  var _turnTimer = null;
  var _soundEnabled = true;
  var _hasInteracted = false;
  var _audio = null;
  var _audioOutput = null;
  var SOUND_KEY = 'qingsi.rummikub.turnSound';

  function prepareAudio() {
    if (!_hasInteracted || !_soundEnabled) return null;
    try {
      var AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return null;
      if (!_audio) {
        _audio = new AudioContext();
        _audioOutput = _audio.createGain();
        _audioOutput.connect(_audio.destination);
      }
      return _audio;
    } catch (e) { return null; }
  }

  function onInteraction() {
    _hasInteracted = true;
    // Resume inside a gesture. Never queue a chime for later autoplay approval.
    if (!document.getElementById('rkSoundBtn')) return;
    var ctx = prepareAudio();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(function() {});
  }
  document.addEventListener('pointerdown', onInteraction, { passive: true });
  document.addEventListener('keydown', onInteraction);

  function playChime() {
    var ctx = prepareAudio();
    if (!ctx || ctx.state !== 'running') return;
    try {
      [523.25, 659.25].forEach(function(frequency, index) {
        var start = ctx.currentTime + index * 0.09;
        var oscillator = ctx.createOscillator();
        var envelope = ctx.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        envelope.gain.setValueAtTime(0, start);
        envelope.gain.linearRampToValueAtTime(0.025, start + 0.015);
        envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
        oscillator.connect(envelope);
        envelope.connect(_audioOutput);
        oscillator.onended = function() { oscillator.disconnect(); envelope.disconnect(); };
        oscillator.start(start);
        oscillator.stop(start + 0.25);
      });
    } catch (e) { /* Audio support must never interrupt the game. */ }
  }

  function renderSound() {
    var button = document.getElementById('rkSoundBtn');
    if (!button) return;
    button.textContent = _t(_soundEnabled ? 'rk_sound_on' : 'rk_sound_off');
    button.setAttribute('aria-pressed', String(_soundEnabled));
    button.title = _t(_soundEnabled ? 'rk_mute_sound' : 'rk_enable_sound');
  }

  function resetFeedback() {
    cancelDrag();
    if (_activity) _activity.resetSync();
    _previousState = null;
    _newTiles = Object.create(null);
    _playedTiles = Object.create(null);
    _effectTimers.forEach(clearTimeout);
    _effectTimers = [];
    clearTimeout(_turnTimer);
    var notice = document.getElementById('rkTurnNotice');
    if (notice) { notice.classList.remove('show'); notice.textContent = ''; }
    document.querySelectorAll('.rk-tile--new, .rk-tile--played').forEach(function(tile) {
      tile.classList.remove('rk-tile--new', 'rk-tile--played');
      tile.style.animationDelay = '';
    });
  }

  function showTurnNotice() {
    var notice = document.getElementById('rkTurnNotice');
    if (!notice) return;
    clearTimeout(_turnTimer);
    notice.classList.remove('show');
    notice.textContent = _t('rk_your_turn');
    void notice.offsetWidth;
    notice.classList.add('show');
    _turnTimer = setTimeout(function() {
      notice.classList.remove('show');
      notice.textContent = '';
    }, 1900);
    playChime();
  }

  function highlightTiles(ids, effects, className, duration) {
    var expiry = Date.now() + duration;
    ids.forEach(function(id) { effects[id] = expiry; });
    var timer = setTimeout(function() {
      ids.forEach(function(id) {
        if (effects[id] === expiry) delete effects[id];
      });
      document.querySelectorAll('.' + className).forEach(function(tile) {
        if (!effects[tile.dataset.id]) {
          tile.classList.remove(className);
          tile.style.animationDelay = '';
        }
      });
      _effectTimers = _effectTimers.filter(function(value) { return value !== timer; });
    }, duration);
    _effectTimers.push(timer);
  }

  function trackFeedback(state, selfIdx) {
    var hand = state.hands[selfIdx];
    if (!hand || hand.some(function(tile) { return !tile || !tile.id; })) {
      resetFeedback();
      return;
    }
    var tableIds = (state.table || []).map(function(group) {
      return group.map(function(tile) { return tile.id; });
    });
    var next = {
      self: selfIdx, currentPlayer: state.currentPlayer, phase: state.phase,
      winner: state.winner, hand: new Set(hand.map(function(tile) { return tile.id; })),
      table: new Set([].concat.apply([], tableIds)), tableKey: JSON.stringify(tableIds),
      poolCount: state.pool ? state.pool.length : 0,
      hasPlayed: !!(state.playedThisTurn && state.playedThisTurn[selfIdx])
    };
    var previous = _previousState;
    _previousState = next;
    if (!previous || previous.self !== selfIdx || previous.winner !== null) return;
    if (previous.currentPlayer !== selfIdx && previous.currentPlayer >= 0 &&
        previous.currentPlayer < state.hands.length && next.currentPlayer === selfIdx &&
        next.winner === null && next.phase === 'play') showTurnNotice();

    var added = Array.from(next.hand).filter(function(id) { return !previous.hand.has(id); });
    var removed = Array.from(previous.hand).filter(function(id) { return !next.hand.has(id); });
    if (previous.currentPlayer === selfIdx && next.currentPlayer !== selfIdx &&
        previous.phase === 'play' && next.phase === 'play' && next.winner === null &&
        !previous.hasPlayed && !next.hasPlayed && added.length === 1 && removed.length === 0 &&
        previous.poolCount === next.poolCount + 1 && previous.tableKey === next.tableKey) {
      highlightTiles(added, _newTiles, 'rk-tile--new', 2200);
    }
    var played = removed.filter(function(id) { return next.table.has(id) && !previous.table.has(id); });
    if (previous.currentPlayer === selfIdx && next.currentPlayer === selfIdx &&
        (previous.phase === 'play' || previous.phase === 'manipulate') &&
        (next.phase === 'play' || next.phase === 'over') &&
        (next.hasPlayed || next.winner === selfIdx) && added.length === 0 &&
        played.length > 0 && played.length === removed.length) {
      highlightTiles(played, _playedTiles, 'rk-tile--played', 1500);
    }
  }

  // Client-side set validity (mirrors games/rummikub.js) for live colour feedback
  function clientValidSet(tiles) {
    if (!tiles || tiles.length < 3) return false;
    var nonWild = tiles.filter(function(t){ return !t.wild; });
    if (nonWild.length === 0) return false;
    var nums = nonWild.map(function(t){ return t.num; });
    var colors = nonWild.map(function(t){ return t.color; });
    var uniqNums = {}, uniqColors = {};
    nums.forEach(function(n){ uniqNums[n] = 1; });
    colors.forEach(function(c){ uniqColors[c] = 1; });
    var wilds = tiles.length - nonWild.length;
    // group: same number, distinct colours, 3-4 tiles
    if (Object.keys(uniqNums).length === 1) {
      if (Object.keys(uniqColors).length !== nonWild.length) return false;
      return tiles.length >= 3 && tiles.length <= 4;
    }
    // run: same colour, consecutive (wilds fill gaps)
    if (Object.keys(uniqColors).length === 1) {
      var sorted = nums.slice().sort(function(a,b){ return a-b; });
      for (var i = 1; i < sorted.length; i++) { if (sorted[i] === sorted[i-1]) return false; }
      var gaps = 0;
      for (var k = 1; k < sorted.length; k++) gaps += sorted[k] - sorted[k-1] - 1;
      if (gaps > wilds) return false;
      return tiles.length <= 13;
    }
    return false;
  }

  var STYLES = '' +
    '.rk-game{width:100%;display:flex;flex-direction:column;gap:8px;}' +
    '.rk-opponents{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;}' +
    '.rk-opp{background:var(--bg);border-radius:14px;padding:10px 14px;text-align:center;min-width:75px;border:2px solid transparent;}' +
    '.rk-opp.active{border-color:var(--accent);background:var(--surface);box-shadow:0 0 12px rgba(137,213,213,.12);}' +
    '.rk-opp.me.active{background:var(--accent-dim);}' +
    '.rk-turn-label{font-size:11px;color:var(--accent);min-height:16px;}' +
    '.rk-opp.active .rk-turn-label::before{content:"";display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:var(--accent);}' +
    '.rk-opp .rk-opp-name{font-size:13px;font-weight:600;}' +
    '.rk-opp .rk-opp-count{font-size:20px;font-weight:800;}' +
    '.rk-opp .rk-opp-badge{font-size:11px;color:var(--accent);}' +
    '.rk-table-area{background:var(--bg);border-radius:10px;padding:12px;min-height:80px;min-width:0;display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;align-content:flex-start;overflow-y:auto;}' +
    '.rk-table-set{display:flex;flex-wrap:wrap;flex:0 0 auto;max-width:100%;gap:3px;padding:6px;background:var(--surface);box-sizing:border-box;border-radius:7px;border:1px solid var(--border);position:relative;transition:border-color .2s;}' +
    '.rk-table-set[data-set]{cursor:pointer;}' +
    '.rk-table-set:hover{border-color:var(--accent);}' +
    '.rk-table-set.target{border-color:var(--accent);box-shadow:0 0 0 3px rgba(200,164,92,0.3);}' +
    '.rk-table-set.set-invalid{border-color:#e74c3c;}' +
    '.rk-tile{width:38px;height:54px;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:700;box-shadow:0 2px 5px rgba(0,0,0,.12);flex-shrink:0;cursor:pointer;transition:transform .12s,box-shadow .12s;position:relative;}' +
    '.rk-tile:active{transform:scale(.93);}' +
    '.rk-tile.selected{transform:translateY(-10px);box-shadow:0 6px 14px rgba(0,0,0,.25);}' +
    '.rk-tile .rk-num{font-size:22px;line-height:1;}' +
    '.rk-tile .rk-color-dot{width:8px;height:8px;border-radius:50%;margin-top:3px;}' +
    '.rk-tile-joker{background:linear-gradient(145deg,#c8a45c,#a8863a);color:#fff;}' +
    '.rk-tile-black{background:linear-gradient(145deg,#444,#222);color:#fff;}' +
    '.rk-tile-blue{background:linear-gradient(145deg,#2980b9,#1a5276);color:#fff;}' +
    '.rk-tile-red{background:linear-gradient(145deg,#e74c3c,#922b21);color:#fff;}' +
    '.rk-tile-orange{background:linear-gradient(145deg,#e67e22,#935116);color:#fff;}' +
    '.rk-hand-wrap{overflow:visible;padding:4px 2px;margin:0 -4px;}' +
    '.rk-hand{display:flex;flex-wrap:wrap;gap:5px;min-height:70px;padding:4px;}' +
    '.rk-info{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:4px 0;}' +
    '.rk-sound{margin-left:auto;min-height:36px;}' +
    '.rk-order-menu{position:relative;font-size:12px;}' +
    '.rk-order-menu summary{display:flex;align-items:center;min-height:44px;padding:7px 10px;border:1px solid var(--border);border-radius:3px;list-style:none;cursor:pointer;color:var(--accent);white-space:nowrap;}' +
    '.rk-order-menu summary::-webkit-details-marker{display:none;}' +
    '.rk-order-popover{position:absolute;top:calc(100% + 4px);left:0;z-index:46;width:200px;max-width:calc(100vw - 50px);padding:6px;background:var(--surface);border:1px solid var(--border);border-radius:5px;box-shadow:0 8px 24px rgba(0,0,0,.3);}' +
    '.rk-order-popover .btn{display:flex;width:100%;justify-content:flex-start;font-size:12px;padding:7px 10px;border:0;}' +
    '.rk-order-help{display:block;padding:6px 10px;font-size:11px;line-height:1.5;color:var(--text-muted);}' +
    '.rk-hand .rk-tile,.rk-box .rk-tile{touch-action:pan-y;}' +
    '.rk-drag-source{opacity:.3;outline:1px dashed var(--accent);}' +
    '.rk-drag-ghost{position:fixed;z-index:120;pointer-events:none;opacity:.95;transform:scale(1.04);transition:transform .18s;box-shadow:0 6px 18px rgba(0,0,0,.4);}' +
    '.rk-drop-before::before,.rk-drop-after::after{content:"";position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--accent);pointer-events:none;}' +
    '.rk-drop-before::before{left:-4px;}.rk-drop-after::after{right:-4px;}' +
    '.rk-info .rk-break{font-size:12px;font-weight:600;padding:4px 12px;border-radius:12px;}' +
    '.rk-info .rk-break.done{background:var(--accent-dim);color:var(--accent);}' +
    '.rk-info .rk-break.need{background:#ffeaea;color:#e74c3c;}' +
    '.rk-pool-info{font-size:13px;color:var(--text-muted);}' +
    '.rk-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;}' +
    '.rk-actions .btn{width:auto;}' +
    '.rk-status{text-align:center;font-size:14px;color:var(--text-muted);min-height:20px;}' +
    '.rk-workspace{background:var(--bg);border-radius:16px;border:2px dashed var(--accent);padding:12px;min-height:50px;display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;}' +
    '.rk-ws-label{width:100%;font-size:12px;color:var(--accent);font-weight:600;margin-bottom:2px;}' +
    '.rk-manip-group{display:flex;gap:3px;padding:6px;background:var(--surface);border-radius:10px;border:2px solid var(--accent);position:relative;}' +
    '.rk-table-set.sel-target{border-color:#5a9e6f;box-shadow:0 0 0 3px rgba(90,158,111,0.3);}' +
    '.rk-boxes{display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px;width:100%;}' +
    '.rk-box{display:flex;flex-wrap:wrap;max-width:100%;box-sizing:border-box;gap:3px;padding:8px;min-width:58px;min-height:62px;background:var(--surface);border-radius:10px;border:2px solid var(--border);align-items:center;cursor:pointer;position:relative;transition:border-color .15s,box-shadow .15s;}' +
    '.rk-box.ok{border-color:#5a9e6f;box-shadow:0 0 0 2px rgba(90,158,111,.18);}' +
    '.rk-box.bad{border-color:#e74c3c;box-shadow:0 0 0 2px rgba(231,76,60,.18);}' +
    '.rk-box.empty{border-style:dashed;color:var(--text-muted);font-size:12px;justify-content:center;}' +
    '.rk-box-new{border-style:dashed;border-color:var(--accent);color:var(--accent);font-size:13px;font-weight:600;justify-content:center;min-width:96px;cursor:pointer;}' +
    '.rk-handbox{width:100%;border-style:dashed;border-color:var(--accent);background:var(--accent-dim);min-height:70px;}' +
    '.rk-box-tag{position:absolute;top:-9px;left:6px;background:var(--text-muted);color:#fff;font-size:9px;padding:1px 6px;border-radius:8px;font-weight:600;}' +
    '.rk-box.ok .rk-box-tag{background:#5a9e6f;}' +
    '.rk-box.bad .rk-box-tag{background:#e74c3c;}' +
    '.rk-turn-notice{position:fixed;top:35%;left:50%;transform:translate(-50%,-50%);z-index:45;pointer-events:none;opacity:0;padding:16px 30px;border:1px solid var(--accent);border-radius:8px;background:var(--surface);color:var(--accent);font-size:clamp(24px,3vw,36px);font-weight:700;white-space:nowrap;box-shadow:0 8px 40px rgba(0,0,0,.3);}' +
    '.rk-turn-notice.show{animation:rk-turn-notice 1.9s ease both;}' +
    '.rk-tile--new{outline:2px solid var(--accent);outline-offset:2px;animation:rk-new-tile 2.2s ease both;}' +
    '.rk-tile--played{outline:2px solid var(--accent);outline-offset:1px;animation:rk-played-tile 1.5s ease both;}' +
    '@keyframes rk-turn-notice{0%{opacity:0;transform:translate(-50%,-40%) scale(.94);}15%,75%{opacity:1;transform:translate(-50%,-50%) scale(1);}100%{opacity:0;transform:translate(-50%,-60%) scale(1.02);}}' +
    '@keyframes rk-new-tile{0%,100%{translate:0 0;box-shadow:0 2px 5px rgba(0,0,0,.12);}20%,55%{translate:0 -5px;box-shadow:0 0 16px rgba(137,213,213,.65);}38%,75%{translate:0 0;box-shadow:0 0 7px rgba(137,213,213,.3);}}' +
    '@keyframes rk-played-tile{0%,100%{box-shadow:0 2px 5px rgba(0,0,0,.12);}25%,65%{box-shadow:0 0 15px rgba(137,213,213,.6);}}' +
    'body.game-page.rk-playing{--bg:var(--qs-bg);--surface:var(--qs-panel-raised);--accent:var(--qs-cyan);--accent-dim:var(--qs-cyan-deep);--border:var(--qs-line);--text-muted:var(--qs-muted);padding:12px max(12px,env(safe-area-inset-right)) calc(12px + var(--safe-bottom)) max(12px,env(safe-area-inset-left));padding-top:max(12px,env(safe-area-inset-top));height:100dvh;overflow-y:hidden;}' +
    '.game-page.rk-playing .game-page-shell{max-width:none;min-height:0;height:100%;gap:10px;}' +
    '.game-page.rk-playing .game-topbar{flex-shrink:0;min-height:48px;padding-bottom:8px;}' +
    '.game-page.rk-playing .room-stage{min-height:0;}' +
    '.game-page.rk-playing .game-stage-panel{min-height:0;gap:8px;padding:12px;overflow:hidden;}' +
    '.game-page.rk-playing .game-stage-header{padding-bottom:6px;}' +
    '.game-page.rk-playing .board-wrap.stage-board{align-items:stretch;min-height:0;padding:0;}' +
    '.game-page.rk-playing #boardArea{display:flex;min-height:0;}' +
    '.game-page.rk-playing .rk-game{min-height:0;}' +
    '.game-page.rk-playing .rk-game>*{flex-shrink:0;}' +
    '.game-page.rk-playing .rk-table-area{flex:1 1 80px;}' +
    '.game-page.rk-playing .rk-hand-wrap{max-height:28vh;max-height:28dvh;overflow-y:auto;margin:0;}' +
    '.game-page.rk-playing .rk-hand{min-height:62px;padding-top:12px;}' +
    '.game-page.rk-playing .rk-hand-wrap[hidden]{display:none;}' +
    '.game-page.rk-playing #status,.game-page.rk-playing #playerBar{display:none!important;}' +
    '.game-page.rk-playing .rk-opp{display:grid;grid-template-columns:auto auto;column-gap:12px;align-items:center;padding:6px 10px;border-radius:5px;border-width:1px;min-width:0;}' +
    '.game-page.rk-playing .rk-opponents{justify-content:flex-start;gap:6px;}' +
    '.game-page.rk-playing .rk-opp-count{font-size:18px;}' +
    '.game-page.rk-playing .rk-opp-name{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
    '.game-page.rk-playing .rk-break.need{background:rgba(231,155,148,.12);color:var(--qs-error);}' +
    '@media(prefers-reduced-motion:reduce){.rk-tile--new,.rk-tile--played{animation:none;box-shadow:0 0 10px rgba(137,213,213,.5);}.rk-turn-notice.show{animation:none;opacity:1;}}' +
    '@media(max-height:600px){.game-page.rk-playing .game-stage-header{display:none;}.game-page.rk-playing .rk-status{display:none;}}' +
    '@media(max-height:450px){body.game-page.rk-playing{height:auto;min-height:100dvh;overflow-y:auto;}.game-page.rk-playing .rk-table-area{flex:none;max-height:50dvh;}.game-page.rk-playing .rk-hand-wrap{max-height:none;}}' +
    '@media(max-width:400px){.rk-table-area{padding:8px;gap:8px;}.rk-table-set{padding:5px;}.rk-tile{width:34px;height:48px;}.rk-tile .rk-num{font-size:17px;}}' +
    '@media(max-width:400px){.game-page.rk-playing .rk-opp{flex:1 1 calc(50% - 3px);grid-template-columns:minmax(0,1fr) auto;column-gap:6px;padding:5px 7px;}.game-page.rk-playing .rk-opp-name{font-size:12px;}.game-page.rk-playing .rk-turn-label{font-size:10px;}.rk-info{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;}.rk-info .rk-break{padding:4px 6px;}.rk-order-menu{min-width:0;}.rk-order-menu summary{padding:7px 6px;overflow:hidden;}.rk-sound{margin-left:0;}.game-page.rk-playing .rk-actions .btn{font-size:12px;padding:8px 10px;}}' +
    '@media(max-width:400px) and (max-height:700px){.game-page.rk-playing .game-stage-header,.game-page.rk-playing .rk-status{display:none;}.game-page.rk-playing .rk-game{overflow-y:auto;}}' +
    '@media(max-width:360px){.rk-tile{width:30px;height:44px;}.rk-tile .rk-num{font-size:15px;}}' +
    '@media(max-width:320px){.rk-tile{width:28px;height:40px;}.rk-tile .rk-num{font-size:14px;}}';

  var COLOR_CSS = {
    black: 'rk-tile-black', blue: 'rk-tile-blue',
    red: 'rk-tile-red', orange: 'rk-tile-orange'
  };

  window.gameRenderers.set('rummikub', {
    init: function(container) {
      if (_activity) { _activity.dispose(); _activity = null; }
      _gameRenderKey = null;
      injectStylesOnce('rkStyles', STYLES);
      resetFeedback();
      resetHandOrder();
      try { _soundEnabled = window.localStorage.getItem(SOUND_KEY) !== 'off'; } catch (e) { _soundEnabled = true; }
      if (_audioOutput) _audioOutput.gain.value = _soundEnabled ? 1 : 0;
      selectedTiles = {};
      _targetSet = null;
      _boxes = [];
      _handBox = [];
      _sel = {};
      _manipInit = false;
      container.innerHTML =
        '<div class="rk-game">' +
          '<div class="rk-opponents" id="rkOpps"></div>' +
          '<div class="rk-info">' +
            '<span class="rk-break" id="rkBreakBadge" style="display:none"></span>' +
            '<span class="rk-pool-info" id="rkPoolInfo">' + _tf('rk_pool', 0) + '</span>' +
            '<details class="rk-order-menu" id="rkOrderMenu">' +
              '<summary id="rkOrderSummary"></summary>' +
              '<div class="rk-order-popover">' +
                '<button type="button" class="btn btn-outline btn-sm" id="rkAutoHandBtn">' + _t('rk_auto_hand') + '</button>' +
                '<button type="button" class="btn btn-outline btn-sm" id="rkOrderNumberBtn"></button>' +
                '<button type="button" class="btn btn-outline btn-sm" id="rkOrderColorBtn"></button>' +
                '<button type="button" class="btn btn-outline btn-sm" id="rkArrangeTableBtn">' + _t('rk_arrange_table') + '</button>' +
                '<span class="rk-order-help">' + _t('rk_order_drag_hint') + '</span>' +
              '</div>' +
            '</details>' +
            '<button type="button" class="btn btn-outline btn-sm rk-sound" id="rkSoundBtn"></button>' +
          '</div>' +
          '<div class="rk-play-layout" id="rkPlayLayout">' +
            '<div class="rk-table-area" id="rkTable"><div style="color:var(--text-muted);font-size:13px;padding:8px;">' + _t('rk_table_placeholder') + '</div></div>' +
          '</div>' +
          '<div class="rk-hand-wrap" id="rkHandWrap"><div class="rk-hand" id="rkHand"></div></div>' +
          '<div class="rk-actions" id="rkActions"></div>' +
          '<div class="rk-status" id="rkStatus"></div>' +
          '<div class="rk-turn-notice" id="rkTurnNotice" role="status" aria-live="polite" aria-atomic="true"></div>' +
        '</div>';
      _activity = window.createRummikubActivity(document.getElementById('rkPlayLayout'), {
        t: _t, tf: _tf,
        name: function(index) { return window.getPlayerName ? window.getPlayerName(index) : _t('rk_player_prefix') + ' ' + (index + 1); },
        send: function(data) { window.makeGameMove(data); }
      });
      ensureActionButtons();
      renderSound();
      renderOrderControls();
      document.getElementById('rkAutoHandBtn').addEventListener('click', function() { autoArrangeHand(); });
      document.getElementById('rkOrderNumberBtn').addEventListener('click', function() { autoArrangeHand('number'); });
      document.getElementById('rkOrderColorBtn').addEventListener('click', function() { autoArrangeHand('color'); });
      document.getElementById('rkArrangeTableBtn').addEventListener('click', arrangeTable);
      document.getElementById('rkSoundBtn').addEventListener('click', function() {
        _soundEnabled = !_soundEnabled;
        if (_audioOutput) _audioOutput.gain.value = _soundEnabled ? 1 : 0;
        try { window.localStorage.setItem(SOUND_KEY, _soundEnabled ? 'on' : 'off'); } catch (e) {}
        if (_soundEnabled) onInteraction();
        renderSound();
      });
    },

    resetFeedback: resetFeedback,
    resetHandOrder: resetHandOrder,
    activityError: function(code, message) { if (_activity) _activity.error(code, message); },

    render: function(state, container, playerIndex, winner) {
      if (!state || !state.hands || state.hands.length === 0) return;
      if (_viewState && state.timelineId && state.timelineId !== _viewState.timelineId) resetHandOrder();
      if (_orderSelfIdx !== playerIndex) { resetHandOrder(); _orderSelfIdx = playerIndex; }
      var ownCount = (state.hands[playerIndex] || []).length;
      if (_lastOrderPhase === 'manipulate' && state.phase !== 'manipulate' && ownCount < _lastHandCount) {
        // A successful submit replaces even unchanged groups' local overrides.
        // Cancel retains their pre-workspace display arrangements.
        _tableOrders.clear();
      }
      _lastOrderPhase = state.phase;
      _lastHandCount = ownCount;
      _viewState = state;
      _viewSelf = playerIndex;
      trackFeedback(state, playerIndex);
      _activity.render(state, playerIndex);
      // Chat-only updates append activity while keeping tiles, workspace, input
      // and an in-progress drag intact. Only game changes rebuild game surfaces.
      var renderKey = JSON.stringify([state.timelineId, playerIndex, state.currentPlayer, state.phase, state.winner,
        state.pool.length, state.table, state.hands[playerIndex], state.hands.map(function(hand) { return hand.length; }),
        state.hasBroken, state.playedThisTurn, state.requireBreak,
        state.hands.map(function(_, index) { return window.getPlayerName ? window.getPlayerName(index) : index; })]);
      if (_gameRenderKey === renderKey) return;
      _gameRenderKey = renderKey;
      cancelDrag();
      renderOpponents(state, playerIndex);
      renderInfo(state, playerIndex);
      var manipulating = state.phase === 'manipulate' && state.currentPlayer === playerIndex;
      document.getElementById('rkHandWrap').hidden = manipulating;
      if (state.phase === 'manipulate' && state.currentPlayer === playerIndex) {
        renderManipulate(state, playerIndex);
      } else {
        _manipInit = false; // leaving manipulate; reseed next time
        renderTable(state, playerIndex);
        renderHand(state, playerIndex);
        renderActions(state, playerIndex);
      }
      renderStatus(state, playerIndex);
    }
  });

  // ---- MANIPULATE MODE (box-based: each set is its own box; move tiles by select→target) ----
  function seedBoxes(state, selfIdx) {
    _boxes = (state.table || []).map(function(set, index){ return resolveDisplayTableSet(set, index).slice(); });
    _handBox = resolveDisplayHand(state.hands[selfIdx]);
    _sel = {};
    _manipInit = true;
  }

  function moveSelectedTo(target) { // target: 'hand' or a box index
    var moving = [];
    var pull = function(arr) {
      for (var i = arr.length - 1; i >= 0; i--) {
        if (_sel[arr[i].id]) { moving.unshift(arr[i]); arr.splice(i, 1); }
      }
    };
    for (var b = 0; b < _boxes.length; b++) pull(_boxes[b]);
    pull(_handBox);
    if (moving.length === 0) return false;
    if (target === 'hand') { _handBox = _handBox.concat(moving); }
    else { _boxes[target] = _boxes[target].concat(moving); }
    _sel = {};
    return true;
  }

  function renderManipulate(state, selfIdx) {
    if (!_manipInit) seedBoxes(state, selfIdx);
    var poolEl = document.getElementById('rkPoolInfo');
    if (poolEl) poolEl.textContent = _tf('rk_pool', state.pool ? state.pool.length : 0);

    var tableEl = document.getElementById('rkTable');
    if (tableEl) {
      var html = '<div class="rk-ws-label">' + _t('rk_manip_instructions') + '</div>';
      html += '<div class="rk-boxes">';
      for (var i = 0; i < _boxes.length; i++) {
        var box = _boxes[i];
        var cls = box.length === 0 ? 'empty' : (clientValidSet(box) ? 'ok' : 'bad');
        html += '<div class="rk-box ' + cls + '" data-box="' + i + '">';
        html += '<span class="rk-box-tag">' + (box.length === 0 ? _t('rk_empty') : box.length + _t('rk_tiles_suffix')) + '</span>';
        for (var t = 0; t < box.length; t++) html += tileHTML(box[t], _sel[box[t].id], 'table');
        if (box.length === 0) html += _t('rk_drop_here');
        html += '</div>';
      }
      html += '<div class="rk-box rk-box-new" data-newbox="1">' + _t('rk_new_group') + '</div>';
      html += '</div>';
      html += '<div class="rk-ws-label" style="margin-top:10px;">' + _t('rk_manip_hand_label') + '</div>';
      html += '<div class="rk-box rk-handbox" data-hand="1">';
      for (var h = 0; h < _handBox.length; h++) html += tileHTML(_handBox[h], _sel[_handBox[h].id], 'hand');
      html += '</div>';
      tableEl.innerHTML = html;

      if (state.currentPlayer === selfIdx) {
        // tile selection
        var tiles = tableEl.querySelectorAll('.rk-tile[data-id]');
        for (var j = 0; j < tiles.length; j++) {
          (function(el, id) {
            el.addEventListener('pointerdown', function(event) {
              var box = el.closest('.rk-box');
              beginDrag(event, el, box.dataset.hand ? 'handbox' : 'box', parseInt(box.dataset.box, 10));
            });
            el.addEventListener('click', function(e) {
              e.stopPropagation();
              var targetBox = el.closest('.rk-box');
              if (Object.keys(_sel).length > 0 && !_sel[id] && targetBox) {
                var target = targetBox.dataset.hand ? 'hand' : parseInt(targetBox.dataset.box, 10);
                if (target === 'hand' || !isNaN(target)) {
                  var targetTiles = target === 'hand' ? _handBox : _boxes[target];
                  var selectingWithinBox = targetTiles.some(function(tile) { return !!_sel[tile.id]; });
                  if (!selectingWithinBox) {
                    if (moveSelectedTo(target)) renderManipulate(state, selfIdx);
                    return;
                  }
                }
              }
              if (_sel[id]) delete _sel[id]; else _sel[id] = true;
              renderManipulate(state, selfIdx);
            });
          })(tiles[j], tiles[j].dataset.id);
        }
        // box drop targets
        var boxEls = tableEl.querySelectorAll('.rk-box[data-box]');
        for (var k = 0; k < boxEls.length; k++) {
          (function(el, idx) {
            el.addEventListener('click', function() { if (moveSelectedTo(idx)) renderManipulate(state, selfIdx); });
          })(boxEls[k], parseInt(boxEls[k].dataset.box));
        }
        var newBox = tableEl.querySelector('.rk-box-new');
        if (newBox) newBox.addEventListener('click', function() {
          _boxes.push([]);
          moveSelectedTo(_boxes.length - 1);
          renderManipulate(state, selfIdx);
        });
        var handDrop = tableEl.querySelector('.rk-handbox');
        if (handDrop) handDrop.addEventListener('click', function() { if (moveSelectedTo('hand')) renderManipulate(state, selfIdx); });
      }
    }

    var handEl = document.getElementById('rkHand');
    if (handEl) handEl.innerHTML = '';

    var actEl = document.getElementById('rkActions');
    if (actEl) {
      actEl.innerHTML =
        '<button class="btn btn-accent btn-sm" id="rkSubmitBtn">' + _t('rk_submit') + '</button>' +
        '<button class="btn btn-outline btn-sm" id="rkCancelBtn">' + _t('rk_cancel') + '</button>';
      if (state.currentPlayer === selfIdx) {
        document.getElementById('rkSubmitBtn').addEventListener('click', function() {
          var groups = _boxes.filter(function(b){ return b.length > 0; });
          for (var g = 0; g < groups.length; g++) {
            if (!clientValidSet(groups[g])) { showToast(_t('rk_invalid_groups')); return; }
          }
          if (groups.length === 0) { showToast(_t('rk_min_one_group')); return; }
          window.makeGameMove({ action: 'submit', groups: groups.map(function(b){ return b.slice(); }) });
          _manipInit = false;
        });
        document.getElementById('rkCancelBtn').addEventListener('click', function() {
          window.makeGameMove({ action: 'cancel' });
          _manipInit = false;
        });
      }
    }
  }

  // ---- OPPONENTS ----
  function renderOpponents(state, selfIdx) {
    var el = document.getElementById('rkOpps');
    if (!el) return;
    var html = '';
    for (var i = 0; i < state.hands.length; i++) {
      var count = state.hands[i] ? state.hands[i].length : 0;
      var active = i === state.currentPlayer && state.winner === null ? ' active' : '';
      if (i === selfIdx) active += ' me';
      var brokenHtml = '';
      if (state.requireBreak) {
        brokenHtml = state.hasBroken && state.hasBroken[i]
          ? '<div class="rk-opp-badge">' + _t('rk_broken_badge') + '</div>'
          : '<div style="font-size:11px;color:var(--text-muted)">' + _t('rk_not_broken_badge') + '</div>';
      }
      html += '<div class="rk-opp' + active + '"><div class="rk-opp-name">' +
        window.escapeGameHtml(window.getPlayerName ? window.getPlayerName(i) : (_t('rk_player_prefix') + ' ' + (i + 1))) +
        (i === selfIdx ? ' · ' + _t('rk_you') : '') + '</div>' +
        '<div class="rk-opp-count">' + count + '</div>' + brokenHtml +
        '<div class="rk-turn-label">' + (i === state.currentPlayer && state.winner === null ?
          _t(i === selfIdx ? 'rk_your_turn' : 'rk_current_turn') : '') + '</div></div>';
    }
    el.innerHTML = html;
  }

  // ---- INFO BAR ----
  function renderInfo(state, selfIdx) {
    var badge = document.getElementById('rkBreakBadge');
    if (badge) {
      if (!state.requireBreak) {
        badge.style.display = 'none';
      } else {
        badge.style.display = '';
        if (state.hasBroken && state.hasBroken[selfIdx]) {
          badge.className = 'rk-break done'; badge.textContent = _t('rk_broken_done');
        } else {
          badge.className = 'rk-break need'; badge.textContent = _t('rk_need_break');
        }
      }
    }
    var pi = document.getElementById('rkPoolInfo');
    if (pi) pi.textContent = _tf('rk_pool', state.pool ? state.pool.length : 0);
    renderSound();
    renderOrderControls();
  }

  // ---- TABLE RENDER ----
  function renderTable(state, selfIdx) {
    var el = document.getElementById('rkTable');
    if (!el) return;
    if (!state.table || state.table.length === 0) {
      el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">' + _t('rk_table_placeholder') + '</div>';
      return;
    }
    var isMyTurn = state.currentPlayer === selfIdx && state.winner === null;
    var selCount = Object.keys(selectedTiles).length;
    var html = '';
    for (var s = 0; s < state.table.length; s++) {
      var set = resolveDisplayTableSet(state.table[s], s);
      var targetClass = (_targetSet === s) ? ' sel-target' : '';
      var clickable = (isMyTurn && selCount === 1) ? ' data-set="' + s + '"' : '';
      html += '<div class="rk-table-set' + targetClass + '"' + clickable + '>';
      for (var t = 0; t < set.length; t++) {
        html += tileHTML(set[t], false, 'table');
      }
      html += '</div>';
    }
    el.innerHTML = html;

    // Attach click handlers for table sets (target selection for 1-tile add)
    if (isMyTurn && selCount === 1) {
      var sets = el.querySelectorAll('.rk-table-set[data-set]');
      for (var i = 0; i < sets.length; i++) {
        (function(el, idx) {
          el.addEventListener('click', function(e) {
            _targetSet = (_targetSet === idx) ? null : idx;
            renderTable(state, selfIdx);
          });
        })(sets[i], parseInt(sets[i].dataset.set));
      }
    }
  }

  function tileHTML(tile, isSelected, location) {
    var cls = tile.wild ? 'rk-tile-joker' : (COLOR_CSS[tile.color] || '');
    if (isSelected) cls += ' selected';
    var effects = location === 'hand' ? _newTiles : _playedTiles;
    var duration = location === 'hand' ? 2200 : 1500;
    var remaining = effects[tile.id] - Date.now();
    var animation = '';
    if (remaining > 0) {
      cls += location === 'hand' ? ' rk-tile--new' : ' rk-tile--played';
      // Selection and WS rerenders retain the original animation timeline.
      animation = ' style="animation-delay:' + (remaining - duration) + 'ms"';
    }
    return '<div class="rk-tile ' + cls + '" data-id="' + tile.id + '"' + animation + '>' +
      '<div class="rk-num">' + (tile.wild ? '★' : tile.num) + '</div></div>';
  }

  // ---- HAND ----
  function renderHand(state, selfIdx) {
    var el = document.getElementById('rkHand');
    if (!el) return;
    var hand = resolveDisplayHand(state.hands[selfIdx]);
    if (!hand || hand.length === 0) { el.innerHTML = ''; return; }
    var isMyTurn = state.currentPlayer === selfIdx && state.winner === null;
    var html = '';
    for (var i = 0; i < hand.length; i++) {
      var c = hand[i];
      var sel = selectedTiles[c.id] ? true : false;
      html += tileHTML(c, sel, 'hand');
    }
    el.innerHTML = html;

    var tiles = el.children;
    for (var j = 0; j < tiles.length; j++) {
      (function(el, tile) {
        el.addEventListener('pointerdown', function(event) { beginDrag(event, el, 'hand'); });
        if (isMyTurn) {
          el.addEventListener('click', function() {
            if (selectedTiles[tile.id]) {
              delete selectedTiles[tile.id];
            } else {
              selectedTiles[tile.id] = true;
            }
            // Re-render to update selection and table target availability
            renderHand(state, selfIdx);
            renderTable(state, selfIdx);
          });
        }
      })(tiles[j], hand[j]);
    }

  }

  // ---- ACTIONS ----
  function ensureActionButtons() {
    var actions = document.getElementById('rkActions');
    if (!actions || document.getElementById('rkPlayBtn')) return;
    actions.innerHTML =
      '<button class="btn btn-primary btn-sm" id="rkPlayBtn">' + _t('rk_play') + '</button>' +
      '<button class="btn btn-accent btn-sm" id="rkManipBtn">' + _t('rk_manipulate_short') + '</button>' +
      '<button class="btn btn-outline btn-sm" id="rkEndTurnBtn">' + _t('rk_end_turn') + '</button>' +
      '<button class="btn btn-outline btn-sm" id="rkDrawBtn">' + _t('rk_draw_end') + '</button>';
    document.getElementById('rkPlayBtn').addEventListener('click', function() {
      var ids = Object.keys(selectedTiles);
      if (ids.length === 0) { showToast(_t('rk_select_tiles_first')); return; }
      var data = { tileIds: ids };
      if (ids.length === 1 && _targetSet !== null) data.targetSet = _targetSet;
      selectedTiles = {}; _targetSet = null; window.makeGameMove(data);
    });
    document.getElementById('rkManipBtn').addEventListener('click', function() { window.makeGameMove({ action: 'start_manipulate' }); });
    document.getElementById('rkEndTurnBtn').addEventListener('click', function() { window.makeGameMove({ endTurn: true }); });
    document.getElementById('rkDrawBtn').addEventListener('click', function() { selectedTiles = {}; _targetSet = null; window.makeGameMove({ pass: true }); });
  }

  function renderActions(state, selfIdx) {
    ensureActionButtons();
    var playBtn = document.getElementById('rkPlayBtn');
    var manipBtn = document.getElementById('rkManipBtn');
    var endBtn = document.getElementById('rkEndTurnBtn');
    var drawBtn = document.getElementById('rkDrawBtn');

    var isMyTurn = state.currentPlayer === selfIdx && state.winner === null;
    var hasPlayed = state.playedThisTurn && state.playedThisTurn[selfIdx];
    var hasTable = state.table && state.table.length > 0;

    if (playBtn) playBtn.style.display = isMyTurn ? '' : 'none';
    if (manipBtn) manipBtn.style.display = (isMyTurn && hasTable) ? '' : 'none';
    if (endBtn) endBtn.style.display = (isMyTurn && hasPlayed) ? '' : 'none';
    if (drawBtn) drawBtn.style.display = (isMyTurn && !hasPlayed) ? '' : 'none';

    if (drawBtn && isMyTurn) {
      drawBtn.textContent = _t('rk_draw_end');
    }
  }

  // ---- STATUS ----
  function renderStatus(state, selfIdx) {
    var el = document.getElementById('rkStatus');
    if (!el) return;
    if (state.winner !== null) {
      el.textContent = state.winner === selfIdx ? _t('rk_you_win') :
        (window.getPlayerName ? window.getPlayerName(state.winner) : (_t('rk_player_prefix') + ' ' + (state.winner + 1))) + ' ' + _t('rk_rummikub');
    } else if (state.currentPlayer === selfIdx) {
      if (state.requireBreak && state.hasBroken && !state.hasBroken[selfIdx]) {
        el.textContent = _t('rk_break_requirement');
      } else {
        el.textContent = _t('rk_turn_prompt');
      }
    } else {
      el.textContent = _t('rk_waiting');
    }
  }

  function showToast(msg) {
    var t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(function() { t.classList.remove('show'); }, 2000);
  }
})();
