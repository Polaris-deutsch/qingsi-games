# Oracle 第四阶段：只读审计与迁移前计划

审计日期：2026-10-11，约 12:32–12:38 UTC（Europe/Berlin 14:32–14:38）。

本次仅完成只读生产检查与本地文档记录。没有进行生产备份、安装、发布、服务重启、systemd 写入、sudoers 修改或定时任务启用。以下计划尚未执行；涉及生产影响的步骤必须另获明确批准。

## 1. 实际环境

| 项目 | 实测结果 |
| --- | --- |
| 公网地址 | `https://games.qingsiphotograph.com` |
| SSH | `ubuntu@130.61.12.149`，现有可信 host key 校验通过，非交互连接成功 |
| sudo | `sudo -n true` 成功；未修改授权 |
| 系统 | Ubuntu 24.04.5 LTS，ARM64 / aarch64，2 CPU |
| Node.js / npm | 24.21.0 / 11.19.0 |
| Node / npm CLI | `/usr/bin/node` / `/usr/lib/node_modules/npm/bin/npm-cli.js` |
| 项目目录 | `/home/ubuntu/qingsi-games`，普通目录，ubuntu:ubuntu，0775 |
| 正式进程 | `qingsi-games.service`，active/running，MainPID 10028，User/Group ubuntu，NRestarts=0 |
| 当前 unit | `/etc/systemd/system/qingsi-games.service`，root:root，0644 |
| 当前 drop-in | `/etc/systemd/system/qingsi-games.service.d/public-origin.conf`，root:root，0644 |
| 启动配置 | Type=simple；WorkingDirectory 为旧项目；ExecStart 为 `/usr/bin/node /home/ubuntu/qingsi-games/server.js`；KillMode=control-group；TimeoutStopSec=20 |
| 实际进程目录 / 可执行文件 | `/home/ubuntu/qingsi-games` / `/usr/bin/node`，启动参数匹配 |
| 生产环境变量 | `NODE_ENV=production`，`PORT=3000`，`PUBLIC_BASE_URL=https://games.qingsiphotograph.com`；未设置 HOST 或部署管理变量 |
| TCP 监听 | `0.0.0.0:3000`，归属 MainPID 10028；3101 未监听 |
| Cloudflare | `cloudflared.service` active/running，MainPID 9176，NRestarts=0；日志有成功注册连接记录 |
| Tunnel 源站 | 最近本机配置日志记录：该域名 → `http://127.0.0.1:3000`；不是通过 Cloudflare 控制台或 API 重新查询的配置 |
| Tunnel 凭据 | 使用 token-file；仅检查 `/etc/cloudflared/token` 元数据：root:root、0600，未读取内容 |
| 发布系统 | `/srv/qingsi-games`、`/opt/qingsi-games-deploy`、`/etc/qingsi-games`、`/run/qingsi-games` 均不存在；专用 qingsi-games 用户不存在 |
| 更新检查 | update-check service/timer 均 not-found，未安装或启用 |

上述 PID、资源和健康结果均为审计时快照，不能作为之后操作的永久授权。

## 2. 版本与发布门槛

WSL HEAD、GitHub master 和生产项目 HEAD 均为：

```text
0d4e35233adfc097e6c2a317b07e85650f72b2ea
```

生产 origin 身份为 `github.com/Polaris-deutsch/qingsi-games.git`，master 分支；package version 为 1.5.0。核对生产 HEAD 中 318 个文件：无缺失或异常类型；六个 Windows 脚本的字节差异仅为 CRLF，与 `.gitattributes` 一致，归一化后全部匹配 HEAD。

旧服务没有 release-info 或公开 health SHA。因此上述 SHA 是经源码核对的生产工作树 HEAD，**尚无部署系统提供的运行 SHA 证明**。进程路径、参数与工作树吻合，不应把这描述成已具备新版运行身份校验。

检查明确范围内的 38 个本地 CI/CD 文件：8 个已跟踪文件有改动，30 个新增文件尚未进入 HEAD。这包括 CI workflow、部署控制器、测试和 DEPLOYMENT 文档。没有执行 Git status / diff，没有提交或推送。

