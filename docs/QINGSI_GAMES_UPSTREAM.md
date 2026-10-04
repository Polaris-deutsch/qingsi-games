# QingSi Games Upstream

## Project origin

- Upstream: <https://github.com/absswds/GameNest>
- Base license: Apache-2.0
- QingSi Games is a modified derivative of GameNest.

This record is based on the repository's current `LICENSE` and `NOTICE` files. The
Apache-2.0 `LICENSE` is retained. The current `NOTICE` records the vendored
`chess.js` v0.12.1 dependency by Jeff Hlywa under BSD-2-Clause at
`games/vendor/chessjs.js`.

Future modifications must retain applicable attribution and `NOTICE` content.
This document does not add conclusions beyond the licensing and attribution
information already present in this repository.

## Recommended remote layout

Use the remotes as follows:

```text
origin   = QingSi Games
upstream = GameNest
```

Keep QingSi branding, public-internet adaptation, and Cloudflare adaptation at
clear integration boundaries and as loosely coupled from the core game rules as
practical. In particular, avoid mixing those concerns into `games/`, `bots/`, or
the room and WebSocket protocol unless a change genuinely requires it. This
keeps future upstream comparison and synchronization easier.
