# QingSi Games — LAN Real Device Baseline Results

## 测试记录

- 测试日期：未提供，待补充。
- Server：WSL2 中运行的 Node.js 服务，端口 3000。
- WSL 网络模式：mirrored。
- Windows Host 访问地址：`http://localhost:3000`。
- Mobile LAN 访问地址：`http://192.168.1.106:3000`；设备与主机处于同一 Wi-Fi。
- 测试设备类型：Mobile Device；具体设备型号、系统未提供。

## 实测结果

用户尚未提供实际测试结果。此前消息中的 PASS 条目明确标为示例，不计入本表。

| 项目 | 结果 | 备注 |
| --- | --- | --- |
| Mobile LAN access | 待提供 | |
| Room create/join | 待提供 | |
| QR | 待提供 | |
| Turn-based sync（示例：Gomoku） | 待提供 | |
| Private-state sync（示例：UNO） | 待提供 | |
| Realtime sync（示例：Snake Battle） | 待提供 | |
| Disconnect / reconnect | 待提供 | |
| Return lobby / restart | 待提供 | |
| Mobile functional UI | 待提供 | |

## 已知问题与结论

- 已知问题：未提供，待补充；目前不能据此判断为“无”。
- LAN multiplayer baseline：待实际结果确认。
- Public-Origin Compatibility / Cloudflare Tunnel preparation：待关键测试结果确认。

Windows Host 自己访问 `http://192.168.1.106:3000` 可能受 WSL2 mirrored
networking 行为影响而不可用。若其他 LAN 设备可通过该地址访问，这一现象
不视为 GameNest LAN multiplayer failure。
