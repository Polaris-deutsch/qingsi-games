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
