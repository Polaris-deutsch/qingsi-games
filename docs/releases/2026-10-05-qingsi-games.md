# QingSi Games Update - 2026-10-05

## Changes

- Add browser-local solo play for 2048, Sudoku, Minesweeper and Gomoku with
  local AI. Solo play reuses the game shell and renderers without connecting
  to a multiplayer room or overwriting multiplayer session credentials.
- Keep browser-local and multiplayer rules in shared environment-neutral
  modules, with renderer and local AI lifecycle cleanup.
- Set the featured game order to Rummikub, Draw & Guess and Monopoly.
- Share the public activity feed while preserving Rummikub chat, reactions,
  hand ordering, privacy filtering and incremental rendering.
- Bound unanswered lobby and room connections with timeout, retry and return
  controls. Keep server-provided minimum player counts authoritative.
- Fix waiting-room game views, module failure reporting, Draw & Guess round
  deadlines and Battleship placement scheduling.

## Deployment Boundary

- Repository: `Polaris-deutsch/qingsi-games`, branch `master`.
- Runtime: Node.js on port 3000 behind the existing Cloudflare Tunnel.
- Public origin: `https://games.qingsiphotograph.com`.
- No main-site or QingSi Lab deployment, Tunnel/DNS changes, dependency
  updates, APK builds, installers, version tags or GitHub Releases.
- Restarting clears in-memory rooms, matches and reconnect tokens.
- Solo play needs no game server connection after loading its assets. This
  release adds no service worker or offline asset cache: an unavailable
  server cannot deliver uncached pages and files.
- Real-device Android/LAN validation and the broader security audit remain
  separate follow-up work.

## Release Verification

- Feature commit: `b8405fa`, pushed to `master` before production restart.
- `npm run check`: PASS, 196 JavaScript files checked.
- `npm test`: PASS, 459 tests, no failures or skipped tests. The existing
  port-3000 service lifecycle tests ran in a bounded maintenance window;
  production was started again immediately after the test suite.
- `git diff --check`: PASS for the staged release and committed change range.
- The managed Node service is ONLINE on port 3000 through the existing
  Cloudflare Tunnel. No Workers or Pages deployment was needed.
- Production homepage and `/api/health`: HTTP 200. Health response is JSON
  with `Cache-Control: no-store`. All curl checks use bounded timeouts.
- All 13 checked catalog, solo, shared-core, activity, watchdog, room-client
  and stylesheet assets match the local release bytes by SHA-256.
- Browser plugin not available; validation used Playwright Chromium against
  the production URL, with temporary scripts and screenshots outside Git.
- Page identity, nonblank rendering, absence of error overlays and console
  health: PASS. Lobby/room widths 375, 390, 430, 820 and desktop 1440 passed
  the applicable layout checks.
- Multiplayer create, join, ready, start, return-to-room and reconnect: PASS.
- 2048 keyboard moves, Sudoku hints, Minesweeper flags/reveal, Gomoku local
  AI replies, restart and return-to-lobby: PASS. All four solo boards passed
  desktop/mobile framing; canvas renderers also passed nonblank pixel checks.
- Solo creates no WebSocket or Beta/game API requests and leaves multiplayer
  credentials unchanged. 2048 remained interactive without network access
  after assets had loaded; cold offline loading is not supported.
- Two-player Rummikub chat in both directions, reactions, mobile composer,
  unique reconnect history and manual hand order after chat/reconnect: PASS.
- No release blockers found in these checks. Real Android devices, other
  browser engines and LAN play were not exercised by this production smoke.
