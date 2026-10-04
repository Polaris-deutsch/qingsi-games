# Architecture

GameNest uses one Node.js process for HTTP, WebSocket, room management, game rules, and bot scheduling. Browser clients render each game with plain JavaScript modules.

## Runtime Flow

```text
Browser lobby
  -> create or join room over WebSocket
  -> server keeps room state in memory
  -> game module validates and applies moves
  -> server broadcasts filtered state
  -> browser renderer updates the board
```

HTTP and WebSocket share port `3000`.

## Main Pieces

| Path | Responsibility |
| --- | --- |
| `server.js` | Express routes, WebSocket messages, room lifecycle, player seats, bot scheduling, per-player state broadcasts |
| `games/` | Pure game rules and state transitions |
| `bots/` | AI move generation for supported games |
| `public/index.html` | Lobby and game selection |
| `public/game.html` | Room shell and renderer host |
| `public/js/room-client.js` | WebSocket client, waiting room, game options, renderer scheduling |
| `public/js/renderers/` | Game-specific DOM or Canvas rendering |
| `public/js/game-catalog.js` | Built-in game metadata (single source of truth for lobby) |
| `public/js/lang/` | Browser language packs |
| `lang/` | Server-side text packs |
| `tests/` | Regression tests for rules, bots, catalog, and client assumptions |
| `android/` | Android WebView wrapper using nodejs-mobile |

## Room Lifecycle

Rooms move through three phases:

```text
lobby -> ready -> playing
```

Players can join, reconnect, change names and avatars, swap seats, mark ready, and start games. The host can add bots and update game-specific options before play begins.

## State Sync

Clients send `game_move` messages with game-specific payloads. The server passes those payloads to the current game's `handleMove(data, state, playerIndex)`.

After a legal move, the server broadcasts `game_state`. Some games expose a per-player state view to hide private information or include legal moves only for the active player.

Examples:

- Minesweeper Race uses per-player board views.
- Texas Hold'em hides opponents' hole cards.
- Chinese Chess sends legal move hints to the current player.
- Draw & Guess hides the drawing stroke endpoint from guessing players.

Games export `playerView(state, playerIndex)` or `playerBoardView(state, playerIndex)`; the server's `broadcastGameView` helper dispatches the right view to each client. Adding a new per-player-view game only requires exporting the hook — no server.js edits needed.

## Per-Player Views

Some games hide private information or show legal-move hints only to the active player. These games export `playerView(state, playerIndex)` or `playerBoardView(state, playerIndex)` from their module in `games/`. The server calls these functions before broadcasting `game_state`, `game_started`, and `game_restart`, so each client receives a filtered view of the shared state.

Current games using per-player views:

- **Minesweeper Race** — `playerBoardView` shares the mine layout but gives each player independent reveal and flag state.
- **Texas Hold'em** — `playerView` hides opponents' hole cards.
- **Chinese Chess** — `playerView` attaches a `legalMoves` array for the current player.
- **Draw & Guess** — `playerView` hides the drawing stroke endpoint from guessing players.

## Android Wrapper

The Android project copies the Node.js project into app assets and starts it through nodejs-mobile. The Android UI is a WebView pointed at the local server.

Before Android builds, run:

```powershell
cd android
.\copy-nodejs-project.ps1
```

## Shared Activity Feed

`games/lib/activity.js` is the server core. `public/js/ui/activity-feed.js` is the browser UI, exported as `window.ActivityFeed`. Both use the constants in the Node/browser module `public/js/activity-protocol.js`; defaults are 500 retained events, 120 Unicode code points per message, an 800ms shared chat/reaction cooldown and the same twelve reactions.

This is a **public information only** feed. Never put hidden hands, private identities, night channels, manipulation workspaces or private notifications in it. The core cannot determine whether an arbitrary game value is secret: adapters must construct public data or supply `projectData(type, data)`. The same projector can sanitize outgoing views as a second boundary. Private-channel support is a separate future design. Existing games' messages and private channels remain independent.

The public schema is:

```js
state.activity = {
  version: 1,
  seq: 2,
  items: [
    { seq: 1, type: 'demo.move', player: 0, time: 123456789, data: { value: 5 } },
    { seq: 2, type: 'chat', player: 1, time: 123457000, data: { text: 'Hello' } }
  ]
};
```

Only seat indexes are stored, never player names. Rate-limit timestamps and server options live in a `WeakMap` keyed by the game state; they are absent from JSON and player views. Game adapters may keep a separate public match ID and pass it as the UI's `resetKey` to distinguish matches that have equal sequence numbers.

