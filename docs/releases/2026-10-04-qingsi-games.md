# QingSi Games Update - 2026-10-04

## Changes

- Introduce QingSi Games branding, a searchable 32-game catalog, and refreshed
  lobby and room layouts for desktop and mobile.
- Improve room codes, invite-link copying, QR presentation, player seats,
  connection feedback, and same-process reconnection.
- Add Rummikub manual and automatic hand ordering, table organization,
  turn and tile feedback, a bounded activity timeline, chat, and reactions.
- Harden public WebSocket origins, message validation, resource limits,
  private card views, renderer escaping, and room/timer cleanup.
- Add verified-PID service controls and Windows shortcuts without changing
  Cloudflare Tunnel, DNS, or automatic startup settings.

## Deployment Boundary

- Repository: `Polaris-deutsch/qingsi-games`, branch `master`.
- Runtime: Node.js on port 3000 behind the existing Cloudflare Tunnel.
- Public origin: `https://games.qingsiphotograph.com`.
- No QingSi Photograph or QingSi Lab deployment is part of this release.
- No APK, desktop installer, version tag, or GitHub Release is generated.
- Room and match state is in memory. Restarting loses existing rooms and
  their reconnect tokens; browser storage does not restore them.
- LAN/Android real-device testing and the broader security audit remain
  separate from this production release.

## Verification

- JavaScript syntax: 174 files passed; full Node test suite: 367 passed.
- Public homepage and `/api/health`: HTTP 200; health JSON identifies
  `qingsi-games` and uses `Cache-Control: no-store`.
- Core JavaScript and CSS responses match the release files. Cloudflare
  inserts a hidden link in public HTML, so raw HTML hashes differ.
- Chromium verified public WSS room creation, joining, readiness, game start,
  return to room, and same-process reconnection.
- Rummikub manual ordering and two-player chat passed; incoming chat preserves
  the custom hand order. Desktop and mobile screenshots were inspected.
- Lobby widths 375, 390, 430, 820, and 1440 passed overflow and control checks.
- The UI smoke script now waits for the public room connection before checking
  its label, avoiding an assertion race with asynchronous WSS establishment.
