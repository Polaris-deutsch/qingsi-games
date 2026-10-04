# Windows 一键管理 QingSi Games

控制器：`scripts/qingsi-games-service.sh`。已确认 `npm start` 是 `node server.js`；控制器直接启动该入口并记录真实 Node PID。

## 安装桌面快捷方式

在 Windows 文件资源管理器中打开 `scripts/windows`，也可以把整个目录复制到一个固定的 Windows 文件夹。不要在安装后移动或删除这份目录。

在该目录打开 PowerShell，由你手工执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-QingSi-Games-Shortcuts.ps1
```

安装器通过系统 Desktop 路径创建“启动 QingSi Games”“停止 QingSi Games”“QingSi Games 状态”三个快捷方式，兼容 OneDrive Desktop。路径中的空格、中文用户名均有引号保护。同名但不是本安装器创建的快捷方式会被跳过。

默认使用 Windows 当前默认 WSL 发行版。如项目位于另一发行版，可在 Windows 的用户环境变量设置 `QINGSI_WSL_DISTRO` 为 `wsl.exe --list --quiet` 显示的对应名称，再重新打开终端或登录。脚本不固定发行版名称，也不安装 WSL。

## 使用

双击桌面启动、停止或状态快捷方式。窗口显示结果后按任意键关闭；关闭启动窗口不影响后台服务器。也可以双击 `Restart-QingSi-Games.cmd` 重启。

WSL 中可以直接运行：

```bash
/home/polarstern/projects/qingsi-games/scripts/qingsi-games-service.sh start
/home/polarstern/projects/qingsi-games/scripts/qingsi-games-service.sh stop
/home/polarstern/projects/qingsi-games/scripts/qingsi-games-service.sh status
/home/polarstern/projects/qingsi-games/scripts/qingsi-games-service.sh restart
/home/polarstern/projects/qingsi-games/scripts/qingsi-games-service.sh logs
```

启动使用固定端口 `3000`，`PUBLIC_BASE_URL` 默认集中定义为 `https://games.qingsiphotograph.com`，可通过调用控制器时的同名环境变量覆盖。控制器不会修改普通 `npm start` 的 LAN/local 配置。

开启请求仍由站长收到 ClawBot 后手工处理。脚本不控制 Cloudflare Tunnel，不远程启动，也不增加开机或登录自启动。退出整个 WSL 或 Windows 关机仍会停止服务器。

## 状态与日志

默认状态目录：`~/.local/state/qingsi-games/`；若设置 `XDG_STATE_HOME`，使用其下的 `qingsi-games/`。

- `qingsi-games.pid`：JSON 格式，保存 PID、Linux 启动时间及 boot ID。
- `qingsi-games.log`：服务器输出；`logs` 返回最近约 80 行。
- 控制器也把现有启动追踪输出导向该日志，运行日志不会写入仓库。
- 日志超过 5 MiB 时在下次启动前移为 `.log.1`，只保留一份历史日志。
- `qingsi-games.lock`：防止两个控制命令同时启动实例。

`status` 分别报告进程与本地健康状态。健康检查最多 3 秒，仅 HTTP 成功且 JSON 的 `ok === true`、`service === "qingsi-games"` 才显示 ONLINE。它不代表公网 Tunnel 的实时状态。

停止前及升级终止信号前，均核对 PID 的启动时间、boot ID、当前用户、Node 可执行程序、绝对服务入口和工作目录。先发送 SIGTERM，最多等 5 秒，再仅对身份仍匹配的 PID 发 SIGKILL。过期或不匹配的 PID 记录只会被清理，不会向它发送信号。

## 故障处理

- `Port 3000 is already in use.`：保留占用进程，先检查其他服务。若占用者被确认是本项目的 Node 入口，`start` 会接管其 PID 记录并报告已运行。
- `Failed to start QingSi Games.`：运行 `logs` 查看启动原因；脚本不会无限重启。
- `WSL is unavailable.`：确认 WSL 已安装、默认发行版可启动、项目路径存在。
- Node 不在 WSL PATH：控制器会尝试加载当前用户 nvm 的默认版本；仍不可用时请配置 Node 18+。
- 进程 RUNNING 而 Health OFFLINE：运行 `logs`；根据结果手工决定是否重启。

## 卸载桌面快捷方式

在同一 Windows 目录手工执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-QingSi-Games-Shortcuts.ps1 -Uninstall
```

只删除带本安装器标记的三个 QingSi Games 快捷方式；卸载不停止服务器，也不删除项目文件。
