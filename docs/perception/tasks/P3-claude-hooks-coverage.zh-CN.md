# P3：补装选定的 Claude hooks

- 执行：Codex 实现；Claude 在 MacBook Pro 上用真实的 Claude Code 验证（Claude Code 跑在那台电脑上）
- 分支：`feat/claude-hooks-coverage`，从最新 main 开
- 已决定：补装的事件见设计文档“已决定”第 3 条，下面的范围和它一致

## 目标

更及时、更准确地知道 Claude Code 会话发生了什么，特别是：被自动模式拒绝、切换了工作目录、压缩上下文、Claude 自己回报完成、额度用完在等待。只用来告诉 SS 发生了什么的事件改成异步执行，不拖慢 Claude。

## 背景

- Claude 现在装了 12 种事件（`internal/install/install.go` 的 `ClaudeTarget`）。官方文档（https://code.claude.com/docs/en/hooks）列了 33 种。
- `classify`（`internal/event/normalize.go`）已经认识 `PreCompact`/`PostCompact`，但是没有安装。
- `SessionStart` 和首次 `UserPromptSubmit` 会往 stdout 输出回报说明，`PermissionRequest` 要等面板的决定。这三种必须保持同步执行。

## 范围

1. **新增安装的事件**：
   - `PermissionDenied`：自动模式拒绝了一次工具调用。记一条信号，会话状态不变；在会话详情里显示“被自动拒绝：工具名”。
   - `CwdChanged`：工作目录变了。更新会话的 cwd、worktree 和分支，重新判断属于哪个项目。已经明确关联到某个工作项的，不自动改关联，只给出提示。
   - `PreCompact`、`PostCompact`：只记信号。
   - `TaskCompleted`：Claude 自己的待办项完成了。只记信号，**不能**当成工作项完成，也不能当成交付。
   - `Notification` 新增识别 `agent_completed`（只记信号，不等于交付）和 `quota_auto_resume_*`（会话状态写成“等待额度恢复”，原因写进 `state_reason`）。
2. **异步**：除了 `SessionStart`、`UserPromptSubmit`、`PermissionRequest` 以外，其余事件在写入设置时加 `"async": true`。先确认 Codex 的 hooks 配置支不支持同样的字段；不支持就只改 Claude 的。
3. **版本兼容**：安装前检查本机 Claude Code 的版本。版本太旧、不认识某个事件时，只安装它认识的事件，并在 `steward install` 的输出里说明跳过了哪些。具体从哪个版本开始支持，以官方文档或 changelog 为准，查不到就写在回报里。
4. **已安装的用户怎么拿到新事件**：`steward install` 重复执行时，只补上缺少的条目，已有条目和其他工具的 hooks 一律不动。面板“设置”里显示“hooks 有更新，重新运行 steward install 即可”。App 升级流程（T0）照旧不擅自改 hooks。
5. **信号**：新事件全部带 `hook` 渠道（P1 合并以后才有渠道字段；如果 P3 先做，就留一个 TODO，等 P1 合并后补上）。

## 不做

- 不装 `PostToolBatch`、`MessageDisplay`：触发太频繁，收益小。
- 不装 `WorktreeCreate`、`WorktreeRemove`：装上以后会替代 Claude 默认的 Git 行为，风险太大。
- 不读 `transcript_path` 指向的文件内容（那是 P4 的事）。
- 不改 Codex 的事件列表，除非为了第 2 条的异步支持。

## 设计约束

- `steward install` 只动自己的条目。重复安装、卸载、再安装都要有测试，并确认其他工具的条目原样保留。
- 新事件的规范化同样不保存原始 payload，不保存对话正文。
- 测试用合成的 hook 输入，不依赖真实的 Claude。

## 验收标准

1. 安装测试：从“旧版 12 种事件的设置文件，再加上另一个工具的 hook”开始，执行安装以后，新事件补上了，旧条目和另一个工具的 hook 都没变；需要异步的事件带 `"async": true`。
2. 规范化测试：每种新事件、每种新的 Notification 类型都有合成输入，并映射到预期的种类和会话状态。
3. `TaskCompleted` 和 `agent_completed` 不会让工作项进入待验收或已完成。要有测试。
4. `CwdChanged` 到另一个仓库时，未关联的会话改挂到新项目；已关联的保持原关联，并出现提示。
5. 版本太旧时跳过不认识的事件，输出里写明原因。
6. `go test ./...`、`go test -race ./...` 通过。
7. **真实验证（由 Claude 在 MacBook Pro 上做）**：用项目级安装（`ClaudeProjectTarget`，只写某个测试目录的 `.claude/settings.local.json`），在一个合成的测试仓库里触发 `cd`、压缩上下文、自动模式拒绝，确认面板上有对应信号，并且 Claude 没有明显变慢。

## 回报

按 [README](README.zh-CN.md) 里的格式。“需要用户决定的事”里列出：查不到最低支持版本的事件，以及 Codex 是否支持异步。