Server API:

- `Activity.init(state, options)` creates a missing structure and preserves existing history and cooldowns. It returns `state.activity`.
- `Activity.reset(state, options)` explicitly clears history, sequence and cooldowns while retaining configured defaults.
- `Activity.push(state, {type, player, data}, options)` copies public data, supplies the server timestamp and next sequence, trims the oldest items and returns the item (or `null` for a rejected envelope/projector result). Use namespaced game events such as `demo.move`; `chat` and `reaction` are shared types.
- `Activity.isSocialAction(data)` recognizes `activity_chat` and `activity_reaction`. The previous `chat` and `reaction` names are the only upgrade aliases.
- `Activity.handleSocialAction(data, state, authenticatedSeat, options)` returns `{handled:false}` for game moves or `{handled:true,error:null|key}` for social actions. Options may include `playerCount` and `enabled`; the core does not inspect turn, phase, hands or other game fields. Always return a handled result before normal turn/winner validation.
- `Activity.publicView(state, options)` copies only the public schema and event envelopes, applying the configured data projector again.
- `Activity.DEFAULT_REACTIONS` / `Activity.getDefaultReactions()` expose the shared immutable defaults.

Configuration supports `maxItems`, `chatMaxLength`, `chatGapMs`, `reactions` and `projectData`. Chat is trimmed, whitespace is collapsed, empty/overlong content is rejected, and both social types share a per-seat cooldown. Identity comes exclusively from the authenticated server argument. Standard errors use `activity_*` keys in both server language packs.

For example, an adapter can record an already-public move without passing its whole state:

```js
const Activity = require('./lib/activity');
Activity.init(state, {projectData: (type, data) => ({value: data.value})});
Activity.push(state, {type:'demo.move', player:seatIndex, data:{value:5}});
```

When overriding reactions, length or cooldown defaults, configure the browser adapter consistently. These settings are supplied by application code, not by client message payloads.

A game opts into room-level social handling with `exports.supportsActivity = true`. Only opted-in modules bypass disconnected-turn advancement and bot rescheduling after social moves. The room still authenticates the socket and broadcasts through existing `game_move` / `game_state` messages. The game's public player view must preserve `Activity.publicView(...)`, with its normal hidden-state filtering. Rummikub is currently the only opted-in production consumer, with `getActivityView()` applied by its existing filtered view.

Browser setup (the protocol and UI scripts load before renderers):

```js
const feed = ActivityFeed.create({
  mount,
  playerIndex: mySeat,
  getPlayerName: index => currentPlayers[index].name,
  formatEvent: (item, context) => ({
    text: `${context.getPlayerName(item.player)} moved ${item.data.value}`,
    kind: 'system'
  }),
  sendChat: text => makeGameMove({action:'activity_chat', text}),
  sendReaction: emoji => makeGameMove({action:'activity_reaction', emoji}),
  strings: {
    title: t('activity_title'), empty: t('activity_empty'), send: t('activity_send'),
    placeholder: t('activity_placeholder'), inputLabel: t('activity_input_label'),
    reactions: t('activity_reactions'), collapse: t('activity_collapse'),
    expand: t('activity_expand'), ended: t('activity_ended'),
    chatEmpty: t('activity_chat_empty'), chatTooLong: t('activity_chat_too_long'),
    newItems: count => tf('activity_new_items', count),
    sendReaction: emoji => tf('activity_send_reaction', emoji)
  }
});
feed.update(state.activity, {playerIndex:mySeat, resetKey:state.matchId, namesVersion});
```

The instance API is `update`, `setDisabled`, `setCollapsed`, `setDocked`, `scrollToBottom`, `showError`, `resetSync` and `destroy`. Options also support reaction/length/cooldown overrides, `nearBottomPx`, initial `disabled`, `collapsed` and `docked`. `setDocked` only changes panel presentation; the game decides the page placement and responsive breakpoint. Shared `.ga-*` panel CSS lives in `public/style.css`; board layout and tile badge colors remain game-specific.

Formatters return a safe descriptor `{text, kind:'system', muted?, parts?:[{text,className?}]}`. All strings, including names and badge text, become `textContent`; raw HTML strings are unsupported. CSS classes in descriptors are adapter-authored presentation. The UI renders chat/reactions itself and knows no game concepts or WebSocket implementation.

