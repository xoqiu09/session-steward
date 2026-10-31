# K2 证据：桌面 App 接手 app-server 会话

点验日期：2026-10-31，在 Mac Studio 上进行，用户在场。任务书见草稿 PR #50 的 `docs/dispatch/tasks/K2-desktop-handoff.zh-CN.md`。

**结论：允许 K1 做“回电脑接着做”按钮。** 验收标准 1～3 全部通过。另外发现一条 K1 必须遵守的约束：桌面 App 开着某条会话时，app-server 不能同时接手它（见第 4 节）。

## 1. 环境

| 项目 | 版本 |
| --- | --- |
| Codex 命令行 | `codex-cli 0.164.0` |
| Codex 桌面 App | `/Applications/ChatGPT.app`，包标识 `com.openai.codex`，版本 26.1027.30824，构建号 22943 |
| `codex://` 链接的默认处理程序 | `/Applications/ChatGPT.app`（用 NSWorkspace 查询确认） |

- 用用户自己的 Codex 环境（没有设 `CODEX_HOME`），启动命令为 `codex --disable hooks --disable plugins --disable apps --disable chronicle app-server --stdio`。没有改 Codex 配置、登录和模型设置，没有改 SS 的 hooks，也没有动正式运行的 steward。
- 项目是两个新建的合成 git 仓库（`proj-A`、`proj-B`），各只有一个 README，放在临时目录里。
- 点验脚本放在临时目录，不进仓库；协议参照 `internal/nativecontrol/rpc.go`、`manager.go`，没有改动这两个文件。

## 2. 两条会话

- **A**：完全按任务书的参数调用 `thread/start`。
- **B**：调用 `thread/start` 时多带 `dynamicTools`，定义照 `manager.go` 里的 `ss_deliver`。

两条会话号前 4 位都是 `01a1`，完整会话号和对话内容都不入库。

## 3. 逐项结果

“用户”指用户本人在桌面 App 里亲眼确认；“文件”指在 `~/.codex/sessions` 和合成项目里核对。

| 项 | A | B | 依据 |
| --- | --- | --- | --- |
| ① 用 `codex://threads/<会话号>` 打开的是同一条会话，项目对得上 | 通过 | 通过 | 用户：App 里分别是 proj-A、proj-B 的会话 |
| ② 能看到 app-server 第一轮的历史 | 通过 | 通过 | 用户：截图里能看到第一轮编辑 README 的记录 |
| ③ 在 App 里发第二轮，回复接着上下文，仍是同一会话号、同一份记录 | 通过 | 通过 | 用户：回复接着上下文。文件：每个会话号只有一个会话文件，第二轮追加在原文件后面，没有出现新的会话号；README 多了“第二轮” |
| ④ App 写完后，app-server `thread/resume` 同一会话号再发第三轮 | 通过（App 退出后） | 通过（App 退出后） | 文件：`thread/resume` 返回的会话号与原来相同，第三轮完成，追加在同一会话文件里；README 多了“第三轮”。App 开着时的结果见第 4 节 |
| B 注册 `ss_deliver` 是否影响 App 打开或继续 | — | 没有影响 | ①～④ 与 A 相同。这一轮模型没有调用 `ss_deliver`，所以工具调用本身在 App 里的表现**没有验证** |

另外附带确认了一点：在桌面 App 里继续这两条会话后，SS 自己的 Codex hook 照常回报，两条会话登记到了 SS，分别归到 proj-A 和 proj-B 下面，状态正确。SS 把这两条会话的客户端记成了 `unknown`，没有认出是桌面 App。这属于次要问题，留给 K1 或后续处理。

## 4. 遇到的报错和约束

1. **App 开着会话时，app-server 不能接手。** 桌面 App 打开着这两条会话时，调用 `thread/resume` 会返回 `-32600`，原因是 `thread-store conflict: thread … already has an active writer`。这时会话文件和工作区都没有被改动，两边不会同时写。用户完全退出 App 后，同样的 `thread/resume` 就成功了。
   - **对 K1 的要求**：桌面 App 开着某条会话时，派活台不能再接手它。“从桌面交回派活台”要先让 App 放开这条会话，至少要提示用户关掉它或退出 App；遇到 `active writer` 错误时，要明确告诉用户原因，不能静默失败，也不能新开一条会话来代替。是否只关掉这条会话、不退出整个 App 就能放开，**没有验证**。
2. **全局说明触发审批。** 用户的 Codex 全局说明要求开工前先检查外置盘，模型会先请求运行 `diskutil info`。最初脚本一律回应取消，前三次尝试因此中断，留下了三条半截的合成会话。之后只放行合成项目里的只读查询和改 README 的命令，其余一律取消，就都跑通了。
   - **对 K1 的要求**：用真实 Codex 环境时，用户的全局说明同样生效。派活台的审批不能简单地一律拒绝，否则任务会在第一步就中断。
3. 点验留下的痕迹：桌面 App 侧边栏多了 5 条合成会话（A、B 各一条，另有三条中断的），SS 里多了 proj-A、proj-B 两个合成项目，都需要用户自己归档。

## 5. 没有验证的

- `ss_deliver` 被模型真正调用时，桌面 App 里怎么显示这次工具调用、之后能不能照常继续（这次模型没有调用它）。
- 只在 App 里关掉这条会话、不退出整个 App，能不能放开 `active writer`。
- 一轮还在跑的时候，用 `codex://threads/…` 打开会怎样（这次都是在一轮结束后才打开的）。