GitHub 官方 API 重新确认仓库和 master 身份后，对精确 SHA 查询现有 CI：

```json
{
  "verified": false,
  "code": "CI_UNVERIFIED",
  "reason": "NO_CI_RUN",
  "state": "pending"
}
```

这里的 pending 是控制器对“没有对应运行”的分类，不能据此宣称 GitHub 已有排队任务，也不能据此宣称整个仓库的所有 workflow 都失败。该 SHA 没有可接受的 master push CI 证明。

**结论：开发代码尚未完成提交、同步和精确 SHA CI 验证，禁止据此安装为已验证生产版本。**

## 3. 健康、网络和资源

- 本机 `/api/health`：HTTP 200，`ok:true`，service=qingsi-games，version=1.5.0。
- 公网 HTTPS `/api/health`：HTTP 200，同样的 JSON，无 releaseSha。
- 本机 WebSocket：101，Sec-WebSocket-Accept 正确。
- 公网 WSS：101，Sec-WebSocket-Accept 正确，TLS 1.3。只做握手，未创建房间或发送游戏操作。
- 初次 Python 公网 HTTP 请求得到错误响应；初次 WSS 探针的 key 长度错误，返回 400。随后使用有界 curl 和正确的 16 字节 key 得到以上有效通过结果；初次响应不计为验收通过，也不计为游戏故障。
- 从本次 WSL 来源探测 `130.61.12.149:3000` 超时，未发现可直连。主机 INPUT 存在末尾拒绝/丢弃规则，没有 3000 专用放行规则；UFW 查询不可用。**未审查 Oracle VCN 安全组，不能声称已经证明所有来源都无法直连。**
- 当前 3000 仍绑定全部 IPv4 地址。未来经批准的迁移配置应显式设置 `HOST=127.0.0.1`；本次未改绑定或防火墙。
- 项目约 143 MiB，node_modules 约 7.4 MiB；磁盘总约 44.1 GiB、可用约 40.3 GiB，使用率 9%，inode 使用率 4%。
- 内存总约 11.6 GiB、可用约 11.1 GiB；游戏 systemd 内存快照约 23.2 MiB，负载低。不是持续监控或压力测试结果。
- journal 当前约 23.4 MiB；未发现显式 SystemMaxUse / MaxRetentionSec 等覆盖配置，不等于 journald 没有默认限制。后续需要审核日志预算，避免未经批准修改全机日志策略。

102 个必要生产依赖的安装目录/版本与 lockfile 匹配，无缺失；没有验证现存 node_modules 每个文件的完整性。Oracle lockfile 与 WSL lockfile 的 SHA-256 相同：

```text
b1648f0e35b2ce16247718ba063a5b9b840b6a49cf43c3666a027982dcc8b4b7
```

WSL 实际执行有 timeout 的 `npm audit --omit=dev --ignore-scripts --json`：退出 0，0 漏洞。该结果是相同锁文件的当前 advisory 检查，不等于已在 Oracle 新候选目录安装或验证依赖。

## 4. 房间与运行数据

旧版未加载部署私有 Unix 管理接口，没有 admin socket。现有 `/api/debug/rooms` 与 `/api/debug/room/...` 本机检查均返回 404。没有开启调试接口、读取房间内容或推断隐藏状态。

**当前活跃房间数：UNKNOWN。不能当作 0 / EMPTY，不能用 WebSocket 数量代替。**

首次切换要求取得可信的空房证明，并解决检查后新玩家加入的竞态。旧版缺少新版 drain/计数接口；这个前置条件目前未解决。不能通过开启公网 debug、假定没人在线或重启后看到空房来伪造切换前的空房证明。

项目范围内只发现一个额外运行文件：`android-startup.log`，约 164 KiB，ubuntu:ubuntu、0664；没有读取其内容。它应作为运行日志单独备份，并在新版本中改用已支持的 shared 日志路径。node_modules 是可重建依赖，迁移恢复快照仍应保留其当前内容。内存房间不是磁盘备份，重启后不会恢复。

## 5. 后续迁移计划与批准点

每个阶段先交付实际检查结果，再请求下一阶段批准；本次不执行下面的生产写入。

