# QingSi Games：第四阶段 A 发布准备报告

日期：2026-10-11；环境：WSL Ubuntu，非 root 用户 polarstern，Node.js 24。范围为开发代码整理、房间统计和模拟验证；没有操作 Oracle 生产环境，没有提交、暂存、推送或创建 Release。

## 1. 应提交文件清单

清点时索引没有暂存文件，没有跟踪文件删除。以下 **44 个路径**是本轮及前三阶段正式成果；提交时逐路径核对，不使用 `git add .`。共享文件在多个阶段得到完善，下表归属表示主要来源，不表示可以拆开漏交依赖。

### 第一阶段：CI、版本与本地测试隔离（11）

```text
.github/workflows/ci.yml
package.json
scripts/check-syntax.js
scripts/run-tests.js
scripts/ci-gate.js
scripts/release-info.js
scripts/service-port.js
scripts/qingsi-games-service.js
tests/ci-tools.test.js
tests/release-info.test.js
tests/service-controller.test.js
```

`scripts/service-port.js` 是已修改服务管理器和生命周期测试的必需依赖，之前范围清单遗漏了它；它不是临时脚本。正式端口保持 3000，仅 NODE_ENV=test 且显式 QINGSI_GAMES_TEST_PORT 时使用隔离端口。

### 第二阶段：部署控制器、服务器集成与模拟测试（23）

```text
server.js
startup-port.js
scripts/deploy/constants.js
scripts/deploy/config.js
scripts/deploy/cli.js
scripts/deploy/controller.js
scripts/deploy/deploy.sh
scripts/deploy/fs-safety.js
scripts/deploy/github.js
scripts/deploy/health.js
scripts/deploy/lock-holder.js
scripts/deploy/process.js
scripts/deploy/release.js
scripts/deploy/runtime.js
scripts/deploy/config.example.json
scripts/deploy/40-versioned-release.conf.example
scripts/deploy/sudoers.example
tests/deployment-ci.test.js
tests/deployment-controller.test.js
tests/deployment-runtime.test.js
tests/deployment-adapters.test.js
tests/helpers/deployment-sandbox.js
docs/DEPLOYMENT.md
```

### 第三阶段：更新检测（5）

```text
scripts/deploy/updates.js
scripts/deploy/qingsi-games-update-check.service
scripts/deploy/qingsi-games-update-check.timer
tests/deployment-updates.test.js
tests/helpers/update-github-fixture.js
```

### 第四阶段 A 与生产审计记录（5）

```text
.gitignore
scripts/deploy/room-status.js
tests/deployment-rooms.test.js
docs/ORACLE_MIGRATION_PREFLIGHT.md
docs/PHASE4A_RELEASE_READINESS.md
```

合计 44 个独立路径：9 个已跟踪文件改动、35 个新增文件。完整清单应作为一个相互依赖的交付集合审核。

## 2. 排除项与敏感信息检查

- `android-startup.log`、所有运行/部署 `*.log`、node_modules、test-results、coverage、dist、临时 sandbox 和 `/tmp/qingsi-phase4a-*` 日志不提交。
- AGENTS.md、本地 agent/规划目录及仓库既有隐藏开发内容保留原忽略规则，不删除或覆盖。
- `.gitignore` 补充 `.env.*`、私钥/证书容器、`*.token`、私有 deploy.json、secrets、部署状态和迁移备份目录；保留 `.env.example` 与公开 config.example.json。忽略规则不能保护已跟踪或被强制暂存的秘密，提交仍须逐文件审核。
- 审核范围内未发现真实私钥、GitHub/Cloudflare token、密码或生产私有配置。扫描唯一命中是测试中明确的假 token 字符串，用于验证错误不泄漏凭据。未读取 SSH 私钥、生产 token 或被排除凭据文件内容。
- 文档中的生产主机地址、完整 SHA、服务路径和配置摘要是运维元数据；不包含密钥材料。所有 example 配置均为模板，CI 策略摘要保留待人工审核的占位值。

