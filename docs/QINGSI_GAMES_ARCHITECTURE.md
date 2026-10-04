# QingSi Games Architecture Baseline

This document records the current GameNest-derived architecture used as the
QingSi Games development baseline. It describes the repository as it exists; it
does not propose rule, protocol, or renderer changes.

## Runtime flow

```text
Browser
  -> HTTP / WebSocket (shared port, default 3000)
  -> Node.js server (`server.js`)
  -> in-memory Room
  -> game module (`games/`)
  -> authoritative room/game state
  -> per-player state view when provided
  -> browser renderer (`public/js/renderers/`)
```

Express serves the static browser application and the small HTTP API. The same
Node HTTP server owns a `ws` WebSocket server. WebSocket messages create and
join rooms, update the waiting room, start matches, submit moves, and distribute
state updates. A 30-second WebSocket ping/pong heartbeat removes dead transport
connections.

## Registries and module contracts

At startup, `server.js` scans every top-level `.js` file in `games/`. A module is
added to `gameRegistry` under `module.name` only when it exports both
`createState` and `handleMove`. `drawguess-words.js` is therefore treated as a
support file rather than a game. The current server registry contains 33 game
modules for 32 lobby entries: the single Mahjong catalog entry can select the
separate `mahjong-sichuan` or `mahjong-cantonese` module.

The normal game-module surface is:

- `name`, `maxPlayers`, and optionally `minPlayers`;
- `createState()` and `handleMove(data, state, playerIndex)`;
- optional `initGame(state, playerCount)`;
- optional `playerView` or `playerBoardView` for private or player-specific data;
- optional actor helpers and real-time hooks such as `getCurrentActor`,
  `setCurrentActor`, `realtime`, `tick`, `tickMs`, and `botInterval`.

`server.js` separately scans top-level `.js` files in `bots/` and indexes them by
`module.name`. There are currently 29 registered bot modules. Each exports
`name` and `createBot(playerIndex)`; the resulting bot exposes `getMove(state)`.
Shared bot helpers live under `bots/lib/`.

The browser catalog is independent of the server scan. Its 32 ordered lobby
entries and display metadata live in `public/js/game-catalog.js`, with localized
catalog data in `public/js/lang/`.

## Room lifecycle

Rooms are entries in the process-local `rooms` Map. A room contains its game
identifier, player and bot Maps, host WebSocket, options, ready-player Set,
current game state, language, phase, reconnect metadata, and timer handles.

```text
create_room
  -> lobby
  -> ready (one or more human players marked ready)
  -> playing (host starts after minimum-player and all-human-ready checks)
  -> game-specific winner / round-end state
  -> restart in playing, or return_to_room -> lobby
  -> delete after the final human seat expires
```

Before play, the host can add or remove supported bots, change game options,
swap seats, and start the match. Players can update names and avatars and toggle
ready state. Starting calls the selected module's `initGame` when present and
then broadcasts `game_started`. Legal `game_move` messages are applied through
`handleMove`; an error string is returned to the sender, while successful moves
produce a new state broadcast and any required bot/timer scheduling.

Normal close and explicit leave use different seat-retention windows:

- an unexpected WebSocket close marks the seat disconnected immediately and
  retains it for 30 seconds;
- `leave_room`, used to go back to the lobby with a resume opportunity, retains
  the seat for five minutes.

When an expired seat is removed, host ownership can transfer to another live
connection. If play is active, the server can advance past a disconnected turn.
The room is deleted and its timers are cleared when no human seats remain.

## State distribution and renderers

The server owns the shared room state. For ordinary updates,
`broadcastGameView` sends either the shared state or a view created for each
player. `playerView` is used by games with hidden information or player-specific
legal moves; Minesweeper uses `playerBoardView` for its per-player board.
The `room_joined` response uses the same player-specific view selection as
game broadcasts. UNO and six other concealed-hand games are filtered in the
server when sent to each seat.

`public/game.html` is the shared room and game shell. It loads the renderer
scripts, and each renderer registers itself in the global `window.gameRenderers`
Map. `public/js/room-client.js` selects the renderer by game identifier, calls
its optional `init(container)`, and calls `render(state, container, playerIndex,
winner)` after state messages. The single `mahjong.js` renderer registers both
Mahjong keys; the room client selects the effective key from the room mode.
Renderers send moves through the shared `window.makeGameMove` hook rather than
opening their own WebSocket connections.

## Presentation / Shared UI Layer

`public/index.html` and `public/game.html` are the two shared browser shells.
Both load the original `public/style.css` followed by `public/qingsi-ui.css`.
The latter contains QingSi branding, responsive layout, common controls,
waiting-room status, QR/invite presentation, and game-stage framing. Room
behavior remains in `public/js/room-client.js`; the lobby uses the existing
`public/js/game-catalog.js` and language packs. Category labels are mapped for
display without changing catalog IDs or the server registry. Individual
renderer files under `public/js/renderers/` and game modules under `games/`
are outside this visual layer. See `docs/QINGSI_VISUAL_SYSTEM.md` for the V1
tokens and UI states.

## Reconnect mechanism

The browser keeps `roomId`, `game`, `playerIndex`, and an opaque `resumeToken` in
`sessionStorage`. The game page reconnects 1.5 seconds after a non-terminal
WebSocket close and sends `join_room` with the saved room ID and token. When the
token matches a retained seat, the server clears its disconnect timer, replaces
the old WebSocket Map key, preserves the player index and game state, and also
transfers the host socket when applicable. The lobby checks
`/api/room-exists/:roomId` with the saved resume token before offering its
resume card.

These browser credentials do not restore a room after a server restart because
the corresponding server-side room and token records are only in memory.

## Real-time and timed games

Modules that export `realtime = true` and `tick()` use a server interval. On
each tick, eligible bots can submit a move, the game module advances state, and
the server broadcasts a fresh game view. The interval stops when the room is no
longer playing, the room is deleted, or a winner exists.

- Snake Battle is server-authoritative and advances movement/collisions every
  120 ms.
- 2048 and Sudoku use a 600 ms loop to schedule independent racing bots; their
  module `tick()` functions are intentionally no-ops because player moves carry
  the actual progress.
- Suika Battle is different: Matter.js physics runs locally in each browser at
  animation-frame speed. The server stores scores, current/next fruit types,
  elimination, and winner state, while the client reports drop, merge, and
  game-over events. Its local board snapshot is kept in `sessionStorage` for a
  same-tab lobby round trip.

Draw & Guess and the 24 Game use dedicated server timeouts. Dou Dizhu has a
turn timer. These are timed flows but do not use the generic real-time tick
contract.

## Persistence boundary

There is no database and no durable server-side room or match persistence.
Rooms, seats, resume tokens, ready state, options, game state, bot objects, and
timer state all live in the Node.js process. A server restart loses all active
rooms and matches, including scores and reconnectability.

Browser storage is limited to client conveniences: reconnect identifiers and
the Suika local board snapshot use `sessionStorage`, while language preference
uses `localStorage`. Those values do not recreate authoritative server state.
The server may append diagnostic startup messages to the ignored
`android-startup.log`; that file is not game-state persistence.
