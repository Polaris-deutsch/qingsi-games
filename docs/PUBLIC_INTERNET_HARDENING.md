# QingSi Games — Public Internet Hardening V1

Implemented locally on 2026-09-30 and extended with targeted private-state
regression checks on 2026-10-01. No deployment, Tunnel, DNS, or Cloudflare
configuration changed. The operator confirmed on 2026-10-01 that the
hardened build has not been deployed. The earlier real-device baseline is in
PUBLIC_MULTIPLAYER_TEST.md; the hardened code still needs public-device testing.

## WebSocket Origin policy

With PUBLIC_BASE_URL=https://games.qingsiphotograph.com, public browser
handshakes require exactly that Origin and a matching Host. LAN HTTP origins
are accepted when Origin and Host match, both are private/loopback, and the
socket peer is private. This includes localhost, 127.0.0.1, 192.168.x.x,
other RFC1918 IPv4 and private IPv6 addresses. A missing Origin is accepted
only with private Host and peer for non-browser LAN clients; a public Host
without Origin is rejected. Android WebView uses a browser Origin. Origin is a
browser boundary, and a custom client can forge it. Rejections use HTTP 403.

## Payload and abuse limits

| Control | Default | Rejection |
| --- | --- | --- |
| Inbound WS payload | 4,194,304 bytes (4 MiB), configurable 64 KiB–16 MiB | Close 1009 |
| Inbound messages per socket | Token bucket, 120 burst, 40/second refill | Close 1008 |
| Join attempts per socket | Token bucket, 6 burst, 0.5/second refill | JOIN_RATE_LIMIT |
| Create room per socket | 3-second cooldown, one active room | CREATE_COOLDOWN or ALREADY_IN_ROOM |
| MAX_ROOMS | 200, configurable 1–5,000 | ROOM_LIMIT |
| MAX_CONNECTIONS | 500, configurable 1–10,000 | HTTP 503 |

The payload limit is inbound only; game-state broadcasts are outbound.
Representative current client message shapes measured as serialized UTF-8:
Snake direction 46 bytes, Mahjong discard 68 bytes, Monopoly action 64 bytes,
Draw & Guess stroke with 1,000 points 17,658 bytes, and the maximum
8,192-character custom-word option 8,253 bytes. These are constructed samples,
not live peak measurements. The 4 MiB cap leaves margin for larger drawings
while rejecting tens or hundreds of MiB frames. Tests also exercise a 64 KiB
configured cap. Server-to-client tick broadcasts have no inbound rate limit.
Snake input and its 120 ms tick pass the local regression test.

Room IDs now use cryptographic random selection with collision retries. These
limits are per process and per connection, not distributed IP quotas.

## Input, private state, and XSS

The server checks the message envelope, room code, game name, seat indices,
option keys/values, names, avatars and move text before game dispatch. JSON
has limits of 20 levels, 100,000 nodes, 256 keys per object, 30,000 array
items, 64-character keys and 8,192 UTF-16 code units per string. Dangerous
keys (__proto__, constructor, prototype) are rejected at every level; room
options use a null-prototype object and an allowlist. Names allow Chinese and
emoji but have an 8-code-unit maximum and reject angle brackets and control
characters. Avatars have a 4-code-unit maximum. Move text, content and
expression strings are capped at 256; custom option text at 8,192.
Game modules retain their move-rule validation.

Room-shell player names/avatars use textContent or HTML escaping. Known Snake,
UNO and Draw & Guess dynamic HTML sinks were escaped. UNO now sends each player
their own hand, opponent hand counts, and deck count; it never sends opponent
cards, deck cards, or the private +4 challenge snapshot. The resolved challenge
result needed by the UI is sent after the challenge. Targeted server-side
views also mask opponent hands in Dou Dizhu, Big Two, Old Maid, Exploding
Kittens, Rummikub and Liar's Bar. Their concealed draw piles and related
fields are filtered: Dou Dizhu's pre-bid bottom cards and duplicate board;
Old Maid's last drawn card for other seats; Exploding Kittens' deck and
private future peek; Rummikub's pool and manipulation snapshot; and Liar's
Bar's bullet chambers, face-down pile and card IDs inside claims. Old Maid's
draw-log card identity is also visible only to the drawing seat. Join and
reconnect use the same
player-specific views. A full review of all 32 games' hidden state and
renderer sinks remains follow-up work.

## HTTP, diagnostics, and cleanup

Debug routes require GAMENEST_DEBUG=1, PUBLIC_BASE_URL unset, and
NODE_ENV other than production. Their POST body limit is 32 KiB. Public
/api/health returns only ok, service and version with Cache-Control: no-store.
/api/room-exists requires a matching resume token and is not cached.
/network-info returns LAN addresses only when PUBLIC_BASE_URL is unset.
Errors do not return stacks, filesystem paths or environment values.

Responses add X-Content-Type-Options: nosniff, Referrer-Policy:
strict-origin-when-cross-origin and Permissions-Policy with camera,
microphone and geolocation disabled. X-Powered-By is disabled. No wildcard
CORS header was added; browser calls remain same-origin. Strict CSP is
deferred because current pages/renderers use inline scripts and styles,
generated styles, and an external Matter.js asset from unpkg. Applying CSP
without those changes would break current flows.

Malformed JSON is ignored; invalid structured messages receive a generic
error; binary, flood and handler exceptions close the socket without a stack.
Normal moves and repeated rejected messages do not produce per-message logs.
Room destruction clears disconnect, bot, Draw & Guess, Dou Dizhu, 24 Game and
realtime timers. Pending 24 Game bot timers are tracked and canceled. Cleanup
runs after the last seat expires and on server close. Rooms and reconnect
tokens remain process-local and disappear on restart.

## Verification and remaining work

internet-security.test.js covers public/LAN/missing Origin, payload, Snake
and flood, create/join and resource limits, malformed JSON, Unicode and HTML
names, prototype keys, UNO and six other concealed-hand views, move-time
Old Maid/Liar's Bar privacy and reconnect,
diagnostics, headers, and empty realtime-room cleanup. public-origin.test.js covers public QR/WSS
URL selection and LAN QR fallback. Project gates are npm run check and npm
test.

On 2026-10-01, a temporary local server and Playwright CLI exercised the
Old Maid lobby-to-game flow with an AI opponent. The page rendered opponent
card backs, own cards and a completed draw on desktop and 390×844 mobile
viewports, with no relevant console errors after the local server was
restarted for the final run. Screenshots were kept outside the repository.

Retest the hardened build on the public Tunnel and Android/LAN devices.
Review remaining games' private state and DOM sinks, room lifecycle
authorization, reconnect-token lifetime, dependencies, unpkg integrity,
and CSP separately. Larger use may call for distributed abuse controls or
persistence. No account, CAPTCHA or external datastore was introduced.