## 3. 基础安全复核

- 固定 GitHub 仓库、master 来源、完整 SHA、最新 CI run/attempt；强制六个 job 和关键步骤通过。没有 bypass、pull_request_target、生产凭据或自动部署。
- 私有配置检查所有者/权限/硬链接/符号链接；发布目录验证 Git blob、依赖指纹、只读权限与独立准备凭据。
- 子进程不使用 shell 拼接，命令/网络有限时；Git 源固定，候选独立安装，不继承生产 token 环境。
- 候选 smoke 自身补充 3000 禁止检查；3101 冲突不停止监听者、不自动换端口。
- systemd 适配器只接受审核后的精确服务、用户、目录、启动参数、KillMode；唯一重启目标为 qingsi-games.service，Cloudflare 不在操作范围。
- 锁、事务、历史、只删除受控子目录、回滚失败明确错误均保留；从未安装 sudoers 或向 Oracle 扩权。
- 候选运行的是经审核与 CI 认可的代码，并非对任意恶意源码的通用隔离沙箱。真实 systemd 权限和 ARM64 尚待后续安装验证。

## 4. GitHub Actions 结果与 NO_CI_RUN

官方 API 查询时间：2026-10-11T13:48:47Z。

```json
{
  "repository": "Polaris-deutsch/qingsi-games",
  "branch": "master",
  "headSha": "0d4e35233adfc097e6c2a317b07e85650f72b2ea",
  "workflowId": 374627213,
  "workflowState": "active",
  "workflowPath": ".github/workflows/ci.yml",
  "exactShaRunCount": 0,
  "totalWorkflowRunCount": 0
}
```

直接原因是精确 SHA 没有任何可查询 CI run，整个 workflow 也无历史 run。旧触发器已包含 master，不能错误声称分支不匹配；仓库级 Actions 设置/历史原因未获管理权限证明。新版开发成果仍未提交推送，所以它没有自己的提交 SHA 或远端运行结果。

本地现有 CI 已包含 npm ci、syntax、test、独立 Node 24 production audit、Deployment gate 和完整 SHA 元数据；保留兼容性矩阵。audit 漏洞/网络故障均保持非零失败，取消/排队/缺 job/错 SHA/重跑变化均不能通过。GitHub YAML 解析与结构检查通过；actionlint 未安装，没有为它新增依赖。Android/Release YAML 解析通过，其 workflow 未修改。

用户确认后才可提交、推送，再检查新 SHA 的真实 Actions 成功结果。需要在 GitHub 人工确认 Actions 可运行、启用必要 fork workflow（如页面要求），并按需设置分支保护必需检查；未假装这些设置已完成。

## 5. 房间判断与发布保护

复用授权 Unix socket，由同一游戏服务读取真实 rooms Map；waiting、active、completed、expired、unknown 的具体定义和字段见 DEPLOYMENT 第 12 节。摘要仅包含数量，不公开隐藏状态、身份、房间密钥或恢复 token。授权不依赖代理 IP 头，公网管理路径不存在。

UNKNOWN、缺字段、矛盾计数、超时、授权失败和错误运行 SHA 都不能成为 EMPTY。等待、活动、结束和过期但未删除的房间均保护，普通 `--yes` 发布不能继续；更新检查也不会显示 READY。断线保留座位不因 0 WS 而放行。

真实隔离五子棋测试覆盖等待 → 开始 → 服务端判定终局 → 返回大厅；客户端在 move 中伪造 winner/phase 不能改变管理计数。没有修改游戏规则、bots 或 renderers。

## 6. 验收记录

