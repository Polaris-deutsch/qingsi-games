# QingSi Games：CI 与部署版本验证

第一阶段建立 CI 和版本验证基础；第二阶段提供 Oracle 部署控制器；第三阶段增加“自动检查、人工批准”的更新检测。控制器和更新检测均在 WSL 开发及模拟验证。生产 Node.js 基准为 **24**，继续检查 Node.js 18、20、22 的兼容性。本文件中的生产路径和安装步骤均为方案，本轮没有连接或修改 Oracle。

## 1. 什么时候执行 CI

沿用 `.github/workflows/ci.yml`，没有新增重复的 CI workflow：

- 推送到 `master` 或原有兼容分支 `main`。
- 创建、更新或重新打开 Pull Request。
- 同一 ref 的新运行会取消旧运行；取消不表示通过。

PR 默认检查 GitHub 生成的合并提交，`GITHUB_SHA` 是该合并提交的 SHA，通常不同于 PR 源分支 SHA。合入 `master` 后必须再次检查实际待发布提交的 push CI，不能沿用 PR 的绿色结果。参见 [GitHub PR 事件说明](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)。

## 2. 发布必需检查

| 可查询的 Job / Check 名称 | 必须完成的操作 |
| --- | --- |
| `Checks (Node.js 18)` | `npm ci`、版本 SHA 核对、`npm run check`、`npm test` |
| `Checks (Node.js 20)` | 同上 |
| `Checks (Node.js 22)` | 同上 |
| `Checks (Node.js 24)` | 同上；生产版本基准 |
| `Security audit (Node.js 24)` | `npm ci`、`npm audit --omit=dev` |
| **`Deployment gate`** | 依赖全部矩阵检查和安全审计，只接受所有依赖的 `success` |

安装步骤关闭 npm 的隐式审计，显式审计只运行一次。没有 `continue-on-error` 或忽略退出码的回退。审计发现任何等级的生产依赖漏洞都会失败；网络、registry、权限或响应异常也会失败，不能记录为“0 漏洞”。不会执行 `npm audit fix --force`。

`Deployment gate` 使用 `always()`，因此上游失败或跳过后仍会检查结果并明确失败。`failure`、`cancelled`、`skipped`、缺失结果均不通过。工作流本身被取消而未执行 gate 时，同样没有有效通过结果。依赖语义见 [GitHub workflow 语法](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)。

每个 Job 和主要步骤均设有超时；npm 网络请求也设有超时和有限重试。CI 不启动长期服务，不修改源文件，也不部署 Oracle。

## 3. 如何确认指定完整 Commit SHA

部署控制器必须先固定一个 **40 位完整 Commit SHA**。不能使用 `1.5.0`、短 SHA、可移动分支名或其他提交的一次成功记录作为验证依据。

对于待发布的 `master` 提交，按以下顺序查询 GitHub Actions：

1. 固定仓库为 `Polaris-deutsch/qingsi-games`，workflow 为 `.github/workflows/ci.yml`（可由 workflow API 取得并固定其 ID）。
2. 查询该 workflow 的 runs，使用 `head_sha=<完整 SHA>&event=push&branch=master`。不要预先按 `success` 过滤，否则可能漏掉较新的失败或运行中记录。
3. 在匹配运行中选择最新的 run，重新获取其详情和最新 `run_attempt`。再次核对仓库、workflow ID/path、`event=push`、`head_branch=master` 和 `head_sha` 完全匹配。
4. 运行必须是 `status=completed` 且 `conclusion=success`。排队、运行中、等待审批、缺失运行都表示尚未验证；失败、取消、超时、跳过或中性结论均不通过。
5. 查询最新 attempt 的 jobs，确认上表六个精确名称均存在、`head_sha` 匹配且 `status=completed`、`conclusion=success`。读取分页，不能只检查一个同名绿色 Job。若只重跑失败 Job 导致当前 attempt 缺少必要记录，使用 **Re-run all jobs** 重新生成完整证据。
6. 在最终接受结果前重新核对 run 详情，确认没有更新的 attempt 或匹配 run；未来真正部署前还需再次验证。保留 SHA、workflow ID、run ID、attempt 和结果链接作为审计记录。

查询端点（第二阶段已实现只读查询逻辑，并通过 mock 验证）：

```text
GET /repos/Polaris-deutsch/qingsi-games/actions/workflows/ci.yml/runs?head_sha=<SHA>&event=push&branch=master
GET /repos/Polaris-deutsch/qingsi-games/actions/runs/<RUN_ID>
GET /repos/Polaris-deutsch/qingsi-games/actions/runs/<RUN_ID>/attempts/<ATTEMPT>/jobs
```

