# K2：桌面 App 接手点验

状态：待做，最先做。需要用户坐在 Mac Studio 前。
分支：`docs/dispatch-k2-evidence`（只放证据说明，不改代码）。

## 目标

回答一个问题：由 `codex app-server` 发起的会话，官方 Codex 桌面 App 能不能用 `codex://threads/<会话号>` 打开，看到之前的历史，并在同一条会话里接着写。用户已定“必须能回桌面 App”，所以这是派活台“回电脑接着做”的前提。

## 步骤

1. 在 Studio 上新建一个合成项目（空 git 仓库，一个 README）。
2. 用用户自己的 Codex 环境（不设 CODEX_HOME）启动 `codex app-server`，在该项目里开一条会话，让它做一件小事（例如在 README 里加一行），记下会话号。命令行参数关掉 hooks 和插件，不改 Codex 配置。
3. 结束本轮，关闭 app-server 连接。
4. 用户在 Studio 上执行 `open "codex://threads/<会话号>"`，看桌面 App：
   - 打开的是不是这条会话（会话号、项目一致）；
   - 能不能看到第 2 步的历史；
   - 发一句新消息，回复是否接着之前的上下文，且仍是同一会话号（看 `~/.codex/sessions` 里的会话文件是否追加，而不是新建）。
5. 反过来再试一次：桌面 App 里写完一轮后，再用 app-server `thread/resume` 同一会话号，确认两边不打架。

## 不做

- 不改 Codex 的配置、登录、模型设置；不改 SS 的 hooks。
- 不把“App 被唤起了”当成接手成功。
- 不提交会话号、会话文件或截图里的对话内容；截图只保留能证明会话号一致的部分。

## 验收标准

每一项写“通过 / 不通过 / 无法验证”：

1. App 打开的是同一会话号。
2. App 里能看到 app-server 那一轮的历史。
3. 在 App 里继续后，仍是同一会话号、同一份会话记录。
4. App 写完后 app-server 能恢复同一会话。

1～3 全部通过，K1 才能做“回电脑接着做”按钮。任何一项不通过就停下，回报给用户决定，不改成只给命令行。

## 交付

一份证据说明（Codex CLI 和桌面 App 的版本、每一项结果、用户是否在场确认），放 `docs/dispatch/evidence/k2/README.zh-CN.md`，开草稿 PR。
