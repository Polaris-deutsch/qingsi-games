// public/js/renderers/sudoku.js
// Sudoku — Multiplayer speed race renderer. Canvas grid + number pad + lives + hints + timer.
(function () {
  window.gameRenderers = window.gameRenderers || new Map();

  var N = 9;
  var canvas, ctx, _layout = { ox: 0, oy: 0, cell: 0, size: 0 };
  var _selected = null;   // {r, c} cell chosen by the player
  var _pending = null;    // {r, c, val} fill sent to server, awaiting resolution
  var _flash = null;      // {r, c, start} red-flash animation for a wrong fill
  var _flashRaf = null;
  var _timerEnd = 0;      // epoch ms when the game ended (freeze timer display)
  var _timerRaf = null;   // interval handle for the live timer
  var _inited = false;

  var ACCENT = '#c8a45c';
  var ACCENT_SOFT = 'rgba(200,164,92,0.18)';

  // _t returns the key when missing; provide sane fallbacks so the renderer
  // works without dedicated lang keys (lang files are managed separately).
  function t(key, fallback) {
    var v = window._t ? window._t(key) : key;
    return v === key ? fallback : v;
  }

  var STYLES = ''
    + '.su-wrap{display:flex;flex-direction:column;align-items:center;gap:10px;width:100%;}'
    + '.su-status{text-align:center;font-size:15px;font-weight:700;min-height:22px;letter-spacing:.3px;}'
    + '.su-timer{text-align:center;font-size:14px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--text-muted);min-height:20px;letter-spacing:.5px;}'
    + '.su-lives{display:flex;gap:4px;font-size:22px;line-height:1;min-height:26px;align-items:center;}'
    + '.su-lives .hp{transition:transform .2s,opacity .2s;}'
    + '.su-lives .hp.lost{opacity:.25;transform:scale(.7);}'
    + '.su-board-wrap{display:flex;justify-content:center;touch-action:manipulation;}'
    + '.su-board-wrap canvas{display:block;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.18);touch-action:manipulation;}'
    + '.su-controls{display:flex;gap:8px;width:100%;max-width:360px;align-items:center;}'
    + '.su-hint{flex:1;height:48px;border:1px solid var(--border);border-radius:12px;background:var(--surface);font-size:15px;font-weight:700;color:var(--text);cursor:pointer;transition:transform .08s,background .15s;user-select:none;-webkit-user-select:none;display:flex;align-items:center;justify-content:center;gap:6px;}'
    + '.su-hint:active{transform:scale(.95);}'
    + '.su-hint[disabled]{opacity:.35;cursor:default;}'
    + '.su-hint-badge{font-size:13px;font-weight:600;color:var(--accent);}'
    + '.su-pad{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;width:100%;max-width:360px;}'
    + '.su-num{height:52px;border:1px solid var(--border);border-radius:12px;background:var(--surface);font-size:20px;font-weight:700;color:var(--text);cursor:pointer;transition:transform .08s,background .15s;user-select:none;-webkit-user-select:none;}'
    + '.su-num:active{transform:scale(.93);}'
    + '.su-num.selected{background:var(--accent);color:#1a1a1a;border-color:var(--accent);}'
    + '.su-num[disabled]{opacity:.3;cursor:default;}'
    + '.su-num-clear{font-size:18px;color:var(--text-muted);}'
    + '@media(min-width:768px){.su-num{height:60px;font-size:22px;}}';

  function computeLayout() {
    var maxBoard = Math.min(window.innerWidth - 24, 520, window.innerHeight * 0.5);
    maxBoard = Math.max(maxBoard, 240);
    var size = Math.floor(maxBoard);
    var cell = size / N;
    _layout.size = size;
    _layout.cell = cell;
    _layout.ox = 0;
    _layout.oy = 0;

    var dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }

  function drawFrame() {
    var state = window._suState;
    var cell = _layout.cell;
    var size = _layout.size;
    if (!ctx) return;
    ctx.clearRect(0, 0, size, size);

    // Board background
    ctx.fillStyle = '#2b2f38';
    ctx.fillRect(0, 0, size, size);

    if (!state || !state.board) return;

    var now = performance.now();
    var flashT = _flash ? Math.min((now - _flash.start) / 400, 1) : -1;

    for (var r = 0; r < N; r++) {
      for (var c = 0; c < N; c++) {
        var x = _layout.ox + c * cell;
        var y = _layout.oy + r * cell;
        var cellData = state.board[r][c];

        // Cell background
        var bg = '#3a3f4b';
        if (_selected && _selected.r === r && _selected.c === c) bg = ACCENT_SOFT;
        if (_flash && _flash.r === r && _flash.c === c) {
          // Red flash fading out
          var alpha = (1 - flashT) * 0.7;
          bg = 'rgba(231,76,60,' + alpha.toFixed(3) + ')';
        }
        ctx.fillStyle = bg;
        ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2);

        // Number
        var val = cellData.value;
        if (val > 0) {
          if (cellData.given) ctx.fillStyle = '#d0d0d0';
          else if (cellData.mineFill) ctx.fillStyle = ACCENT;
          else ctx.fillStyle = '#e0e0e0';
          ctx.font = 'bold ' + Math.floor(cell * 0.5) + 'px system-ui,-apple-system,sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(val), x + cell / 2, y + cell / 2 + 1);
        }
      }
    }

    // Grid lines
    ctx.strokeStyle = '#555a66';
    ctx.lineWidth = 1;
    for (var i = 0; i <= N; i++) {
      var p = Math.round(i * cell) + 0.5;
      ctx.beginPath();
      ctx.moveTo(p, 0); ctx.lineTo(p, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p); ctx.lineTo(size, p);
      ctx.stroke();
    }

    // Bold 3x3 borders
    ctx.strokeStyle = '#c8a45c';
    ctx.lineWidth = 2.5;
    for (var b = 0; b <= N; b += 3) {
      var q = Math.round(b * cell) + 0.5;
      ctx.beginPath();
      ctx.moveTo(q, 0); ctx.lineTo(q, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, q); ctx.lineTo(size, q);
      ctx.stroke();
    }
  }

  function flashTick(now) {
    if (!_flash) { _flashRaf = null; drawFrame(); return; }
    drawFrame();
    if (now - _flash.start > 400) { _flash = null; _flashRaf = null; drawFrame(); return; }
    _flashRaf = requestAnimationFrame(flashTick);
  }

  function startFlash(r, c) {
    _flash = { r: r, c: c, start: performance.now() };
    if (!_flashRaf) _flashRaf = requestAnimationFrame(flashTick);
  }

  function updatePad() {
    var pad = document.getElementById('suPad');
    if (!pad) return;
    var state = window._suState;
    var hasSel = _selected && state && state.winner === null && !state.eliminated
      && state.board[_selected.r][_selected.c].value === 0;
    var nums = pad.querySelectorAll('.su-num[data-v]');
    for (var i = 0; i < nums.length; i++) {
      var n = parseInt(nums[i].dataset.v);
      nums[i].classList.toggle('selected', hasSel && _pending && _pending.val === n);
      nums[i].disabled = !hasSel;
    }
  }

  function formatTime(ms) {
    var totalSec = Math.floor(ms / 1000);
    var m = Math.floor(totalSec / 60);
    var s = totalSec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function updateTimer(state) {
    var el = document.getElementById('suTimer');
    if (!el) return;
    if (!state || !state.startTime) { el.textContent = ''; return; }
    var end = (state.winner !== null && state.winner !== undefined) ? _timerEnd : Date.now();
    el.textContent = '⏱ ' + formatTime(end - state.startTime);
  }

  function startTimer(state) {
    if (_timerRaf) { clearInterval(_timerRaf); _timerRaf = null; }
    if (!state || !state.startTime) return;
    _timerEnd = 0;
    updateTimer(state);
    _timerRaf = setInterval(function () {
      var s = window._suState;
      if (!s || (s.winner !== null && s.winner !== undefined)) {
        if (_timerRaf) { clearInterval(_timerRaf); _timerRaf = null; }
        return;
      }
      updateTimer(s);
    }, 250);
  }

  function updateLives(state) {
    var el = document.getElementById('suLives');
    if (!el || !state) return;
    var lives = state.lives || 0;
    var html = '';
    for (var i = 0; i < 3; i++) {
      html += '<span class="hp' + (i < lives ? '' : ' lost') + '">❤️</span>';
    }
    el.innerHTML = html;
  }

  function updateHintBtn(state) {
    var btn = document.getElementById('suHint');
    if (!btn || !state) return;
    var hints = state.hints || 0;
    var dead = state.eliminated || state.winner !== null;
    btn.disabled = dead || hints <= 0;
    var badge = btn.querySelector('.su-hint-badge');
    if (badge) badge.textContent = '×' + hints;
  }

  function updateStatus(state, winner) {
    var el = document.getElementById('suStatus');
    if (!el) return;
    if (state && state.eliminated) {
      el.textContent = t('sudoku_dead', 'You are out');
      el.style.color = '#e74c3c';
      return;
    }
    if (winner !== null && winner !== undefined) {
      el.textContent = winner === -1 ? t('draw', 'Draw') : (winner === _playerIndex ? t('you_win', 'You Win!') : t('opponent_wins', 'Opponent Wins'));
      el.style.color = winner === _playerIndex ? ACCENT : 'var(--text-muted)';
    } else if (state) {
      el.textContent = t('sudoku_progress', 'Progress') + ' ' + state.doneCount + ' / ' + state.blanks;
      el.style.color = 'var(--text-muted)';
    }
  }

  window._sudokuSelect = function (r, c) {
    var state = window._suState;
    if (!state || state.winner !== null || state.eliminated) return;
    var cell = state.board[r][c];
    if (cell.given || cell.mineFill) return; // immutable or already solved
    _selected = { r: r, c: c };
    _pending = null;
    updatePad();
    drawFrame();
  };

  window._sudokuFill = function (val) {
    var state = window._suState;
    if (!state || state.winner !== null || state.eliminated) return;
    if (!_selected) return;
    var r = _selected.r, c = _selected.c;
    var cell = state.board[r][c];
    if (cell.given || cell.mineFill) { _selected = null; updatePad(); return; }
    _pending = { r: r, c: c, val: val };
    updatePad();
    drawFrame();
    window.makeGameMove({ type: 'fill', row: r, col: c, val: val });
  };

  window._sudokuClear = function () {
    _selected = null;
    _pending = null;
    updatePad();
    drawFrame();
  };

  window._sudokuHint = function () {
    var state = window._suState;
    if (!state || state.winner !== null || state.eliminated) return;
    if (state.hints <= 0) return;
    window.makeGameMove({ type: 'hint' });
  };

  function onResize(){if(canvas){computeLayout();drawFrame();}}
  function onScroll(){drawFrame();}
  window.gameRenderers.set('sudoku', {
    destroy:function(){
      clearInterval(_timerRaf);_timerRaf=null;if(_flashRaf)cancelAnimationFrame(_flashRaf);_flashRaf=null;_inited=false;
      window.removeEventListener('resize',onResize);window.removeEventListener('scroll',onScroll);
      canvas=null;ctx=null;window._suState=null;window._gameErrorHandler=null;
    },
    init: function (container) {
      injectStylesOnce('suStyles', STYLES);
      container.innerHTML = ''
        + '<div class="su-wrap">'
          + '<div class="su-status" id="suStatus"></div>'
          + '<div class="su-timer" id="suTimer"></div>'
          + '<div class="su-lives" id="suLives"></div>'
          + '<div class="su-board-wrap" id="suBoardWrap"></div>'
          + '<div class="su-controls">'
            + '<button class="su-hint" id="suHint" onclick="window._sudokuHint()">'
              + t('sudoku_hint', 'Hint') + ' <span class="su-hint-badge" id="suHintBadge">×3</span>'
            + '</button>'
          + '</div>'
          + '<div class="su-pad" id="suPad">'
            + '<button class="su-num" data-v="1" onclick="window._sudokuFill(1)">1</button>'
            + '<button class="su-num" data-v="2" onclick="window._sudokuFill(2)">2</button>'
            + '<button class="su-num" data-v="3" onclick="window._sudokuFill(3)">3</button>'
            + '<button class="su-num" data-v="4" onclick="window._sudokuFill(4)">4</button>'
            + '<button class="su-num" data-v="5" onclick="window._sudokuFill(5)">5</button>'
            + '<button class="su-num" data-v="6" onclick="window._sudokuFill(6)">6</button>'
            + '<button class="su-num" data-v="7" onclick="window._sudokuFill(7)">7</button>'
            + '<button class="su-num" data-v="8" onclick="window._sudokuFill(8)">8</button>'
            + '<button class="su-num" data-v="9" onclick="window._sudokuFill(9)">9</button>'
            + '<button class="su-num su-num-clear" onclick="window._sudokuClear()" style="grid-column:1/-1;">' + t('sudoku_clear', 'Clear') + '</button>'
          + '</div>'
        + '</div>';

      canvas = document.createElement('canvas');
      canvas.id = 'suCanvas';
      document.getElementById('suBoardWrap').appendChild(canvas);
      ctx = canvas.getContext('2d', { preserveDrawingBuffer: true });

      _selected = null;
      _pending = null;
      _flash = null;
      _timerEnd = 0;
      if (_timerRaf) { clearInterval(_timerRaf); _timerRaf = null; }

      computeLayout();

      if (!_inited) {
        _inited = true;
        window.addEventListener('resize',onResize);
        window.addEventListener('scroll',onScroll,{passive:true});
      }

      // Tap a blank cell to select it.
      canvas.addEventListener('click', function (e) {
        var rect = canvas.getBoundingClientRect();
        var x = e.clientX - rect.left;
        var y = e.clientY - rect.top;
        var c = Math.floor(x / _layout.cell);
        var r = Math.floor(y / _layout.cell);
        if (r < 0 || r >= N || c < 0 || c >= N) return;
        window._sudokuSelect(r, c);
      });

      // Surface a rejected fill as a red flash on the pending cell.
      window._gameErrorHandler = function () {
        if (_pending) {
          startFlash(_pending.r, _pending.c);
          _pending = null;
          updatePad();
        }
      };
    },

    render: function (state, container, playerIndex, winner) {
      window._suState = state;
      _playerIndex = playerIndex;
      if (!canvas) return;

      // A correct fill arrives as a state update: clear any pending attempt there.
      if (_pending && state.board[_pending.r][_pending.c].mineFill) {
        _pending = null;
        _selected = null;
        updatePad();
      }

      if (!ctx) ctx = canvas.getContext('2d');
      computeLayout();
      updateStatus(state, winner);
      updateLives(state);
      updateHintBtn(state);

      // Timer: start on first render, freeze on game over
      if (state && state.startTime) {
        if (winner !== null && winner !== undefined && !_timerEnd) {
          _timerEnd = Date.now();
          if (_timerRaf) { clearInterval(_timerRaf); _timerRaf = null; }
        }
        updateTimer(state);
        if ((winner === null || winner === undefined) && !_timerRaf) {
          startTimer(state);
        }
      }

      drawFrame();
    },
  });
})();