官方 API：[workflow runs](https://docs.github.com/en/rest/actions/workflow-runs)、[workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs)。查询失败、响应不完整或无法确认身份时，结果为“未验证”，不能允许部署。未来查询凭据只需 Actions 读取权限，与 CI 的只读 token 和生产部署凭据分开。

## 4. 版本 JSON

在有 Git 元数据的开发或 CI checkout 中运行：

```bash
node scripts/release-info.js
# 通过 npm 获取纯 JSON：
npm run --silent release:info
```

输出字段：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | JSON 格式版本，当前为 1 |
| `commitSha` | `HEAD` 的完整 Commit SHA，主要版本标识 |
| `commitSubject` | 提交的简短描述 |
| `branch` | 当前 Git 分支；detached HEAD 时为 `null` |
| `packageVersion` | `package.json` 的版本，不能单独标识代码版本 |
| `checkedAt` | 元数据生成时间，UTC ISO 8601；不是构建时间或通过凭据 |
| `ci` | Actions 中附加仓库、事件、ref、run ID 和 attempt |

存在 `GITHUB_SHA` 时必须与检出的 SHA 完全一致，否则工具失败。没有 Git、无法读取提交或缺少 package version 时不会生成虚构版本。Git 子命令设有 5 秒超时。

gate 成功检查依赖后生成 JSON，保存为 `release-info-<完整 SHA>-<attempt>` artifact，保留 30 天。必须在整个 run 和 gate 最终成功后才可使用。JSON 和 artifact 都是辅助元数据，不能取代 GitHub 的检查结果。

本地尚未提交的修改不属于 `HEAD`；该工具不检查工作区状态，本地输出不证明这些修改已通过 CI。PR 的 `branch=null` 与 `ci.ref=refs/pull/.../merge` 如实描述合并提交，不能把它当作 `master` 版本。源码 ZIP、APK 和 Windows 可执行文件可能没有 Git，运行服务和打包流程均不依赖此工具。

## 5. GitHub 手动配置

本次只修改仓库文件，**没有启用或修改远端分支保护 / Ruleset**。

维护者需在首个新 CI 运行产生检查名称后，到仓库 **Settings → Rules → Rulesets**（或 **Branches → Branch protection rules**），为 `master` 配置：

- 要求通过 Pull Request 合并并经过审核。
- 启用 required status checks，选择 **`Deployment gate`**，来源选择 GitHub Actions；它汇总上表全部必要检查。也可额外选择四个 `Checks` 和安全审计。
- 要求分支在合并前保持最新，限制绕过保护规则和直接推送的权限。
- 审核 CI、gate 和版本工具的修改；能改写验证规则的提交必须由可信维护者审查。

检查名称应在整个仓库中保持唯一。这里没有增加 `merge_group` 触发器；若以后启用 GitHub Merge Queue，必须先增加该触发器并验证队列生成的 SHA。

分支保护约束合并，不替代未来部署控制器对实际待部署 SHA 的核验。已有 tag Release / Android workflow 继续独立运行，当前 `Deployment gate` 不会自动限制它们；给打包和发布加门槛属于后续明确授权的改动。

## 6. 查看结果与排查失败

打开 [仓库 Actions](https://github.com/Polaris-deutsch/qingsi-games/actions/workflows/ci.yml)，选择对应 SHA 的 `CI` 运行，在 Jobs 中展开失败步骤。PR 的 Checks 页面也可进入运行详情。

| 失败位置 | 排查内容 |
| --- | --- |
| Install dependencies | lockfile 与 package 是否一致、registry 连通性、包下载或 integrity 错误 |
| Identify the tested commit / version metadata | checkout 的完整 SHA、`GITHUB_SHA`、Git 元数据是否存在 |
| Syntax check | 日志中明确指出的文件和语法错误 |
| Test | 首个失败测试、退出码、信号、服务测试记录的 PID / 临时目录 |
| Audit production dependencies | 漏洞 advisory；或 registry / 网络失败。修复原因后重新检查，不自动强制升级 |
| Deployment gate | `test` 或 `audit` 的实际结论、是否取消 / 跳过、元数据 artifact 是否上传失败 |

测试入口保留全部 GameNest 测试，子进程启动失败、被信号终止或没有正常退出码时返回失败，避免误报成功。

本地可在开发 checkout 中执行以下验收；当前命令纪律要求每条仅执行一次，异常等待立即停止，不为同一验证反复重跑：

```bash
timeout --kill-after=5s 90s env npm_config_registry=https://registry.npmjs.org npm_config_fetch_retries=0 npm_config_fetch_timeout=15000 npm_config_audit=false npm ci
timeout --kill-after=5s 60s npm run check
timeout --kill-after=5s 120s npm test
timeout --kill-after=5s 45s env npm_config_registry=https://registry.npmjs.org npm_config_fetch_retries=0 npm_config_fetch_timeout=15000 npm audit --omit=dev
```

完整测试只在明确验收时运行，日常修改先选择相应测试文件。可用 `node --test tests/ci-tools.test.js tests/release-info.test.js` 检查门槛、异常退出和版本识别；服务改动对应 `node --test tests/service-controller.test.js`。本项目收尾不要求 Git inspection 命令。

## 7. 为什么不能在 Oracle 生产目录直接运行 npm test

测试会启动和停止真实子进程、建立 WebSocket 并验证端口冲突与失败启动。生产环境中的负载、依赖安装和生命周期操作会干扰在线服务，也不能提供 GitHub Actions 上与精确 SHA 绑定的结果。应在 GitHub-hosted runner 或独立开发 / 测试环境验证，不能在生产服务器用完整测试作为部署探针。

服务生命周期测试现在向操作系统申请临时端口，并给自己的控制器和 fixture 设置 `NODE_ENV=test`、`QINGSI_GAMES_TEST_PORT` 和独立状态目录。测试端口拒绝 3000，正式控制器仍固定 3000，忽略普通 `PORT` 和非测试环境的测试端口设置。端口预约关闭后仍有很小的抢占窗口；冲突会使测试失败，不授权停止其他进程。

测试保留启动、停止、重启、健康检查、手动实例识别、WebSocket 关闭、日志轮转、PID 复用保护和冲突保护。清理仅操作记录并再次确认身份的本次测试子进程，不使用 `pkill node` / `killall node`。

## 8. 安全边界与本阶段限制

- 普通 CI 仅 `permissions: contents: read`，checkout 不保留凭据。
- 使用 GitHub-hosted runner 和 `pull_request`，没有 `pull_request_target`。
- CI 不读取 Oracle SSH 私钥、Cloudflare Token、Oracle API Key 或生产密码，也不修改 Oracle。
- `npm ci` 只安装依赖；CI 不运行自动修复、不生成源码提交。版本 JSON 写入 runner 临时目录。
- Android APK、Windows 打包和 GitHub Release workflow 未调整；原有 Release 的写权限仅属于其独立发布流程。
- 依赖审计是当前 registry advisory 的检查结果，不能证明应用不存在安全问题。
- 本地验证不能证明远端 Actions 已成功；需在确认提交、手动推送后检查目标完整 SHA 的实际 run。
- **CI 成功不等于自动部署。** 第二阶段控制器源码独立于 CI；生产安装、迁移和真实运行验证尚未执行，CI 没有生产凭据或部署权限。

## 9. 第一阶段本地验收记录

日期：2026-10-11。环境：WSL Ubuntu，Node.js 24.13.0、npm 11.6.2。

| 验证 | 结果 |
| --- | --- |
| `npm ci` | PASS，安装 102 个依赖包；没有修改依赖版本或 lockfile |
| `npm run check` | PASS，检查 203 个 JavaScript 文件 |
| `npm test` | PASS，467 项通过，0 失败 / 取消 / 跳过，约 10.7 秒 |
| `npm audit --omit=dev` | PASS，实际请求官方 npm registry，0 漏洞 |
| CI / Release / Android YAML | PASS，使用现有 PyYAML 解析并拒绝重复键；额外核对 CI 触发器、矩阵、权限、超时和 gate 依赖 |
| 新增回归覆盖 | gate 非成功 / 缺失结果拒绝、审计错误退出码保留、测试进程异常退出拒绝、完整 SHA / detached HEAD / SHA 不匹配、测试端口隔离 |

四项 npm 验收各运行一次并设置外层超时。没有运行 actionlint（环境未安装），没有执行浏览器测试、APK / Windows 构建、远端 Actions 或 Oracle 验证。Node.js 18 / 20 / 22 的实际执行结果需由后续远端矩阵运行确认。提交、推送和 Release 均未在本次本地验收中执行。

## 10. 第二阶段：Oracle 部署控制器

本阶段实现源码、配置模板和 WSL sandbox 验证。**没有连接 Oracle，没有安装或修改真实 systemd 服务，没有部署。** `config.example.json` 的 `productionEnabled` 默认为 `false`，CI 策略摘要为必须人工替换的占位值。

Oracle 目标为 Ubuntu 24.04 ARM64、Node.js 24。生产游戏仍由唯一的 `qingsi-games.service` 管理；`cloudflared.service`、Tunnel、DNS 和 VCN 不在控制器操作范围内。WSL 的 `scripts/qingsi-games-service.*` 继续管理本地开发进程，部署控制器不会调用它们。

### 10.1 目录与不可变版本

```text
/opt/qingsi-games-deploy/             # 经审核、root 拥有的独立控制器，仅使用 Node 内置模块
/etc/qingsi-games/deploy.json         # 私有配置
/etc/qingsi-games/admin.token         # 本机管理凭据
/etc/qingsi-games/github-read.token   # 可选，GitHub Actions 只读凭据
/srv/qingsi-games/
  current -> releases/<完整 SHA>
  previous -> releases/<上一个健康 SHA>
  releases/<完整 SHA>/
    package.json
    package-lock.json
    node_modules/                   # 此版本独立安装，禁止跨版本硬链接或外部软链接
    release-info.json               # 只读版本身份
    .qingsi-release.json             # 只读准备凭据与整树指纹
    ...                             # 对应 Git 提交的完整源码
  shared/startup.log                 # 已识别的运行日志，不存放可执行源码
  state/
    repository.git/                 # 专用 bare Git 缓存
    candidates/                     # 未发布候选目录
    prepared/                       # 独立准备凭据
    healthy/                        # 经实际运行验证的历史版本记录
    logs/                           # 安装、审计与 smoke 日志
    deploy.lock
    transaction.json                # 仅事务未结束时存在
    history.jsonl
    migration.json                  # 第四阶段真实主机审查后的人工签署记录
/run/qingsi-games/admin.sock          # 私有 Unix socket，不增加 TCP 管理端口
```

Release 封存后文件为 `0444/0555`、目录为 `0555`，包含已安装依赖的 SHA-256 树指纹。部署和回滚重新核验内容、只读权限、元数据和 `state/prepared` 凭据。准备过程先核对 Git blob 与可执行位；安装和 smoke 后再次核对，拒绝新增或被改写的源码。当前用户仍能修改自己拥有的文件权限，因此这些校验用于发现变化，并不宣称文件系统具备硬件级不可变性。

### 10.2 命令

以下为**第四阶段安装后的使用方法**；本阶段未在 Oracle 执行。

```bash
/opt/qingsi-games-deploy/deploy.sh status
/opt/qingsi-games-deploy/deploy.sh prepare <FULL_SHA>
/opt/qingsi-games-deploy/deploy.sh deploy <FULL_SHA>
/opt/qingsi-games-deploy/deploy.sh rollback
/opt/qingsi-games-deploy/deploy.sh history
/opt/qingsi-games-deploy/deploy.sh doctor
/opt/qingsi-games-deploy/deploy.sh doctor --resume
```

| 命令 | 行为 |
| --- | --- |
| `status` | 输出 current / previous、事务、实际进程健康和房间计数；已启用生产但未就绪时退出 1 |
| `prepare SHA` | 核验来源与 CI，独立安装、检查、审计、smoke、封存；不切换 current，不重启生产 |
| `deploy SHA` | 重新验证指定版本、实时 CI、审计及 smoke，批准后切换并重启；已有同一健康版本时不重复安装或重启 |
| `rollback` | 只恢复最近的已验证 previous；未结束事务使用日志中已验证的旧版本，不接受任意 SHA |
| `history` | 输出有界 JSONL 历史的 JSON 数组 |
| `doctor` | 检查迁移记录、systemd、release 和实际健康，不写 systemd 配置 |
| `doctor --resume` | 在互斥锁内重新验证 CI 和健康，再恢复接收新房间；用于首次迁移或人工重启后的恢复 |

默认配置为 `/etc/qingsi-games/deploy.json`，可通过 `--config <绝对路径>` 指定经权限检查的配置。配置不允许任意仓库 URL、service 名称或生产根目录。SHA 必须是 40 位小写十六进制完整值。

`deploy` / `rollback` 默认要求输入目标完整 SHA。`--yes` 仅代替这一次确认；不能跳过来源、CI、安全、迁移或健康检查。存在房间或无法确认房间状态时，还必须加 `--force-active`，并在终端单独输入 `TERMINATE ROOMS <FULL_SHA>`，明确接受“可能终止当前对局”。单独使用 `--yes --force-active` 无法通过该检查。

标准输出为 JSON，标准错误为 JSON 事件或交互提示。退出码：`0` 成功、`1` 检查或部署失败（包括已自动回滚的失败部署）、`2` 用法错误、`3` 回滚失败的高严重度错误、`75` 互斥锁冲突、`130` 被取消。准备和部署共享真正的 Linux `flock`，冲突操作立即拒绝；未结束事务阻止新的 prepare / deploy，要求先恢复。

### 10.3 精确 SHA 与 CI 验证

控制器只从 `https://github.com/Polaris-deutsch/qingsi-games` 获取 `master`，检查指定 SHA 是本次获取的远程 master 的祖先，再对该 SHA 执行 `git archive`。缓存配置禁止 URL 重写、额外远程源和 include 配置。master 后续前进不会改变目标 SHA，审批完成后还会重新检查来源与 CI。

GitHub API 核验包括：

1. 固定仓库的 `.github/workflows/ci.yml`，有效 workflow ID。
2. 精确 `head_sha`、本仓库 `push`、分支 `master`，取该 SHA **最新运行**，不能用更早的绿色运行替代。
3. 运行及其最新 attempt 均为 `completed/success`。
4. 四个 Node 检查、生产依赖审计、`Deployment gate` 六个名称唯一的 job 全部成功，且属于该 SHA / run；安装、检查、测试、审计和 gate 的必需步骤确实成功。
5. 完整读取分页，再次读取 run 和最新列表；运行或 attempt 在查询过程中变化即拒绝。

失败、取消、排队、运行中、跳过、缺失步骤、仓库 / SHA 不符、响应不完整、API 限额和网络错误均拒绝。记录 run ID、attempt、URL 与核验时间。API 机制参见 [GitHub workflow runs](https://docs.github.com/en/rest/actions/workflow-runs) 和 [workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs)。

配置中的 `ciPolicySha256` 为人工审核过的 CI YAML 原始字节摘要白名单，防止候选提交悄悄弱化 CI。可在已审核的开发 checkout 用 Node 内置 `crypto` 计算；这不替代代码审核或 GitHub 运行结果。更新策略时保留 current / previous 所需的旧摘要，否则旧版本的校验与回滚会被拒绝。支持 1–10 个不同的 SHA-256 摘要。

准备凭据不能作为新部署的永久 CI 授权，deploy 会实时重查。**恢复已健康版本的 rollback 使用其封存 CI 凭据**，可在 GitHub 暂时不可用时恢复，但仍重新验证本地版本完整性、进程和 HTTP。

### 10.4 候选隔离与健康检查

候选在 `state/candidates` 独立目录使用自己的 `node_modules`。依次执行 `npm ci`、`npm run check`、`npm audit --omit=dev`，不会在 `/home/ubuntu/qingsi-games` 或 live current 中安装依赖。安装使用锁文件、固定官方 registry、禁止 lifecycle install hooks；如以后增加需要安装脚本的原生依赖，必须先审核并调整策略，不能直接关闭限制。审计失败或网络不可达都会停止准备，不运行 `audit fix`。

候选代码以非 root 用户运行，清理后的环境不携带 GitHub token 或生产管理 token。候选使用自己临时生成的管理 token、Unix socket、日志和进程组。默认只监听 `127.0.0.1:3101`，配置禁止使用 3000；端口冲突即失败，不停止已有监听者，也不尝试下一个端口。

`HOST` 为新增的可选 IP 配置；不设置时仍为 `0.0.0.0`，LAN / localhost 行为保留。现有端口逻辑仅在未显式设置 `PORT` 时回退；显式候选端口不会回退。无部署变量时，公开 health 保持原有格式。

部署健康验证交叉检查：

- `systemd MainPID`、服务的 cgroup、UID、Node 可执行文件、精确 server.js 参数、`/proc/<pid>/cwd` 和进程启动标识。
- `/proc` socket inode 确认该进程仅在批准的 IPv4 loopback TCP 端口监听。
- 实际 HTTP 200、JSON、`ok=true`、`service=qingsi-games`、完整 `releaseSha`。
- WebSocket 101 握手和匹配的 ping / pong，未创建房间或修改游戏状态。
- 私有状态确认游戏注册初始化完成；候选必须没有房间或玩家。
- 连续三次观察同一进程，结束时再次检查进程身份和监听端口。

不是仅检查 `systemctl is-active` 或静态 metadata。公开 health 的新增字段只包含 SHA，不输出路径或凭据。

Git 网络子进程最多 60 秒；GitHub 单次请求 10 秒并限制响应大小；安装 60 秒，检查 / 审计 30 秒，本机 HTTP 1 秒、WS 1.5 秒。命令总取消定时器为 180 秒，恢复操作另有有界的服务检查。只终止自己启动的候选进程组，先 TERM 再 KILL，并等待退出；不会调用 `pkill` / `killall`。异常残留的 socket 不自动删除，避免误删其他进程的入口，需依据日志中的 PID 调查。

### 10.5 房间检查与重启窗口

已阅读当前房间生命周期：房间在内存 Map 中；断线重连宽限期、主动离开宽限期和 lobby 仍可能保留玩家。控制器保守地将 **所有仍存在的房间** 计为阻止部署的房间，不使用 WebSocket 数量推断无人游戏。

仅启用部署变量时，服务才启动独立 Unix socket。socket 目录必须由服务用户拥有且为 `0700`、socket 为 `0600`，请求需要 32 随机字节的私有 Bearer token。公网 Express 应用没有管理路由；Unix socket 也不会通过 PUBLIC_BASE_URL 暴露。返回仅为房间 / 玩家计数、版本和初始化状态，不包含 room ID、隐藏手牌、游戏 state、断线 token 或调试操作。

切换前先设置 drain，禁止新建和加入房间，原有游戏操作仍可继续，然后读取真实房间计数并决定是否允许重启。这样避免检查“空房”之后、新玩家在切换前加入的竞态。所有人工确认结束后、切换指针前再次查询 CI；期间被撤销的通过结果会阻止切换，并恢复旧服务接收房间。新服务默认以 draining 状态启动，健康验证成功后由控制器恢复接收房间，并核对管理响应确实应用了请求的 drain 状态。

drain 的设置与摘要读取在同一服务端事件循环回调中完成。已有等待房间仍可开始游戏或重开，但所有保留房间都阻止普通发布；当权威摘要确认为 EMPTY 后，create/join 被暂停，无法再产生新对局。`status` 的一次 EMPTY 仅是快照，不能替代部署时的 drain 和再次检查。同一服务用户及 root 能访问私有 socket；其他本地用户受父目录 0700、socket 0600 和 Bearer 授权限制，代理 IP 头不参与授权。人工强制发布明确放弃房间保护，仍会断开玩家。

单进程重启期间 WebSocket 会断开，内存房间不会持久化。**本方案无法零中断；rollback 恢复代码和依赖，不恢复房间或对局状态。** 真实活动房间默认阻止部署，强制部署必须单独确认损失。

### 10.6 指针切换、systemd 与回滚

deploy 要求当前版本完整、实际健康，并保存可验证的回退目录。保存 previous 后，通过同一文件系统上的 symlink rename 原子切换 current，再仅执行：

```text
sudo -n /usr/bin/systemctl restart qingsi-games.service
```

重启之前验证已加载的 systemd 配置：`Type=exec`、部署用户、`WorkingDirectory=/srv/qingsi-games/current`、唯一精确的 Node/server.js `ExecStart` 和 `KillMode=control-group`。实际新进程和 HTTP SHA 必须匹配目标；不因 master 更新改用其他版本。

切换后的启动、SHA、HTTP、WS 或恢复接收房间失败，会恢复原 current / previous，重启旧健康版本，再做相同的实际健康验证。自动回滚成功仍返回部署失败；回滚也失败时返回退出码 3，输出 `HIGH SEVERITY`，保留事务、失败 SHA、原因和日志，绝不报告恢复成功。进程被强行中断后留下的事务需通过 `doctor` / `history` 调查，再运行 `rollback` 恢复。

本轮只提供 `40-versioned-release.conf.example` 和 `sudoers.example`，没有安装。模板保持现有 PUBLIC_BASE_URL drop-in，限制运行时目录写入、代码只读、私有凭据与部署状态不可见，sudoers 只授权上述唯一服务重启。systemd 配置语义参见 Ubuntu 24.04 的 [systemd.service](https://manpages.ubuntu.com/manpages/noble/man5/systemd.service.5.html) 和 [systemd.exec](https://manpages.ubuntu.com/manpages/noble/man5/systemd.exec.5.html)；本地 mock 不能证明真实宿主机已加载这些限制。

### 10.7 日志和清理

历史为结构化 JSONL，包含 SHA、previous、时间、触发方式、CI 引用、结果、回滚原因和健康结论。每段约 256 KiB 后轮转，保留当前段及 4 个归档。安装 / smoke 日志每个限制 1 MiB，保留最近 20 个及受保护版本相关日志。不会记录凭据、原始游戏 state 或完整环境。

成功切换后默认保留最近 5 个健康版本（可配 3–10），另保留同样数量的已准备版本；现存历史不足时不会虚构额外版本。current、previous、任何仍在运行的 release 始终受保护；candidate 目录不参与 release 清理。历史凭据和日志按各自策略保留。

删除只允许 releases 内已验证的直接子目录，核验 canonical path / realpath，不跟随逃逸链接，不使用 shell `rm -rf $VARIABLE`。无法确认路径、版本或正在运行的进程时跳过清理并记录原因。旧 `/home/ubuntu/qingsi-games`、shared、系统目录不属于删除范围。

### 10.8 第四阶段真实安装前的必要工作

以下事项**尚未执行**，不能用 WSL 结果替代：

1. 备份并审核真实 Oracle 的 unit、全部 drop-in、旧项目及实际环境；确认 Node 24 ARM64 路径、运行用户、文件权限和端口。
2. 检查真实项目读写依赖和额外文件。当前源码检查发现启动日志写入，游戏房间驻内存、资源与语言文件为读取；这不证明 Oracle 没有自定义数据、日志路径或外部挂载。逐项决定迁移 / 备份位置，shared 不得作为可执行代码源。
3. 审核安装独立 root 拥有的 `/opt/qingsi-games-deploy`，创建非 root `qingsi-games` 用户及其目录权限、私有 token / 配置；配置实际 npm-cli 路径和审核后的 CI 摘要。公开仓库可不设置 GitHub token；如设置，权限只需读取 Actions 结果。
4. 确认目标完整 SHA 在远端新 CI 下实际通过，再 prepare。当前工作区新增代码尚未提交 / 推送，不能把已有旧 SHA 作为本轮代码的通过凭据。
5. 人工审核并安装 service drop-in、最小 sudoers，保留现有 PUBLIC_BASE_URL。为**首次迁移**单独制定旧服务恢复方案：控制器在没有 immutable current / 健康回退版本时拒绝普通 deploy，不会自动改造旧服务。
6. 真实读写审查和 systemd 迁移批准后，由安装流程建立 `state/migration.json`，字段必须为 `schemaVersion:1`、`legacyPath:"/home/ubuntu/qingsi-games"`、`filesystemReviewed:true`、`sharedContainsExecutableCode:false`、`systemdMigrationApproved:true`、有效 `reviewedAt`，再设置 `productionEnabled:true`。这些是人工审查记录，不能在 WSL 冒充完成。
7. 在维护窗口验证首个 immutable current、实际 MainPID / HTTP / WSS 和所有权限限制，执行 `doctor --resume`，形成首个健康记录；再验证第二个版本的切换与真实回滚，以及重启后 drain 的运维流程。

候选执行的是已获可信 CI 和人工策略批准的代码，不是任意不可信代码的通用沙箱。controller 与服务使用同一受限 UID 以核验 `/proc`；生产 unit 隔离其部署状态和 GitHub 凭据，候选只传递临时凭据。真实主机的 systemd 限制、ARM64 依赖、GitHub API 连通性及资源使用仍需安装阶段验证。本阶段没有引入 Docker、没有 Oracle SSH / 云 API 操作，也没有自动部署 workflow。

完整测试继续由隔离 GitHub runner 执行。虽然第一阶段已对本地生命周期测试分配临时端口，仍不能仅设置 `PORT=3101` 就断言整个套件可在生产安全运行；生产 prepare 只进行上述检查、审计与独立 smoke，不执行完整 `npm test`。

### 10.9 本阶段文件

新增 `scripts/deploy/`：

| 文件 | 用途 |
| --- | --- |
| `deploy.sh`、`cli.js`、`config.js`、`constants.js` | 入口、参数 / 私有配置验证、固定仓库和服务策略 |
| `controller.js` | 准备、批准、切换、回滚、历史、保留策略 |
| `github.js`、`release.js` | 精确 CI 核验、可信 Git 来源、源码 / 依赖封存 |
| `health.js`、`process.js`、`lock-holder.js` | HTTP / WS / systemd / proc 验证、有界子进程、flock |
| `runtime.js`、`fs-safety.js` | 可选私有运行时接口和文件 / 路径校验 |
| `config.example.json`、`40-versioned-release.conf.example`、`sudoers.example` | 第四阶段需人工审核的配置模板 |

新增测试：`tests/deployment-controller.test.js`、`tests/deployment-ci.test.js`、`tests/deployment-runtime.test.js`、`tests/deployment-adapters.test.js`、`tests/helpers/deployment-sandbox.js`。

修改已有文件：`server.js`（可选绑定地址、SHA health、私有管理及新房间接收开关）、`startup-port.js`（监听配置验证）、本文档。游戏规则、`games/`、`bots/`、`public/js/renderers/`、本地服务管理脚本、package / lockfile 和其他 workflow 在第二阶段均未修改。

### 10.10 第二阶段本地验收记录

日期：2026-10-11；WSL Ubuntu，Node.js 24.13.0，非 root 用户。

| 验证 | 结果 |
| --- | --- |
| 部署相关 4 个测试文件 + 现有 startup-port / server-startup / public-origin / internet-security / service-controller 回归 | PASS，77 项，0 失败 / 取消 / 跳过，约 9.1 秒 |
| 最后审批 / 管理状态专项验证 | PASS，4 项，约 1.6 秒；覆盖确认期间 CI 被撤销、正常强制确认、systemd 固定重启和 drain 响应不符 |
| `npm run check` | PASS，一次，检查 219 个 JavaScript 文件；最后两项边界改动由上述专项测试实际加载并执行 |
| `bash -n scripts/deploy/deploy.sh` | PASS |
| 进程清理 | 本轮回归日志记录的 11 个测试 / fixture PID 均已不存在；候选测试同时断言进程退出、socket 和临时 token 清理 |

模拟覆盖了全部 20 类验收：正常 prepare、无效 SHA、CI 未通过 / 不可验证、错误仓库、npm ci / audit 失败、候选 health 失败、端口占用、互斥锁、同版本部署、旧版保存、指针切换、启动超时、错误 SHA、自动回滚、回滚失败、历史、受保护版本清理、未授权操作。额外覆盖旧绿色运行 / rerun 竞态、房间断线宽限期、私有状态不泄露、依赖 / 源码篡改、策略白名单、事务恢复和子进程取消。

GitHub、Git 获取及正式 systemd 操作均使用 mock / sandbox；HTTP、WebSocket、Unix socket、flock 和候选进程使用本机临时目录与隔离端口。没有调用真实 Oracle systemd，没有占用生产 3000。

日志：`/tmp/qingsi-phase2-targeted-regression.log`、`/tmp/qingsi-phase2-approval-regression.log`、`/tmp/qingsi-phase2-check.log`。早期测试暴露的只读候选目录移动问题已修复，并在以上回归中通过。

第二阶段未执行完整 `npm test`、浏览器回归、npm install / ci、真实 registry 审计、远端 Actions、ARM64 打包或真实部署。npm 安装 / 审计失败分支为模拟验证，真实联网审计仍由 CI 及未来 prepare 执行。未运行 Git inspection、Git commit / push、Release；未连接 Oracle、修改 Cloudflare 或安装 systemd 模板。

## 11. 第三阶段：自动检查，人工批准发布

新增 `check-updates`，直接集成现有 `deploy.sh` / `cli.js`，没有另建部署系统。本阶段只提供代码与 timer 模板，**没有在 Oracle 安装或启用定时任务**。

### 11.1 检测流程

1. 获取与 prepare / deploy / rollback 共用的真实 `flock`；冲突即拒绝，不排队反复重试。
2. 使用第二阶段的实际进程 / HTTP / SHA 验证取得当前运行版本；读取房间计数和未结束事务。仅有 current symlink 不能证明正在运行的 SHA。
3. 通过固定 GitHub API 获取仓库身份及 `branches/master` 的完整 SHA。检查仓库名、仓库 URL、默认分支、返回分支名及 commit URL，拒绝其他来源、分支、跳转和不完整 SHA。
4. 远程 SHA 等于已验证的运行 SHA：记录 `up-to-date` / `result:no-update`，CI 标为 `not-checked`，不虚构一次新的 CI 通过结果。
5. 不同：复用第二阶段的精确 SHA CI 核验，包括最新 run / attempt、master push、六个必需 job 及必需步骤；再次读取 master，若查询期间 HEAD 改变则本次失败，等待下次检查，不追逐新提交。
6. 原子写入私有状态并输出 JSON / journal 事件。**只检测，不安装候选，不改变 current，不调用 drain 或任何服务 restart。**

采用官方 [Get a branch API](https://docs.github.com/en/rest/branches/branches#get-a-branch)。API 请求单次最多 10 秒，包含响应体读取，拒绝重定向，响应最多 4 MiB；整个 CLI 检测 60 秒后取消，systemd service 75 秒兜底结束其进程组。没有网络重试循环。

| `status` | 意义 | 检测命令退出码 |
| --- | --- | --- |
| `up-to-date` | 已验证运行 SHA 与本次读到的 master SHA 相同 | 0 |
| `update-available` | 新 master SHA 的全部必需 CI 验证通过，仍需 prepare 和人工发布 | 0 |
| `ci-pending` | 精确 SHA 的 CI 排队、运行中、等待，或尚未出现对应 run | 0 |
| `ci-failed` | 精确 SHA 的最新 CI 失败、取消、超时等 | 0 |
| `check-failed` | API / 网络 / 身份 / 本地状态 / 磁盘等无法确认 | 1；锁冲突 75；取消 130 |

`ci-pending` / `ci-failed` 的退出码 0 只表示检测完成，**不表示该版本可发布**。未定义的 CI 状态、缺失检查、错误 SHA、运行中变化和不完整 API 响应均不能变成 available update。

第四阶段 B 将 `releaseStatus` 明确区分为：运行中 / 排队是 `PENDING`，失败 / 取消是 `REJECTED`，没有该 SHA 的 push run 是 `NO_CI_RUN`（同时保留 `ci.reason:NO_CI_RUN`），API 或验证异常是 `CHECK_FAILED`。只有 CI 通过且候选与运行条件全部满足，才会显示 `READY`；单独 CI 通过仍可能显示 `NEEDS_PREPARE`。这些结果同时用于检测 JSON 和之后的缓存状态查询，不改变部署时重新验证的要求。

### 11.2 检查频率和 timer

提供源码模板：

- `scripts/deploy/qingsi-games-update-check.service`：独立 `Type=oneshot`，只调用 `cli.js check-updates`，`Restart=no`。
- `scripts/deploy/qingsi-games-update-check.timer`：`OnCalendar=hourly`、`RandomizedDelaySec=10m`、`AccuracySec=1m`、`Persistent=true`。

正常每小时检查一次，并错开整点。停机期间错过检查，重新启用 timer 时补触发一次，仍受随机延迟约束；不会把每个错过的小时都排成高速任务。检测失败后等下一次正常定时或人工调用，不自动重试。[Ubuntu 24.04 systemd.timer](https://manpages.ubuntu.com/manpages/noble/man5/systemd.timer.5.html)

这是独立的更新检测 service，不能替换 `qingsi-games.service`。模板设置非 root 用户、`NoNewPrivileges=yes` 和只读文件系统，只允许写 `state/updates` 与现有 lock 文件；不能通过 sudo 重启游戏。它不启动常驻 daemon，也不要求游戏服务随它启动或停止。

### 11.3 GitHub Token

默认示例配置已去掉 `githubTokenFile`，公开读取优先匿名。正常同版本检测约 2 次 API 请求，有更新并核验成功通常约 10 次；分页会增加请求。GitHub 匿名限额按出口 IP 共享，当前为每小时 60 次，需考虑同 IP 的其他工具。[GitHub REST API 限额](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

若真实环境需要更高额度，可在私有 `/etc/qingsi-games/deploy.json` 增加 `githubTokenFile`，指向 root / 部署用户拥有的 `0600` 文件，或经审核的 root:服务组 `0640` 文件；禁止其他用户访问或 group 写入。细粒度 token 限定本仓库，仅需 Metadata / Contents / Actions 读取权限，不授予写入或生产权限。token 不进入候选环境、命令行参数、状态文件或日志。403 / 429 等失败记录为 check-failed，不能借匿名降级重试绕过限额。

### 11.4 手动查询与批准

以下命令均为第四阶段安装后的操作示例，本阶段没有在 Oracle 执行：

```bash
/opt/qingsi-games-deploy/deploy.sh check-updates
/opt/qingsi-games-deploy/deploy.sh status
/opt/qingsi-games-deploy/deploy.sh prepare <FULL_SHA>
/opt/qingsi-games-deploy/deploy.sh status
/opt/qingsi-games-deploy/deploy.sh deploy <FULL_SHA>
```

本阶段**不启用自动预准备**：timer 不 fetch Git 源码、不执行 npm、不创建 candidate。因此重复检测不会累计候选依赖、消耗候选磁盘或占用候选端口。prepare 由人工调用，继续使用第二阶段的独立目录、锁、审计和非 3000 smoke；失败不改变当前服务。未来如增加自动准备，需要单独审核磁盘配额、并发和候选保留策略。

`status` 保留 current / previous、真实健康与事务，并增加：

| 字段 | 数据来源 |
| --- | --- |
| `updates.remoteSha` / `updates.ci` / `updates.checkedAt` | 上次成功持久化的检测快照，标记 `cached:true` |
| `updates.stale` / `matchesCurrent` | 超过 2 小时、当前版本变化或运行身份不可确认时，不再视为当前有效快照 |
| `latestCandidate` / `updates.candidate` | 本地封存 release、准备凭据、只读权限和内容指纹；不凭目录名猜测成功 |
| `latestDeployment` / `latestPreparation` | 有界部署历史中的真实记录；没有记录则 `null` |
| `roomStatus` / `blockingRooms` | 私有管理接口实际计数；不可用为 `UNKNOWN` / `null`，不是 0 |
| `releaseStatus` | 综合本次运行信息、缓存时效、CI 和候选校验结果 |

CI 已通过但未 prepare 时为 `NEEDS_PREPARE`；候选有效、运行健康、房间 EMPTY、无事务且快照有效时才显示 `READY`。活动房间显示 `WAITING_FOR_ROOMS`，查询失败显示 `ROOMS_UNKNOWN`，陈旧快照显示 `CHECK_REQUIRED`。READY 是操作提示，**不是发布批准或未来 CI 状态保证**。

status 不查询网络；要刷新 GitHub 数据须显式执行 check-updates。deploy 始终重新核验来源、完整 SHA、实时 CI、候选、当前进程及房间，要求人工确认，不读取更新缓存作为授权。CI 在检查后被取消、失败或 rerun 时，部署会拒绝。

有房间时可等待其结束后重新检查，或取消部署。手动强制发布仍要求第二阶段的独立损失确认，明确提示可能终止当前对局、断开当前玩家；`--yes` 不替代该确认。断线宽限期房间不会因 0 WebSocket 而消失，UNKNOWN 不能当作 EMPTY。

本方案不采用 push-to-deploy：推送只触发 CI，发布窗口、房间状态及维护决定仍由人工控制。GitHub Actions 不获得 Oracle 凭据，更新检测也没有生产切换职责。

### 11.5 故障、状态文件与日志

状态文件为 `/srv/qingsi-games/state/updates/status.json`，`0600` 原子替换，保存最新结果和最多 24 条检测摘要。读取限 64 KiB，拒绝错误仓库、错误格式及不能对应 SHA 的成功凭据。检测不写入部署历史，避免每小时检查挤掉部署记录。

网络超时、DNS、API 不可用 / 限额、CI 未完成、磁盘不足或检测取消，都保持当前游戏进程与 current 不变。可写状态时写入本次失败，覆盖此前 available 状态；空间耗尽或锁冲突不能写状态时，输出 `persisted:false` 并以非零退出码记录 journal，已有文件保留其原时间戳，不能当作本次成功。临时写入失败会清理自己的临时文件。SIGKILL / 断电不能保证写出失败记录，旧快照会过期，flock 随进程退出释放；不据此自动发布。

```bash
# 查看快照与检查日志，不触发部署
/opt/qingsi-games-deploy/deploy.sh status
journalctl -u qingsi-games-update-check.service -n 100 --no-pager
systemctl list-timers qingsi-games-update-check.timer --no-pager

# 第四阶段已安装后，停用后续自动检查；不会停止游戏
sudo systemctl disable --now qingsi-games-update-check.timer
```

停用 timer 不会中止一个已经开始的 oneshot 检测；它会在自身超时内退出，也不重启游戏。最后一次状态仍可读，但会标为过期。

模块提供可选 `notifyUpdate(result, {signal})` 回调，默认没有通知实现、外部连接或新增依赖。只在持久化成功且可用版本 / 状态变化时调用，1 秒限时、失败仅记录匿名错误码，不影响检测或游戏。它为未来 notifier 保留接口，不是可靠消息队列；本阶段不发送邮件或第三方消息。

### 11.6 Oracle 安装前

沿用第二阶段尚未完成的真实迁移要求。额外需要：

1. 人工审核、更新 `/opt/qingsi-games-deploy` 控制器文件，确认 Node 24 ARM64 与 systemd 配置实际兼容。
2. 安装前创建由非 root 部署用户拥有的全部 controller 状态目录，尤其 `state/updates`（0700）和 `state/deploy.lock`（0600）；模板的精确 ReadWritePaths 要求它们已经存在。
3. 验证已迁移的真实 current、MainPID / proc 可见性、私有 socket / token 和匿名 API 连通性。没有可信运行身份时更新检查会失败，不能冒充 up-to-date。
4. 先人工执行一次检查，验证输出、无服务重启、无 current 变化、日志和房间状态，再人工审核 timer 模板。**本阶段不提供已启用的安装结果。**
5. 确认 journald 的主机日志保留限制与出口 IP 额度；状态历史有界，journal 保留策略由真实主机配置，本轮未更改。

新增文件：`scripts/deploy/updates.js`、两个 update-check systemd 模板、`tests/deployment-updates.test.js`、`tests/helpers/update-github-fixture.js`。修改已有 controller / CLI / 参数解析 / GitHub 客户端与匿名示例配置；修正 `fs-safety.js` 在原子写入失败时清理临时文件；补充并验证人工强制发布会断开当前玩家的明确提示。游戏、bots、renderers、游戏服务源码和现有 CI workflow 在第三阶段未改动。

### 11.7 第三阶段 WSL 验收

日期：2026-10-11；Node.js 24.13.0，非 root 用户。GitHub API / CI 和生产服务适配器均使用 mock，目录为本机临时 sandbox，没有真实 Oracle 调用。

| 验证 | 结果 |
| --- | --- |
| 更新检测与 CI 针对性测试 | PASS，37 项，其中新增更新检测测试 29 项 |
| `npm run check` | PASS，本阶段一次，检查 222 个 JavaScript 文件 |
| `npm test` | PASS，本阶段按明确要求执行一次，548 项，0 失败 / 取消 / 跳过，约 11.4 秒 |
| 最后的强制发布提示专项 | PASS，1 项；确认提示明确包含“断开当前玩家”，实际加载执行最终改动，没有重跑完整套件或语法检查 |
| 进程清理 | 完整测试日志记录的 11 个测试 / fixture PID 均已不存在 |

覆盖全部 16 类要求：同 SHA、新 SHA / CI 通过、CI 失败、Pending、Cancelled、真实客户端超时分支、API 限额、非 master / 错误来源、重复检查、并发互斥、prepare 失败、磁盘不足、取消中断、活动房间、UNKNOWN 房间、检测不重启游戏。额外验证 master 检查期间变化、陈旧 / 损坏缓存、旧绿色 CI 不可复用、缓存 READY 后 deploy 仍重新验证、通知接口失败不影响结果，以及 timer 的检测专用权限和时间参数。

日志：`/tmp/qingsi-phase3-update-tests.log`、`/tmp/qingsi-phase3-check.log`、`/tmp/qingsi-phase3-full-test.log`、`/tmp/qingsi-phase3-room-warning.log`。所有测试命令有外层 timeout，正常完成；没有因超时重试完整测试。

未执行浏览器回归、npm install / ci、真实联网审计、远端 Actions、ARM64 或真实 systemd 定时器验证。没有安装 / 启用 Oracle timer，没有 Deploy、Git commit / push 或 Release，没有修改 Cloudflare、DNS、VCN 或其他系统服务。本阶段没有运行 Git inspection。

## 12. 第四阶段 A：提交准备与权威房间分类

2026-10-11，本地补充发布前验证；生产审计见 [Oracle 迁移前检查](ORACLE_MIGRATION_PREFLIGHT.md)，提交清单与验收见 [第四阶段 A 报告](PHASE4A_RELEASE_READINESS.md)。第四阶段 A 不安装或重启 Oracle 服务，不启用 timer，不切换 current/previous。

### 12.1 私有房间摘要

复用已有 Unix socket 的授权 `GET /v1/status`，由服务进程同步读取自己的 `rooms` Map。没有新增 TCP 端口或公网 Express 管理路由，不信任 X-Forwarded-For 等客户端/代理 IP 头。父目录 0700、socket 0600、私有 token 和定时安全比较共同构成授权边界；同 UID 和 root 属于主机信任范围。

新增摘要字段：

| 字段 | 来自服务端的含义 |
| --- | --- |
| `waitingRooms` | 外层房间 phase 为 lobby/ready，仍有保留的人类座位 |
| `activeGames` | 外层 phase=playing，且没有服务器已使用的终局标志 |
| `completedRooms` | 外层 phase=playing，state.phase=over 或 state.winner 非 null/undefined；winner=0、-1 也有效 |
| `expiredRooms` | Map 中仍保留、但人类座位 Map 已空的房间；不是已经删除房间的历史累计数 |
| `unknownRooms` | 无法识别的外层 phase、损坏状态或座位结构 |
| `totalRooms` / `blockingRooms` | 当前 Map 的房间数；所有保留房间均保护，不只保护 activeGames |
| `playingRooms` | 私有管理摘要兼容字段，现在与 activeGames 相同 |
| `roomStatus` | EMPTY、ACTIVE 或 UNKNOWN；ACTIVE 表示仍有保留房间，详细类型看上述计数 |

已删除房间不再计入摘要。正常服务在最后一个人类座位移除时立即 destroyRoom，所以 expiredRooms 通常为 0。断线 30 秒和主动离开 5 分钟的保留座位仍受保护，不以连接数为零或墙钟超时替代服务器清理结果。多轮游戏的 round_end / round_result 或部分 winners[] 不单独认定整局结束。所有保留房间都阻止普通发布，因此显示分类不承担放行安全的唯一责任。

未初始化、读取失败或畸形状态返回 UNKNOWN；完全不可读时计数为 null，不伪造 0。控制器交叉核对字段、非负整数、分类之和、总数与 blockingRooms；缺字段、矛盾摘要、错误 SHA、401/403、超时或 socket 不可用均不得作为 EMPTY。UNKNOWN 阻止无人值守发布和 READY；既有强制发布仍须独立终端确认并明确接受断开玩家，`--yes` 无法替代。没有新增复杂排空流程。

摘要不包含房间 ID、玩家身份、手牌、房间密钥、恢复 token 或原始 state。其代码仅在显式配置部署集成时加载，LAN/Android/Windows 默认启动不要求私有配置。

### 12.2 NO_CI_RUN 的边界

官方 GitHub API 实测：CI workflow 存在且 active，历史运行数为 0，旧 master SHA 的运行数为 0。已提交的旧 workflow 本来就包含 master/main push 和 PR 触发，不能把这个现象归因于分支拼写。匿名只读 API 无法证明历史为何缺失或仓库级 Actions 权限如何设置；不能编造已修复的远端运行。

新版 Node 18/20/22/24 检查、独立 Node 24 audit 和 Deployment gate 已在本地实现并验证，但尚未提交/推送。须在用户确认后按明确清单提交并推送；如 Actions 页面要求启用仓库/fork workflow，需用户操作。之后查询新完整 SHA 的实际 push run、最新 attempt、六个必需 job 与步骤，取得真实成功结果。旧 SHA、其他 workflow 的绿色结果、取消或查询失败均不能替代。

### 12.3 首次迁移仍须独立批准

本地新增统计不会改变仍在运行的旧生产进程；旧版生产房间仍为 UNKNOWN。不得为获得计数而开启公网 debug，或声称这一步已经解决首次切换的空房证明。旧服务缺乏私有计数与 drain，需要单独解决首次维护窗口的可信空房/禁止新加入条件，然后才可审批生产迁移。

新候选仍隔离为独立目录和 node_modules，默认 127.0.0.1:3101；smoke 本身也拒绝 3000，冲突立即失败，不停止端口拥有者、不选择其他端口。模拟测试继续覆盖精确 SHA/CI、systemd 配置身份、当前进程身份、失败自动恢复、明确的回滚失败、历史、锁和 Cloudflare 操作边界。
