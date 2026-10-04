# QingSi Games — Public Internet audit status

Updated 2026-10-01. The earlier real-device public gameplay baseline is in
PUBLIC_MULTIPLAYER_TEST.md. The operator confirmed the hardened build is not
yet deployed, so it still needs a new public-device run. Policies and limits are documented in
PUBLIC_INTERNET_HARDENING.md.

## V1 completed

- [x] WebSocket Origin restriction with public, LAN and missing-Origin policy.
- [x] WebSocket inbound payload limit.
- [x] Per-socket inbound and join rate limits.
- [x] Room creation cooldown and one-room-per-socket guard.
- [x] Connection and room limits with configurable defaults.
- [x] Transport input validation, string limits and dangerous-key rejection.
- [x] Known room-shell, Snake, UNO and Draw & Guess HTML sinks escaped; Unicode
  names remain supported.
- [x] Low-risk security headers and same-origin CORS posture.
- [x] Final-seat and server-close resource cleanup, including realtime and
  bot timers.
- [x] Public debug disabled, health kept minimal, room-existence check tied
  to resume token, and LAN discovery disabled in public URL mode.
- [x] UNO hand/deck/challenge state and six other known card/tile games'
  concealed hands and piles hidden per player; Old Maid draw logs and Liar's
  Bar claim IDs filtered after moves and on reconnect.
- [x] Local Playwright Old Maid flow with AI and desktop/mobile rendering.

## Follow-up

- [ ] Retest the hardened build through the public Tunnel on 5G and Wi-Fi,
  including QR, room, Snake, UNO, reconnect, and Android/LAN paths.
- [ ] Review remaining games' private-state views and renderer HTML sinks.
  V1 targeted known leaks and was not a full 32-game audit.
- [ ] Review room lifecycle authorization and reconnect-token lifetime
  without changing game rules unexpectedly.
- [ ] Plan strict CSP after inline scripts/styles and external Matter.js
  loading are addressed.
- [ ] Evaluate dependency advisories and unpkg integrity/offline behavior.
- [ ] Decide whether larger use needs distributed abuse limits, load
  testing, or persistence.
