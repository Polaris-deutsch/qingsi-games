# C-2 修复：Git Blob 导出与源码完整性

日期：2026-10-12（Europe/Berlin）。本任务仅在 WSL 开发和验证；未连接或修改 Oracle，未提交、推送。新 SHA 和远端 CI 尚待用户批准提交推送后取得。

## 1. 已复现的根因

固定提交为 `c018a7ae3f80073036a5970e0645e2be856b0ea4`。用该提交的 ls-tree、cat-file、.gitattributes 与 archive 原始字节交叉核对：**总计 354 个文件，348 个完全一致，6 个仅发生 LF → CRLF 转换**。全部文件集合完整，无其他内容差异。

这 6 个文件均为 mode=100644，路径匹配 `scripts/windows/*.cmd text eol=crlf` 或 `scripts/windows/*.ps1 text eol=crlf`。Git Blob 中没有 CRLF，归档转换后的字节已不再具有原始 Blob ID，因此原 verifySource 返回 SOURCE_CHANGED 是正确的安全拒绝；缺陷在于导出方式和校验要求不一致。

| 路径（相对于 scripts/windows/） | 原始 Git Blob SHA-1 | 归档 CRLF 数 |
| --- | --- | --- |
| Install-QingSi-Games-Shortcuts.ps1 | 7fd73a6dee69266f3bfa6495dffb42858c08e231 | 55 |
| QingSi-Games-Control.cmd | 2aa32e00a2a215f53507b02d3b766f4adfa3e061 | 39 |
| Restart-QingSi-Games.cmd | a23f6b7be3a94d9ecc021c24fc645b6985a48817 | 3 |
| Start-QingSi-Games.cmd | e7c44377247c482613f4a1c45614f6ff0dd36010 | 3 |
| Status-QingSi-Games.cmd | 5cfc34e7c063571e19184f141f740e1ed01a75a1 | 3 |
| Stop-QingSi-Games.cmd | 4a70200b0d047a2c1667a87ccce69c2d2b87caa6 | 3 |

诊断中的换行比较没有用于部署放行。没有 Windows 文件免检清单，也没有对源码统一归一化。

## 2. 方案比较和选择

| 方案 | 安全边界 | 复杂度与维护 | 兼容性 |
| --- | --- | --- | --- |
| 直接读取 Commit Tree 的原始 Blob（采用） | 所有文件必须逐字节匹配批准提交中的 Blob，不接受属性导致的内容变化；路径和模式取自 Tree | 实现有界二进制批协议、排他写入、逐 Blob 哈希及进程取消；无需解释属性规则 | 适用于 Oracle Linux 快照；二进制、BOM、原始 LF/CRLF 均保留。正常 checkout 和 Windows 包装脚本不变 |
| 属性感知导出与校验 | 必须证明每次转换恰好等同于批准属性下的 Git 行为，不能将任意可归一化文本视为合法 | 需处理嵌套属性、配置、编码、ident、export-subst/export-ignore、过滤器及其执行边界，较难维持单一可信内容基准 | 可保留工作树转换后的表现，但更依赖 Git 配置与转换环境 |

