# P3：Claude hooks 覆盖与验收依据

2026-10-30；实现分支 `feat/claude-hooks-coverage`，基于 main `48078ae`。
这是草稿实现的合成验证记录，未合并、未发布、未替换正式 App，未在本机启动真实 Claude 对话或安装用户 hooks。

## 官方依据和版本范围

字段依据为 [Claude hooks 文档](https://code.claude.com/docs/en/hooks)，版本依据为
[官方 CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)。
查询日期为 2026-10-30，本机只读版本查询结果为 Claude Code 2.1.310、Codex CLI 0.164.0。

| 事件／能力 | 已核实版本 | 安装处理 |
| --- | --- | --- |
| PreCompact | 1.0.48 明确新增 | 到达此版本才补装 |
| TaskCompleted | 2.1.33 明确新增 | 只记观察，不交付、不验收 |
| PostCompact | 2.1.76 明确新增 | 只记观察 |
| CwdChanged | 2.1.83 明确新增 | 优先使用 new_cwd，保留明确关联 |
| PermissionDenied | 2.1.89 明确新增 | 结构化保留工具名，不作为工具执行失败 |
| Notification 的 agent_completed | 2.1.198 明确新增 | 复用 Notification，不增加配置事件名 |
| quota_auto_resume_fired / stale / disabled | 本机官方 2.1.310 发布包可证实；首发版本未知 | 复用 Notification，不编造安装版本门 |
| Claude command hook async | 2.1.23 修复记录已证明支持；首发未知 | 以此为保守启用下界 |
| Codex command hook async | 当前官方文档支持，本轮核实 CLI 0.164.0；首发未知 | 以 0.164.0 为保守启用下界 |

原有事件的版本门：SessionStart 1.0.62、UserPromptSubmit 1.0.54、Stop/SubagentStop 1.0.41、
SubagentStart 2.0.43、SessionEnd 1.0.85、PermissionRequest 2.0.45、StopFailure 2.1.78，来自官方 changelog。
PreToolUse/PostToolUse/Notification 以官方 npm 发布包 1.0.85 的 `sdk.d.ts` 类型为保守下界，未声称首发版本。
PostToolUseFailure 首发无法确认，以本机官方 2.1.310 包为保守下界。过旧版本可能少装这个原有事件，已有条目始终不动。
无法识别 Claude 版本时不新增任何条目；无法核实 Codex 异步能力时保持同步。

[OpenAI hooks 文档](https://learn.chatgpt.com/docs/hooks) 明确支持 `async: true`，同时规定 **SessionEnd 始终同步**。
因此 Codex SessionEnd 与 SessionStart、UserPromptSubmit、PermissionRequest 一起保持同步。

额度通知在公开 hooks 参考中没有独立 schema；本轮证据仅覆盖官方 2.1.310 发布包中的确切类型和受控文案：

| 通知 | 包中含义 | SS 状态 |
| --- | --- | --- |
| fired | 限额恢复，已经继续 | running |
| stale | 限额重置，需要按 Enter 继续 | idle，显示“等待继续” |
| disabled | 已关闭自动继续 | 只记原因，状态不变 |
| 未知 quota_auto_resume_* | 没有可证实语义 | 只记受控 unknown 原因，状态不变 |

不保存这些通知的正文；不故意耗尽额度来触发通知。

## 验收矩阵

| 任务书标准 | 结论 | 证据 |
| --- | --- | --- |
| 旧 12 项＋其他工具保持原样，补装 5 项 | 满足（合成测试） | `internal/install/coverage_test.go`；复装幂等、卸载恢复、再安装 |
| 新事件和 Notification 规范化 | 满足（合成测试） | `internal/event/perception_hooks_test.go`、共享 JSON 展示合同 |
| TaskCompleted/agent_completed 不推进工作状态 | 满足（合成测试） | `internal/core/perception_hooks_test.go`；无新增审批、运行或交付 |
| CwdChanged 未关联改项目，明确关联保留并提示 | 满足（合成测试）；真实界面待验 | core 合成两个仓库＋前端提示测试 |
| 版本门与跳过原因 | 满足（合成测试） | 旧版／未知版本安全计划、设置缺项和读失败展示 |
| Go 普通／race／vet | 满足 | 产品实现完整运行 617 通过、0 失败、2 跳过；新增手动 fixture 后 server 普通／race 各 57 通过、1 默认跳过 |
| MacBook 真实 Claude：cd、压缩、自动拒绝、无明显变慢 | 无法验证 | 本机未启动真实 Claude；见下方隔离步骤 |
| 设置入口及会话提示真实 GUI | 无法验证 | 浏览器工具被 Work 设置禁用；56 个前端测试文件、429 项测试通过，构建通过 |

新元信息不会把 idle/ended 回放成 running；活动时间与状态时间分开计算。旧结束事件即使超出活跃窗口仍保留状态。
设置接口仅面板鉴权可读，不返回命令、配置路径或第三方条目；版本命令最长 2 秒、缓存 1 分钟，设置刷新立即重读条目。
设置查询不持有 Core 锁；慢查询不阻塞快照。GUI 进程若 PATH 中没有客户端，则显示版本未知而不猜测安装状态。

## 与任务书的差异

- 不能把全部 quota_auto_resume_* 记为“等待额度恢复”：已恢复的 fired 应为 running，stale 需要输入，disabled／未知只记录；否则会制造错误阻塞。
- 升级旧配置只给新补条目加 async，旧 12 项完全保留。全新安装才会把全部已核实支持的非阻塞条目设为异步。
- Codex SessionEnd 按官方约束同步。未知的首发版本用已核实保守下界，未伪称最低首发版本。
- P1 尚未在此分支合并，保留 hook 渠道 TODO；时间和原有 provider 来源已保留。
- 没有新增自动安装或升级修改 hooks 的入口；只读设置卡片提供缺项说明。

## MacBook 人工验收步骤（尚未执行）

仅在合成仓库使用 `ClaudeProjectTarget`，不执行全局 `steward install`，不用正式 App、正式数据库或完整 `steward serve`。
以下示例要求已核对外置盘挂载身份，已在这个 PR 分支，Go/npm 使用本机既有包装器。测试目录必须全新、空且不在已有仓库内。

终端 A，先构建，再创建单独的空验收目录：

```sh
P3_BUILD=$(mktemp -d /Volumes/LocalDevData/Codex/Scratch/ss-p3-build-XXXXXX)
~/.local/share/mac-ssd-dev/bin/go build -o "$P3_BUILD/steward" ./cmd/steward
~/.local/share/mac-ssd-dev/bin/go build -o "$P3_BUILD/steward-hook" ./cmd/steward-hook
P3_ROOT=$(mktemp -d /Volumes/LocalDevData/Codex/Scratch/ss-p3-acceptance-XXXXXX)
printf '%s\n%s\n' "$P3_BUILD" "$P3_ROOT"
SS_P3_MANUAL_TEST_DIR="$P3_ROOT" SS_P3_MANUAL_TEST_LISTEN=127.0.0.1:24873 \
  ~/.local/share/mac-ssd-dev/bin/go test ./internal/server \
  -run '^TestP3ManualAcceptanceFixture$' -count=1 -timeout=30m -v
```

此手动测试默认跳过，显式启用后最多运行 25 分钟，只监听独立 loopback 端口；会拒绝正式端口、非空目录、已有仓库和真实应用目录。
它只构造 Core、隔离数据库和实际 HTTP Handler，不执行历史扫描、后台采集、通知或多设备推送。
生成两个合成仓库、P3-1/P3-2 工作项和标记 `.ss-p3-acceptance.json`；凭据只留在测试数据目录的 0600 文件中，不打印 token。
hook 输入的 cwd、project_path、new_cwd 均须解析到测试目录内；没有任何可核验目录的输入被拒绝。

终端 B，先手动把上一终端打印的两个**目录路径**赋给同名变量，再执行：

```sh
STEWARD_HOME="$P3_ROOT/ss-home" "$P3_BUILD/steward" install claude --project "$P3_ROOT/repo-a"
STEWARD_HOME="$P3_ROOT/ss-home" "$P3_BUILD/steward" install claude --project "$P3_ROOT/repo-b"
cd "$P3_ROOT/repo-a"
STEWARD_HOME="$P3_ROOT/ss-home" claude --setting-sources project,local
```

`--setting-sources project,local` 排除用户级设置，依据 [官方 CLI 参考](https://code.claude.com/docs/en/cli-reference)。
如果因此没有认证或既有自定义接口环境，**停止该步并记“未验证”**；不改账号、代理、全局配置，不把凭据贴进报告。
不更改 HOME/CODEX_HOME，不开启任何新的权限绕过，不在正式项目触发 hook。

使用独立／隐私浏览器会话手动访问 `http://127.0.0.1:24873/login?t=<测试 panel.token>`。
测试 token 由验收者仅在本机从 `$P3_ROOT/ss-home/panel.token` 取用；不运行 `steward open` 唤起正式 App，不在聊天、PR、截图或报告中保留 token／带 token 的链接。
127.0.0.1 不同端口的同名 cookie 可能互相覆盖，因此不要复用正式浏览器登录会话。
先确认页面只有合成工作项；若出现真实项目名，立即停止并核对地址。

观察并记录：

1. 未绑定会话切换到 repo-b，项目归属随之改变；再在页面把另一合成会话明确关联 P3-1 后切换目录，关联保持且出现提示。
2. 只在合成会话做 `/compact`，观察 PreCompact/PostCompact，不把压缩当成交付。
3. 仅在该会话本来具备自动模式时触发一次无害拒绝，确认“被自动拒绝：工具名”且没有生成权限审批。无法触发则记未验证，不放宽全局权限。
4. 有条件触发 Claude 自己的待办完成／后台完成通知，确认没有变成 SS 待验收或完成。无法触发则记未验证。
5. 记录可观察延迟；未测量就不要声称“没有明显变慢”。额度分支目前只有合成测试依据，不故意耗尽额度。

结束时先退出这次合成 Claude 会话，再对终端 A 的测试进程 Ctrl+C（或等 25 分钟自动退出）。仅卸载两个测试目录：

```sh
STEWARD_HOME="$P3_ROOT/ss-home" "$P3_BUILD/steward" uninstall claude --project "$P3_ROOT/repo-a"
STEWARD_HOME="$P3_ROOT/ss-home" "$P3_BUILD/steward" uninstall claude --project "$P3_ROOT/repo-b"
```

核对标记文件、测试端口已退出，保留或按既有工作树／归档规则处理整个测试目录。不得以此步骤清理真实应用数据。
回报只含版本、事件名、观察结果、是否触发成功、耗时和不含 token 的截图；本说明不构成已完成 MacBook 实测。