### A. 开发发布前置条件

1. 审阅并提交前三阶段代码；推送必须另获授权。
2. 确认 GitHub master 是待安装的完整 SHA，所有必需矩阵检查、独立 audit 和 Deployment gate 对该 SHA 通过；审批 CI YAML 摘要。
3. 沿用已完成模拟测试的证据；修改了相关代码时只补相应针对性测试。不在 Oracle 运行完整 npm test。
4. 制定可验证的首次空房与禁止新加入方案。不能满足则保持旧服务运行，停止切换计划。

### B. 经批准后，先备份与准备

1. 建立私有备份目录，目录 0700、文件不向其他用户开放，分别保存 code、config、runtime-data、metadata。备份前再次检查服务、SHA、空间和配置摘要。
2. **代码备份**：当前源码、LICENSE/NOTICE、lockfile、当前依赖及版本/权限清单，建立只读恢复快照；继续保留原 `/home/ubuntu/qingsi-games`。
3. **配置备份**：原 game unit、完整 drop-in 目录及权限/摘要，保存在受控私有配置备份中。不得把 SSH key、Tunnel token 或其他凭据混入源码备份、Git 仓库或普通日志。
4. **运行数据备份**：启动日志和必要游戏日志；**元数据**：原 SHA、分支、服务路径/用户、MainPID、健康结果与时间。内存对局无法由这些文件恢复。
5. 安装独立 root 所有的 `/opt/qingsi-games-deploy`；用非 root 部署用户维护 `/srv/qingsi-games/{releases,shared,state}`。采用专用 qingsi-games 用户时，用户创建和唯一服务重启授权必须先审核批准；不会自动增加 sudo 权限。
6. 创建私有配置、管理 token、状态目录及 lock，使用已实测的 Node/npm 路径。创建可审阅的迁移记录时只能填写实际已完成的检查，不能预填成功。
7. 在 productionEnabled=false 的准备阶段，对精确 CI 通过的 SHA 执行 prepare；候选仅用 `127.0.0.1:3101`、独立依赖/日志/socket/token，不占 3000，不改旧项目或 current。验证源码、权限、依赖、audit、HTTP、WS 和模块加载。
8. 旧 SHA 的备份不能冒充通过新 CI、带私有运行接口的健康 release。首个受控制器管理的 current 必须是经过真实 prepare 的新 SHA；在没有第二个健康版本前，不伪造 previous 或 rollback 成功记录。

### C. 单独批准首次切换

仅在以上门槛满足、可信房间状态为空且维护方案批准后执行。

1. 再保存原 unit/drop-in 的完整可恢复副本和旧服务状态。
2. 添加专门的 versioned-release drop-in，保留原 public-origin.conf。设置 Type=exec、目标非 root 用户、`WorkingDirectory=/srv/qingsi-games/current`、唯一 Node/server.js ExecStart、HOST=127.0.0.1、私有 socket 与 shared 日志；保留 NODE_ENV/PORT/PUBLIC_BASE_URL。
3. 检查新 unit 的合并结果、文件完整性、环境与 sandbox 路径；审批后建立首个 current，daemon-reload，再仅重启 qingsi-games。
4. 交叉验证 MainPID/cgroup/cwd/exe、3000 监听、运行 SHA、HTTP、WS、私有管理接口和实际 systemd 限制。
5. 通过真实检查后运行现有 `doctor --resume`，恢复接收新房间并建立首个健康记录；失败则执行下一节的原系统恢复。
6. Cloudflare unit、token、Tunnel、DNS 和正式域名保持原状，不属于迁移写入范围。

### D. 后续演练与更新检测

1. 另行审批第二个已通过 CI 的维护性版本，执行 prepare/deploy/health/status，形成真实 previous。
2. 失败启动模拟先在隔离候选或演练环境完成；不得破坏生产代码。真实 rollback 演练需要新的维护窗口和明确批准。
3. 稳定后再审批安装 oneshot update-check service 和 hourly timer，随机延迟最多 10 分钟、Persistent=true；先手动验证只检查、不重启游戏，再启用 timer 并查看真实日志。
4. 审核版本和日志保留预算。CPU、内存、磁盘等目前仅为审计快照，尚未安装持续轻量监控；后续实现只记录异常，不建立无限重启循环。

