# QingSi Games 游戏目录基线

本表以 `public/js/game-catalog.js` 的默认中文目录与顺序为准，逐项对照
`games/<id>.js` 的 `maxPlayers`、`realtime` 和 `bots/<id>.js`。统计口径是
**大厅可选入口**，不是顶层 `.js` 文件数。`支持 AI` 取目录中的 `supportsAI`，
并已核对为“是”的入口均存在对应 Bot 模块。

| Game ID | 显示名称 | 大厅 max players | 服务端 max players | 支持 AI | 实时机制 |
| --- | --- | ---: | ---: | --- | --- |
| `monopoly` | 大富翁 | 6 | 6 | 是 | 无通用 tick |
| `flightchess` | 飞行棋 | 4 | 4 | 是 | 无通用 tick |
| `sheeptile` | 羊了个羊 | 6 | 6 | 是 | 无通用 tick |
| `suikabattle` | 合成大西瓜 | 4 | 4 | 否 | 客户端 Matter.js 物理循环 |
| `drawguess` | 你画我猜 | 8 | 8 | 否 | 服务端步骤计时，非通用 tick |
| `texas` | 德州扑克 | 8 | 8 | 是 | 无通用 tick |
| `uno` | UNO | 6 | 6 | 是 | 无通用 tick |
| `doudizhu` | 斗地主 | 3 | 3 | 是 | 服务端回合计时，非通用 tick |
| `davinci` | 达芬奇密码 | 4 | 4 | 是 | 无通用 tick |
| `rummikub` | 魔力桥 | 4 | 4 | 是 | 无通用 tick |
| `liarsbar` | 骗子酒馆 | 6 | 6 | 是 | 无通用 tick |
| `bigtwo` | 大老二 | 4 | 4 | 是 | 无通用 tick |
| `mahjong-sichuan` | 麻将 | 4 | 4 | 是 | 无通用 tick |
| `hearts` | 红心大战 | 4 | 4 | 是 | 无通用 tick |
| `tictactoe` | 井字棋 | 2 | 2 | 是 | 无通用 tick |
| `gomoku` | 五子棋 | 2 | 2 | 是 | 无通用 tick |
| `chinesechess` | 中国象棋 | 2 | 2 | 是 | 无通用 tick |
| `chess` | 国际象棋 | 2 | 2 | 是 | 无通用 tick |
| `checkers` | 西洋跳棋 | 2 | 2 | 是 | 无通用 tick |
| `connect4` | 四子棋 | 2 | 2 | 是 | 无通用 tick |
| `reversi` | 黑白棋 | 2 | 2 | 是 | 无通用 tick |
| `go9` | 围棋 9路 | 2 | 2 | 是 | 无通用 tick |
| `twentyfour` | 24点 | 6 | 99 | 是 | 服务端轮次计时，非通用 tick |
| `sudoku` | 数独 | 4 | 4 | 是 | 服务端 600 ms 通用 tick |
| `2048` | 2048 | 4 | 4 | 是 | 服务端 600 ms 通用 tick |
| `minesweeper` | 扫雷竞速 | 6 | 6 | 否 | 无通用 tick |
| `numberbomb` | 数字炸弹 | 10 | 10 | 是 | 无通用 tick |
| `oldmaid` | 抽鬼牌 | 6 | 6 | 是 | 无通用 tick |
| `exploding-kittens` | 爆炸猫 | 6 | 6 | 是 | 无通用 tick |
| `truthdare` | 真心话大冒险 | 10 | 10 | 否 | 无通用 tick |
| `snakebattle` | 贪吃蛇大乱斗 | 6 | 6 | 是 | 服务端 120 ms 通用 tick |
| `battleship` | 战舰 | 2 | 2 | 是 | 无通用 tick |

实际数量：**32 个大厅游戏入口，33 个可注册服务端游戏模块，29 个 Bot
模块，32 个渲染器文件，32 张游戏封面**。大厅只有一个麻将入口；四川和广东
麻将各有独立的服务端游戏模块与 Bot 模块，共用 `public/js/renderers/mahjong.js`。
`games/drawguess-words.js` 是词库支持文件，不是游戏模块。

`twentyfour` 的大厅 `maxPlayers` 为 6，而 `games/twentyfour.js` 的
`maxPlayers` 为 99；本表仅记录现状，不改变规则或人数限制。表中“实时机制”
区分服务器 `realtime`/`tick` 契约、独立计时器和浏览器本地物理循环；“无通用
tick”不表示游戏没有动画或交互。
