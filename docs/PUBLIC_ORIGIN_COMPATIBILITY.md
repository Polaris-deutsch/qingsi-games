# Public origin compatibility

QingSi Games accepts an optional `PUBLIC_BASE_URL` for canonical room invite
links. The public origin has now been checked through this topology:

```text
Browser -> https://games.qingsiphotograph.com
        -> Cloudflare Tunnel -> http://localhost:3000
        -> QingSi Games Node server
```

The Cloudflare Tunnel was configured outside this repository. This document
records the public-origin baseline; later security controls are described in
PUBLIC_INTERNET_HARDENING.md.

## LAN and local mode

Leave `PUBLIC_BASE_URL` unset or empty and run `npm start`. The existing `/qr`
behavior remains: it uses the request `Host` and recognizes
`X-Forwarded-Proto: https`; for `localhost` or `127.0.0.1` it prefers a
shareable LAN IP so a phone can scan the QR. `/network-info` continues to
return local and LAN addresses, and startup still prints LAN addresses. The
Android LAN host path does not require a public origin.

The room join contract is `/?room=<roomId>`. The lobby reads that query and
joins the room; the waiting room loads `/qr?room=<roomId>`. There is currently
no separate share-link button. The server's `buildRoomShareUrl` helper builds
the URL encoded by `/qr` and can be reused for a future share control.

## Public URL mode

Set `PUBLIC_BASE_URL=https://games.qingsiphotograph.com` in the server's
environment. The value must be an absolute HTTP or HTTPS origin. A trailing
slash is removed; a path, query, fragment, credentials, or invalid URL causes
a clear startup error. Do not add a trailing `/?room=...` to this setting.

With that setting, `/qr?room=AB3` encodes
`https://games.qingsiphotograph.com/?room=AB3` regardless of the incoming
`Host` or forwarded headers. `PUBLIC_BASE_URL` sets canonical public/share
URLs and is also the public WebSocket Origin allowlist value in the later
hardening change. It is not an authentication mechanism.

Both browser clients continue to connect WebSocket to the page's current
origin: an HTTP LAN page uses `ws://<LAN-host>:<port>`, and an HTTPS public
page uses `wss://games.qingsiphotograph.com`. No server proxy-trust setting is
enabled. The existing `X-Forwarded-Proto` behavior is retained only for the
legacy LAN QR fallback. In public URL mode, the configured origin takes
precedence over `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`.

`GET /api/health` returns only `ok`, `service`, and the version from
`package.json`, as JSON with `Cache-Control: no-store`. It contains no room,
player, connection, or environment data.

Public Internet Hardening V1 adds WebSocket Origin, payload, rate, room and
connection controls. `/network-info` is available only when
`PUBLIC_BASE_URL` is unset, so public mode does not return LAN addresses.

## Public validation

On 2026-09-30, the public HTTPS homepage and `/api/health` returned HTTP 200,
a WSS handshake succeeded, and the live lobby resolved its WebSocket address
to `wss://games.qingsiphotograph.com`. A live public QR PNG matched the
`https://games.qingsiphotograph.com/?room=AB3` invite URL. The tester also
reported PASS for 5G access, room create/join, QR, Gomoku, UNO, Snake Battle
(with delay), and reconnect. See `PUBLIC_MULTIPLAYER_TEST.md` for provenance,
limits, and the public multiplayer baseline conclusion.