## 6. 中断预算、风险与恢复

### 中断预算

本次审计未重启，未测量真实切换耗时。首次切换暂估 **10–30 秒**服务不可用，建议预留 **5 分钟**维护窗口；这是计划预算，不是已验证 SLA。当前 stop timeout 为 20 秒，若启动失败，恢复旧配置及旧服务再留 **1–2 分钟**预算，实际取决于验证结果。

候选安装和检查应在旧服务继续运行时完成，不算入重启窗口。每次真实发布/回滚都会断开 WebSocket，内存房间和旧对局不会恢复。

### 首次迁移失败的恢复方案

此时不能依赖尚不存在的 previous 或普通 rollback 命令。

1. 停止继续部署，保留失败候选、配置差异与日志。
2. 恢复备份的原 game unit 和完整原 drop-in；只撤除本次新增的迁移 drop-in，不覆盖其他来源的新配置。
3. 恢复原 User/Group ubuntu、Type=simple、旧 WorkingDirectory 和旧 ExecStart，以及原环境；保留旧项目和依赖，不执行 git reset 或原目录 npm 安装。
4. daemon-reload，核对合并配置确为旧服务，再仅重启 qingsi-games。
5. 验证 MainPID/cwd/exe、3000 监听、本机与公网 health、WSS、旧源码 SHA；确认 Cloudflare 未变。记录失败原因和恢复结果。
6. 即使 current 指针仍留在新目录，只要 unit 已恢复就不再依赖它；之后离线核查指针/迁移记录，不能只恢复 symlink 而遗漏 unit。

上述恢复包含重启，也是首次切换批准时必须一并明确批准的生产动作。失败后的不可预期情形应停止并报告，不能扩大操作范围。

### 主要剩余风险

- 未提交发布代码、精确 SHA CI 缺失、旧版房间数 UNKNOWN 是当前阻塞项。
- 首次迁移没有控制器自动回退基线，只能恢复原 unit 与旧目录；至少两个真实健康 release 后才具备已验证 previous。
- 新用户的 /proc 可见性、真实 systemd sandbox、ARM64 候选依赖和最小重启授权尚未验证。
- 现有服务缺少 ProtectSystem/ProtectHome/NoNewPrivileges 限制；新增限制需要验证日志和运行目录，不能照搬模板后直接重启。
- 主机监听 0.0.0.0、Oracle VCN 规则未独立审查；本次不修改安全组。
- 全局 journal 配额和长期监控尚未审核安装；旧目录不得自动删除。
- 电脑建房、手机加入、魔力桥、聊天/Emoji、重连的本次真机验收尚未进行，握手通过不能替代这些测试。

## 7. 本轮验证与未执行项

| 项目 | 结果 |
| --- | --- |
| SSH、sudo -n、服务/进程/目录/权限/资源只读检查 | 完成 |
| 本机 HTTP / WS，公网 HTTPS / WSS | PASS |
| 相同 lockfile 的 WSL npm audit | PASS，0 漏洞，网络/命令均有限时 |
| 第三阶段既有 check 日志 | 222 个 JS 文件通过；本轮未重跑 |
| 第三阶段既有完整测试日志 | 548 PASS，0 fail/cancel/skip；模拟环境结果，本轮未重跑 |
| 后续房间强制确认文案针对性测试日志 | 1 PASS；本轮未重跑 |
| 当前完整 SHA 的 GitHub 发布门槛 | 未通过验证：NO_CI_RUN |
| 生产候选 prepare、真实部署和回滚 | 未执行 |
| 全量 npm test、浏览器回归、npm install/ci | 本轮未执行 |
| timer、sudoers、systemd、Cloudflare、DNS | 本轮未修改 |
| Git commit / push / Release | 本轮未执行 |

SSH 私钥仅作为 SSH 客户端认证参数使用，未读取或复制内容；生产 token 未读取或写入仓库。所有探测进程已退出，没有启动测试服务器或长期 daemon。