| 验证 | 结果 |
| --- | --- |
| 部署 / CI / 更新 / 房间针对性测试 | 97 PASS，0 fail/cancel/skip，约 10.0 秒 |
| 最终真实房间流程和授权专项 | 2 PASS，0 fail/cancel/skip，约 3.0 秒；包含新增真实终局流程及已补充的授权用例 |
| `npm run check` | 本阶段一次，退出 0，224 个 JavaScript 文件通过 |
| `npm test` | 本阶段按明确要求执行一次，退出 0，565 PASS，0 fail/cancel/skip，约 11.0 秒；包含最终全部代码和测试 |
| `npm audit --omit=dev --json` | 本阶段一次，实际联网、退出 0，0 漏洞，stderr 为空 |
| GitHub workflow YAML | 三份 YAML 解析无重复键；CI 触发器、Node 矩阵、最小权限、关键命令、gate 依赖结构检查通过 |
| Bash 语法 | deploy.sh 与现有本地 service.sh 的 bash -n 通过 |
| `.gitignore` | 13 个实际规则检查通过，秘密/日志排除、公开 example 保留 |
| 提交清单 | 44 个独立路径全部存在，无重复；敏感内容扫描仅命中已审核假 token fixture |
| 本地 3000 环境 | 验证前无监听者，未发生环境端口失败；生命周期仍用隔离端口，3101 冲突用例按预期拒绝 |
| 进程清理 | 本阶段日志记录的 19 个测试/fixture PID 均已不存在；没有停止其他 Node 服务 |

命令都有外层 timeout：targeted 35 秒、房间专项 20 秒、check 30 秒、完整测试 45 秒、audit 25 秒；网络请求另有内部限时。所有命令正常完成，没有超时重试、全量测试重跑或后台长驻服务。

日志仅保留在本机 `/tmp`，不提交：

```text
/tmp/qingsi-phase4a-targeted.log
/tmp/qingsi-phase4a-room-integration.log
/tmp/qingsi-phase4a-check.log
/tmp/qingsi-phase4a-full-test.log
/tmp/qingsi-phase4a-audit.json
/tmp/qingsi-phase4a-audit.stderr
```

最终完整套件已覆盖候选目录/依赖隔离、3000 拒绝和 3101 冲突、精确 SHA/CI、失败与取消/超时/限额、systemd 身份和唯一重启目标、进程/cwd/监听/运行 SHA、自动恢复、明确回滚失败及事务保留、历史轮转、真实 flock、活动/UNKNOWN 房间保护、更新检查不重启游戏。生产服务适配器与 GitHub 成功/失败场景为 mock；实际 HTTP/WS/Unix socket 和进程身份测试仅用本地隔离 fixture。

未运行浏览器回归、Android/Windows 完整构建、新的 Node 18/20/22 本机矩阵、Oracle ARM64 candidate prepare 或真实部署/回滚。没有再次安装依赖，没有 git status/diff 验收命令。未运行的生产验证不能用上述 WSL 成功替代。

## 7. 尚未完成与人工动作

1. **提交、推送及精确 SHA 的远端 CI 尚未完成。** 需要用户确认；本地验证不能代替远端通过。
2. **旧生产服务房间仍为 UNKNOWN。** 新代码没有热更新现有进程。必须单独解决首次切换前可信空房与阻止新加入的条件，不能开启公网 debug 或冒充空房。当前不具备直接正式切换条件。
3. 后续生产备份、专用用户/目录权限、控制器安装、私有配置、最小重启授权及 systemd sandbox 均需逐步审批。
4. 首个 current 的 bootstrap 与原 unit/drop-in 恢复流程仍是首次安装步骤；没有 previous 前不能宣称控制器自动回滚已经可用。
5. 实际 ARM64 prepare、生产切换、真实回滚、timer 执行日志和轻量持续监控尚未完成。模拟成功不等于这些生产步骤已验证。
6. 手机/电脑真机游戏验收尚未重做。本阶段没有浏览器回归，也没有 Oracle 故障注入、Cloudflare 变更或真实回滚。

第四阶段 A 完成后停止，不能把本报告作为第四阶段 B 的执行授权。
