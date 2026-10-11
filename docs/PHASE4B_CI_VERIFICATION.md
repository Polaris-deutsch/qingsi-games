# QingSi Games 第四阶段 B：本地提交验证与推送审批

日期：2026-10-11；环境：WSL Ubuntu，Node.js 24.13.0。本文记录本地验证证据和推送前边界；没有执行 GitHub 推送，也没有操作 Oracle。第四阶段 B 尚未完成，须获准推送后验证目标完整 SHA 的真实远端 CI。

## 1. 提交范围

采用一个完整提交：CI、控制器、私有房间状态、测试和模板相互依赖，避免产生缺失模块或缺失发布门槛的中间提交。共 45 个文件；package-lock.json、Android / Release workflow、games/、bots/、renderers/、LICENSE、NOTICE 没有修改。

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
scripts/deploy/updates.js
scripts/deploy/qingsi-games-update-check.service
scripts/deploy/qingsi-games-update-check.timer
tests/deployment-updates.test.js
tests/helpers/update-github-fixture.js
.gitignore
scripts/deploy/room-status.js
tests/deployment-rooms.test.js
docs/ORACLE_MIGRATION_PREFLIGHT.md
docs/PHASE4A_RELEASE_READINESS.md
docs/PHASE4B_CI_VERIFICATION.md
```

## 2. 安全审查

- 逐路径提交，禁止 git add .。正式成果中没有发现真实私钥、Tunnel / API token、密码、生产私有配置或运行日志；测试包含用于泄漏检测的假 token。
- 私钥未读取。私有 deploy.json、凭据、日志、socket、PID、state/releases/shared、current/previous、生成的 release-info / attestation 均受忽略规则保护；暂存清单仍必须逐项复核，不能仅依赖 gitignore。
- 管理接口只监听 Unix socket。父目录必须为当前服务用户所有且 0700，socket 为 0600，并校验私有 Bearer token；不依赖代理 IP 头。root 和同一服务用户属于本地信任边界。
- 房间摘要来自服务端 rooms Map，只有聚合数量，不返回房间 ID、玩家身份、手牌或恢复 token。初始化、查询、授权或摘要验证失败为 UNKNOWN；UNKNOWN 和任何保留房间阻止普通部署。
- 切换前先 drain，再读取权威摘要；已有等待房间可开始游戏但仍阻止发布。EMPTY drain 后 create/join 均受阻；一次 status 的 EMPTY 不提供永久授权。强制发布需独立终端确认房间损失。本系统不提供零中断或内存对局恢复。
- 当前 lockfile 沿用原版本：79 个 resolved URL 位于 registry.npmmirror.com，23 个位于 registry.npmjs.org，均使用 HTTPS 并有 integrity。npm ci 已通过，但本次未迁移锁文件来源；GitHub Runner 的真实下载仍须由远端 CI 证明。

## 3. 本轮最终验证

| 项目 | 结果 |
| --- | --- |
| npm ci | PASS，安装 102 个包，约 0.9 秒 |
| npm run check | PASS，224 个 JS 文件 |
| npm test | PASS，567 项，0 fail/cancel/skip，约 11.1 秒 |
| 部署专项模拟 | PASS，100 项，0 fail/cancel/skip，约 10.6 秒；与完整套件重叠，不累加 |
| npm audit --omit=dev --json | 实际联网 PASS，0 漏洞，无 stderr |
| Bash 语法 | deploy.sh、本地服务脚本 bash -n PASS |
| GitHub Actions YAML | CI / Release / Android 三份解析及重复键检查 PASS；CI 触发器、矩阵、关键命令、最小权限及 gate 依赖检查 PASS |
| actionlint | 未安装；没有为它添加依赖，未执行 |
| 忽略规则 | 24 个秘密 / 状态排除及公开模板保留用例 PASS；无已跟踪 socket/PID/key/pem/token 或发布运行目录 |
| 进程清理 | 本轮测试日志中记录的 17 个 PID 均不存在；未结束未知或其他 Node 进程 |

所有主要验证命令本轮各执行一次并有外层 timeout，没有超时；只安装本地依赖，没有启动长驻 dev server。未运行浏览器、Android / Windows 构建、本机其他 Node 版本矩阵或 Oracle 故障注入。一个日志汇总脚本曾因预期数量与 Node 24 输出格式不符而断言失败，修正读取方式后确认实际测试通过，没有重跑测试。一次附加锁文件来源检查发现既有镜像 URL，已据实记录，没有改动依赖。

日志不提交，保留于本机：

```text
/tmp/qingsi-phase4b-ci.log
/tmp/qingsi-phase4b-check.log
/tmp/qingsi-phase4b-targeted.log
/tmp/qingsi-phase4b-full-test.log
/tmp/qingsi-phase4b-audit.json
/tmp/qingsi-phase4b-audit.stderr
```

## 4. GitHub 与更新检查证据

2026-10-11T14:44:28Z 匿名官方 API 只读查询：master 仍为 `0d4e35233adfc097e6c2a317b07e85650f72b2ea`；CI workflow ID 374627213，路径 `.github/workflows/ci.yml`，状态 active；验证器对该 SHA 返回 `CI_UNVERIFIED` / `NO_CI_RUN`。workflow active 不等于已证明仓库 Actions 可执行，也不等于已有绿色运行。

本地更新模拟验证 READY（CI 通过、候选已准备且运行和房间条件满足）、PENDING、REJECTED（含取消）、NO_CI_RUN、CHECK_FAILED。ci-pending / ci-failed 保留原检测类别，同时 releaseStatus 明确区分上述结果；NO_CI_RUN 原因保留在 ci.reason。任何失败均不重启服务，实际部署再次查询 CI，不能使用缓存批准。

## 5. 推送批准后的核验

1. 在用户明确批准前只完成本地提交并报告完整 SHA。获准后核对远程 master，正常快进推送，不强推、不覆盖历史。
2. 查找此完整 SHA 的 master push CI，核对固定仓库 / workflow、最新 run 和 attempt。四个 Checks (Node.js 18/20/22/24)、Security audit (Node.js 24)、Deployment gate 及关键步骤均须完成且 success。
3. 安全审计漏洞或网络失败均让 job 和 gate 失败；运行中、取消、跳过、缺失和旧 SHA 成功不算通过。不得修改 NO_CI_RUN 的拒绝逻辑来放行。
4. 若无触发，在仓库 Actions 页查看 fork workflow 启用提示，并检查 Settings → Actions → General。需要用户操作时列出真实原因；不假装分支保护或 Actions 设置已开启。
5. CI 真正通过后，用本地验证器只读查询同一完整 SHA，记录 run URL / attempt / 六个 job 结果。不得把模拟 READY 冒充 Oracle 已安装后的实际 READY。

## 6. 仍存在的迁移阻碍

- 新提交尚未获准推送、远端新 SHA 的 CI 未运行。第四阶段 B 未完成。
- 旧生产服务缺少私有管理及 drain，房间 UNKNOWN，首次切换前可信空房和阻止新加入方案仍需另行审批。
- 发布目录、专用用户、权限、私有配置、控制器和 timer 尚未安装；ARM64 prepare、首次 bootstrap、真实回滚和持续监控尚未完成。
- 后续每个生产影响步骤仍需明确批准；本阶段不进行迁移、systemd 修改、GameNest 重启、Cloudflare 修改或真实回滚。
