# QingSi Games — Public Multiplayer Baseline

## Environment and provenance

| Field | Recorded value |
| --- | --- |
| Real-device test date | 2026-09-30 (tester said “now”; Europe/Berlin date) |
| Independent endpoint check | 2026-09-30 (UTC) |
| Public URL | `https://games.qingsiphotograph.com` |
| Origin | `http://localhost:3000` |
| `PUBLIC_BASE_URL` | `https://games.qingsiphotograph.com` (tester-reported server setting) |
| Desktop network | Wi-Fi (tester-reported) |
| Mobile network | 5G (tester-reported) |

Tester-reported topology:

```text
Internet -> Cloudflare -> Cloudflare Tunnel -> Windows cloudflared
         -> localhost:3000 -> WSL QingSi Games
```

The real-device results below come from the tester's replies in this task.
The first message contained example PASS values in a placeholder block; those
examples were not counted as results. The tester later supplied results and
clarified that reconnect's final result is PASS.

## Real-device results

| Check | Result | Evidence or limitation |
| --- | --- | --- |
| Public homepage on mobile 5G | PASS | Tester report |
| Room create/join | PASS | Tester report |
| QR invite | PASS | Tester report |
| Gomoku turn-based play | PASS | Tester report |
| UNO private-state play | PASS | Tester reported “UNO PASS”; test steps were not provided |
| Snake Battle real-time play | PASS, with unmeasured delay | Tester reported smooth play and no impact on operation |
| Disconnect/reconnect | PASS | Tester clarified final result after an initial “PASS / FAIL” reply; scenarios were not provided |

No confirmed FAIL remains in the supplied results. Snake Battle's reported
delay is a **Realtime** observation for follow-up; its duration was not
measured, and the tester said it did not affect operation.

## Independent public-origin checks

These checks were run against the live public URL with network timeouts on
2026-09-30. They confirm endpoint and URL behavior, not the tester's mobile
gameplay results.

| Check | Result |
| --- | --- |
| HTTPS `/` | HTTP 200, HTML |
| HTTPS `/api/health` | HTTP 200, JSON `{"ok":true,"service":"qingsi-games","version":"1.5.0"}`, `Cache-Control: no-store` |
| WSS handshake | Succeeded at `wss://games.qingsiphotograph.com` |
| Browser lobby WebSocket URL | `wss://games.qingsiphotograph.com` from the live HTTPS page's `getSocketURL()` |
| Mixed content on loaded lobby | No HTTP resources or mixed-content console errors observed; this is limited to the loaded lobby |
| Public `/qr?room=AB3` | HTTP 200 PNG; pixels exactly matched a QR generated for `https://games.qingsiphotograph.com/?room=AB3` and did not match localhost/LAN candidates |

The current share URL contract is `/?room=<roomId>`. There is no separate
share-link button; `/qr` is the active invite surface. The checked public QR
contains no localhost, LAN, or WSL address. The browser's runtime WebSocket
address comes from the HTTPS page origin and contains no `ws://`, localhost,
LAN IP, or `:3000`.

## LAN compatibility and conclusion

`PUBLIC_BASE_URL` remains optional. The existing local/LAN QR fallback and
`/network-info` remain in the current code, and the prior automated URL tests
cover localhost and LAN addresses when the setting is unset. This task did not
repeat a physical Android-host test; no Android-host code was changed.

**Public multiplayer baseline validated.** The required public access, room,
Gomoku, UNO, Snake Battle, and reconnect checks were all reported PASS. The
reported Snake Battle delay can be measured in a later real-time performance
investigation. Next phase: **Public Internet Hardening**. This baseline does
not assert that the public service has passed a security review.