Each instance owns its DOM references and unique ARIA IDs. `update()` preserves the composer, draft, focus and selection. Normal updates use binary search for new items and remove only an expired prefix; existing rows are kept. A changed `namesVersion` refreshes historical names, preserving row roots. Sequence rollback or a changed `resetKey` clears the old timeline. A disjoint retained history is rebuilt statically without losing a current draft. Initial histories and `resetSync()` reconnect baselines do not animate or announce old reactions. No feed code plays game audio.

At the bottom (within 50px), updates follow new events. Browsing history preserves scroll position and accumulates unread events; clicking the latest button clears unread. Compact panels can collapse and position the composer within a reduced keyboard viewport. Live notices use a separate polite status region; historical logs are not repeatedly announced. Reaction animation honors reduced motion.

Call `resetSync()` on reconnect, `showError(serverMessage)` for handled social errors and `destroy()` before discarding a renderer. Destruction removes the panel, local/global listeners, observers, cooldown timers and animation frames. Loading the module alone creates no DOM or listeners. Games that never call `create()` are unaffected.

Independent core and fake-adapter/multiple-instance UI tests live in `tests/activity.test.js` and `tests/activity-feed.test.js`. Rummikub integration, real WebSocket privacy and the earlier hand/feedback regressions remain separate consumers' tests. Further games should opt in one at a time; this change does not migrate their messages or private channels.

## Browser-local solo and room entry

The lobby's featured order is fixed in the catalog: `rummikub`, `drawguess`, `monopoly`. Localized catalogs provide labels and do not override capability metadata. `solo` is `local` for 2048, Sudoku and Minesweeper, `local-ai` for Gomoku, and `false` for other games. Local support is independent of each server module's authoritative `minPlayers`; room responses supply that value to the waiting-room controls.

`game.html?mode=solo&game=2048` uses the same shell and renderer as multiplayer. `public/js/local/solo-page.js` selects the local mode; `room-client.js` returns before reading room credentials, setting up room UI or constructing a socket. The local page hides room codes, QR/invite controls, readiness, bot management and room waiting. It does not read or overwrite multiplayer session credentials.

The local modules are:

- `solo-runtime.js`: adapter registration; local create/move/render/restart; AI scheduling; pause/resume; destruction.
- `solo-adapters.js`: one-player or human/AI adapters for the four catalog capabilities.
- `solo-page.js`: localized page shell, injected move dispatch, result/restart controls, visibility handling and 2048 best score under `solo:2048:best`.

Pure rules live in `public/js/core/{2048,sudoku,minesweeper,gomoku}.js`. Node game modules are thin adapters to the same factories, so local and multiplayer rules share an implementation. The 2048 helpers and Sudoku generator are shared through the same core directory; `gomoku-ai.js` contains the original pure bot decision algorithm, while `bots/gomoku.js` retains server bot identity. Browser code requires no Node APIs or build tool. The existing four renderer files are reused, with optional lifecycle cleanup methods.

To add another local game, extract only the required environment-neutral rules, register an adapter (`create`, `move`, `view`, optional `ai`/`isDraw`) and set its catalog capability. `SoloRuntime.create()` accepts a renderer, mount and status/error/state callbacks; the runtime exposes `makeMove`, `restart`, `pause`, `resume`, `destroy` and `getState`. Transport belongs to the online page only. The solo page restores its temporary dispatch globals on destruction and cancels stale AI work on pause, restart and exit.

The `public/` tree can be served at a static site's root. Once assets are loaded, local play needs no WebSocket, API or game-state broadcasts. A stopped Node server cannot deliver uncached HTML/assets under the current deployment: opening the page then requires separate static hosting or a future PWA/service-worker cache. This stage does not add caching or change Cloudflare deployment. Multiplayer remains available through the original create-room entry.

Room state factories are not initialized playing boards. Waiting/resume/join responses therefore expose `state:null` until `start_game` has called `initGame`; raw factory state must not replace a private player view. Module load and factory failures are diagnosed with the module/file and stack; playing-view failures log game/seat/phase and return a specific error. The connection watchdog bounds unanswered lobby/room operations at eight seconds, cannot be extended by socket retries, and exposes retry/return controls. It reports game/room/connection phase, never resume credentials.

Drawguess's timer is server-authoritative. Successful live stage moves preserve the active drawing deadline; a move that changes phase rearms the timer. Entering `round_result` starts a fresh five-second deadline, including unlimited drawing mode. Input phases retain their existing two-second network grace. No renderer advances the round.

Regression coverage includes all registered games' creation, resume, waiting views, start and serialization; catalog/module/renderer consistency; Drawguess rotation and real timer/reconnect transitions; watchdog deadlines; and browser-local runtime rules, AI lifecycle, renderer reuse and transport/session isolation.