Git 官方说明：普通 cat-file 输出原始对象内容，`--filters` 才启用工作树过滤和换行转换；批模式按输入顺序输出身份、类型、字节长度和内容。[git-cat-file](https://git-scm.com/docs/git-cat-file)。checkout 的 eol=crlf 行为见 [gitattributes](https://git-scm.com/docs/gitattributes)；archive 还会遵循 export-ignore / export-subst，见 [git-archive](https://git-scm.com/docs/git-archive)。

## 3. 当前实现的保护

1. 现有官方 master 来源、完整 Commit SHA、祖先关系和实时 GitHub CI 校验保留。
2. materialize 重新确认对象为 commit、读取完整 NUL 结束的 Tree，并与先前来源证明逐项比较。拒绝被改写的内存证明、空/截断 Tree、重复路径及文件/目录冲突。
3. 只允许 `100644 blob` / `100755 blob`、完整小写 Blob ID 和安全路径；拒绝 symlink、submodule、路径穿越、保留根文件和不支持的文件名。禁用 replace objects 和 hooks。
4. 目标必须是 `state/candidates/<完整SHA>.<临时后缀>` 的空、当前用户拥有的目录；路径不得包含 symlink。父目录以私有模式建立，文件采用 O_EXCL / O_NOFOLLOW 创建，不覆盖已有文件。
5. cat-file 只接收 Tree 中的 Blob ID，不接收路径表达式；不用 filters/textconv，不经过工作树或 tar。字节按二进制流写入，逐个重新计算 Git Blob SHA-1。
6. 严格检查每个响应的身份、类型、十进制长度、内容、分隔符和完整 EOF；错误/额外/缺失对象、截断、非零退出、超时与取消均失败。单文件最多 128 MiB，源码总量最多 512 MiB，源文件及目录合计最多 100000 条目。
7. Git 导出最多 60 秒，纳入现有 CLI 取消信号。只终止自己创建的 Git 进程组并等待退出；清理失败报告准确 PID，不影响其他进程。
8. 导出后再次 verifySource，仍严格核对字节、文件集合和可执行位，增加缺失文件、硬链接及大小的拒绝。安装和 smoke 后的再次源码校验与最终 Release Seal / prepared attestation 保留。

最终只读 seal 的 SHA-256 包含实际源码和依赖，不用 Blob SHA-1 代替 Release Seal。部署用户及 root 仍属于主机信任边界，不将该机制描述为同 UID 对抗性沙箱。

## 4. Windows 和 CI

`.gitattributes`、6 个 Windows 文件、Windows 打包配置、Android 和 Release workflow 均不修改。回归通过真实 Git checkout 验证 cmd/ps1 仍为 CRLF，且 BOM 和脚本内容保留。Linux 候选是原始 Git 快照，不把它当作经过 Windows checkout 的分发包。

现有 `npm test` 自动发现 tests/*.test.js，因此新测试已纳入四个 Node.js 矩阵；无需改变 CI YAML、必需检查名称或 CI Policy 摘要。不接受本地成功代替新 SHA 的真实远端 CI。

## 5. 验证结果

WSL Node.js v24.13.0；不使用 Oracle 生产环境。所有命令设定总超时，正常完成，没有挂起、跳过或取消的测试。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| npm run check（一次） | 226 个 JavaScript 文件通过 | /tmp/qingsi-crlf-check-20261012.log |
| npm test（一次） | 595 PASS，0 FAIL / SKIP / CANCEL；约 12.2 秒 | /tmp/qingsi-crlf-full-test-20261012.log |
| npm audit --omit=dev（一次） | 退出 0，所有严重程度漏洞均为 0；官方 registry，fetch timeout=15 秒、无重试 | /tmp/qingsi-crlf-audit-20261012.json |
| 新 Blob/CRLF 回归及现有 adapters | 31 PASS，其中新增源码测试 27 项 | /tmp/qingsi-crlf-targeted-20261012.log |
| 全部 deployment 专项 | 127 PASS，0 FAIL / SKIP / CANCEL；约 11.7 秒 | /tmp/qingsi-crlf-deployment-20261012.log |
| 实际问题提交的完整源码导出 | 原提交 354 个文件全部通过；6 个 Windows 文件的原始 Blob、属性及 checkout CRLF 对应关系通过；二次校验及只读 SHA-256 指纹通过 | /tmp/qingsi-crlf-real-commit-verified-20261012.log |

新增覆盖：LF、原始 CRLF、eol=crlf、UTF-8 BOM、非 UTF-8 二进制、空/重复 Blob、export-subst/export-ignore 不影响原始 Tree 快照；内容篡改、额外文件/目录、缺失、添加/移除/部分移除可执行位、软/硬链接、越界目标、错误 SHA/Tree 类型、伪造来源证明、路径穿越、重复/冲突/截断 Tree、错误/截断/额外批响应、类型/身份/内容不符、大小上限、真实导出取消及其 Git 进程退出。合法的事后 CRLF 改写仍返回 SOURCE_CHANGED。

完整实仓验证只从本地固定 SHA 的 Git 对象建立临时 bare fixture，模拟远程 fetch 的传输边界；不把开发工作树当作部署源码、不调用真实 GitHub CI、不安装依赖或启动游戏。第一次辅助命令在 bare 仓库调用 check-attr 时漏指定隔离 work tree，退出 1；补全辅助命令的 work tree 后验证通过，没有为此改动产品代码或重跑完整 npm test。临时验证目录均在 finally 清除。

未运行：Windows 实机执行、Windows EXE / Android APK 完整打包、浏览器回归、新 SHA 的远端 CI、Oracle prepare。Windows 的本轮结论限于实际 Git checkout 字节/BOM、未改动打包配置和既有包装脚本测试通过，不能代替 Windows 实机或完整打包验收。

本轮文件清单：scripts/deploy/release.js、scripts/deploy/git-blobs.js（新增）、tests/deployment-adapters.test.js、tests/deployment-git-source.test.js（新增）、docs/DEPLOYMENT.md、本文档（新增）。原有三个未提交的 Oracle 阶段计划/报告文档保留，未纳入本次修复改写。

## 6. Oracle 后续门槛

本轮不制定或执行具体远端更新命令。必须先经用户确认提交推送，取得**包含本修复的新完整 SHA** 的真实 CI / Deployment gate 成功结果，才能制定 Oracle 更新计划，并再次取得更新控制器的单独批准。

届时计划必须重新只读检查已安装控制器与生产身份，备份原控制器，逐文件比较新旧版本（包括新增 git-blobs.js），使用 root 管理的文件安全更新；保留原文件及恢复办法，不放宽权限。deploy.json 的 productionEnabled 继续为 false，重新核验新 SHA 的 CI Policy 摘要，审查失败缓存/日志但不随意清理，然后由非 root 部署用户调用现有 prepare 新 SHA。

旧 c018a7a 的成功 CI 不适用于本修复。Oracle 原生产房间仍只能沿用上次观测的 UNKNOWN，不能冒充本轮查询或解除保护；不得切换 current、执行 deploy/rollback、启用 timer 或操作两个生产服务。C-1 备份与 C-2 失败报告保持原始历史记录。
