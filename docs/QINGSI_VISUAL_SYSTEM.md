# QingSi Games visual system V1

QingSi Games is the public product name. `QINGSi LAB / GAMES` is a small supporting label. The interface is quiet, technical, and editorial: near-black ground, a faint 36 px grid, one restrained cyan light source, and precise alignment. No gaming RGB, purple glow, or heavy glass effects.

## Shared surfaces

- `public/index.html`: home, featured games, searchable catalog, join/create, About and credits.
- `public/game.html`: room/game header, room code, invite, QR, players, ready/start, shared options container, game stage, result and return controls.
- `public/qingsi-ui.css`: V1 presentation rules for those two pages. It is loaded after upstream `style.css` so visual overrides stay together.
- `public/js/room-client.js`: existing room behavior plus presentation state for connection, copy actions, and explicit seat labels.
- `public/js/game-catalog.js`: source of game names, player counts, Bot support, and existing categories. The five English category labels used by the UI are presentation-only mappings in `index.html`; game IDs and server registration do not change.

The game renderer output stays inside `#boardArea`. Its light and dark game pieces keep their existing styling. The shared stage gives the renderer full width and adds only a border, spacing, and controls around it.

## Tokens and components

| Role | Value |
| --- | --- |
| Background | `#080d0e` |
| Shared surface | `#0c1415` / `#101a1c` |
| Main text | `#edf3f2` |
| Secondary text | `#9dafaf` |
| Hairline borders | `#294043` / `#1b2d30` |
| Accent | `#89d5d5`; stronger light cyan only for a primary action |
| Headings | System serif fallback stack: Georgia, Songti SC, Noto Serif CJK SC |
| Interface | System sans-serif fallback stack |

Spacing is based on 4, 8, 12, 16, 24 and 32 px steps. Shared cards and controls use 2–4 px corners, thin borders, little shadow, and visible keyboard focus. Card hover moves by at most 2 px. Status is written in text as well as marked by color or symbol.

The lobby displays three catalog-backed featured games followed by all 32 games. Cards show name, category, player count, and Bot or real-time support where applicable. Existing covers remain optional, dimmed thumbnails; no new cover set or font download is introduced.

The waiting room puts the code, copyable invite, and high-contrast QR in one shared area. A plain room code remains usable without scanning. Seats explicitly say Host, You, Bot, Ready, Not Ready, or Disconnected. Only the host receives a Start button. Existing option controls keep their meaning while the shared options shell sets border, spacing, focus, and touch sizing.

On screens up to 820 px, the room identity and QR move above the seat list. The 375, 390, and 430 px layouts keep controls at least 44 px high and avoid horizontal scrolling. The game stage keeps its header compact and gives the renderer the main area.

The About footer keeps a low-weight “Based on GameNest · Apache-2.0” link to <https://github.com/absswds/GameNest>. `LICENSE` and `NOTICE` remain in the repository. The QingSi Lab return link points to <https://lab.qingsiphotograph.com/>.
