# Session Steward

给 Claude Code 和 Codex 用的本机进展与验收台。多个 Agent 同时在多个项目里干活时，Session Steward 让你在一分钟左右看懂：每个项目做到哪了、卡在哪、下一步谁来做、哪些事在等你。

[完整使用手册](docs/GUIDE.zh-CN.md) · [安全策略](SECURITY.md) · MIT 许可证

> **状态：早期。** 作者在 macOS 上日常使用。界面目前只有中文。Linux 可以构建并运行核心服务，但测试较少；Windows 能编译，尚未测试。

## 能做什么

- **按项目看简报，而不只是会话列表。** Claude Code 和 Codex 的会话按项目和工作项归并。每个项目显示阶段、一句话结论、卡点、下一步和负责人。
- **一个队列放所有需要你处理的事。** 工具权限请求、Agent 的明确提问、等待批准的合并、等待验收的交付。
- **在面板里批准或拒绝工具权限。** 每个决定都绑定到具体请求（工具、参数、工作目录），迟到的决定不会作用到另一个请求上。面板不在线时，Agent 会回到自己的原生确认。
- **“Agent 说做完了”不等于“已验收”。** 进展和交付由 Agent 自己回报，只有你能把工作标记为已验收。Stop、沉默或会话空闲都不算完成。
- **可选功能**，未配置时不生效：在独立 worktree + tmux 中运行的托管会话和只读实时终端、带检查门的本地合并、跨 Agent 交接包、按工作项统计 token 用量、macOS 通知、经你自己的 HTTPS 代理提供的远程只读访问。

## 工作方式

```
Claude Code / Codex hooks ──> steward-hook ──> steward serve (127.0.0.1:7788) ──> Web 面板
                                   │                 │
                                   └ 本地暂存         └ SQLite（~/.steward）
```

`steward` 是一个 Go 单二进制，内嵌 Web 界面。`steward install` 会为 Claude Code 和 Codex 追加 hook 条目，调用 `steward-hook` 把事件转发给本机服务。Agent 也可以调用 `steward-hook report` / `ask` / `deliver` 回报进展。

## 安装

需要 Go 1.26 及以上。构建好的 Web 界面已提交在仓库里，只有修改前端时才需要 Node。

```sh
git clone https://github.com/xoqiu09/session-steward
cd session-steward
go build -o bin/ ./cmd/...
```

`bin/steward` 和 `bin/steward-hook` 要放在同一个目录。

## 快速开始

```sh
bin/steward serve            # 在 127.0.0.1:7788 启动服务
bin/steward install          # 为 Claude Code 和 Codex 添加 hooks（或：install claude|codex）
bin/steward open             # 打印登录链接并打开面板
```

- `install` 只在 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 中追加自己的条目（标记为 `--mark=steward-v1`），会先备份原文件，其他工具的 hooks 保持不变。`bin/steward uninstall` 只恢复或移除这些条目。
- Codex 需要你在 Codex 里信任新的 hooks 后才会运行。`bin/steward status` 会列出还没完成的项。
- 之后新会话就会出现在面板里。要生成项目简报，Agent 需要用 `steward-hook begin` / `report` / `deliver` 回报；hooks 会给每个会话一段可直接复制的提示。详见[使用手册](docs/GUIDE.zh-CN.md)。

### 用演示数据试一试

使用独立的数据目录，不会碰 `~/.steward`、`~/.claude` 或 `~/.codex`。需要 `python3`、`curl` 和 `git`。

```sh
export STEWARD_HOME=/tmp/steward-demo && mkdir -p "$STEWARD_HOME"
echo '{"listen":"127.0.0.1:7799","history_days":0}' > "$STEWARD_HOME/config.json"
bin/steward serve        # 终端 1
scripts/demo.sh          # 终端 2，使用同一个 STEWARD_HOME
bin/steward open
```

## 隐私与安全

- 在本机运行，只监听回环地址，`Host` 不是回环地址的请求会被拒绝。没有遥测。
- 两个随机 token，权限 `0600`：一个给 hooks（只能访问 `/hook/*`），一个给面板（只能访问 `/api/*`，使用 HttpOnly、SameSite=Strict 的 cookie，写操作还要检查 Origin 和 `X-Steward`）。
- 存储的是脱敏后的事件元数据（事件类型、工具名、指纹、截断并遮蔽密钥的预览），不存原始载荷或完整对话。
- 只有你配置了才会访问网络：`ntfy_url`、`summary_command` 或 `remote_hosts`。远程访问是只读的，使用单独的 token，只应在私有网络内提供，例如 `tailscale serve`。不要用 `tailscale funnel` 或公网代理暴露它。

发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 开发

```sh
make build     # 在 web/ 里 npm ci && npm run build，再 go build
make test      # go test -race ./... 和 vitest
make notifier  # 仅 macOS：带深链跳转的通知助手应用
```

目录：`cmd/steward`（服务与命令行）、`cmd/steward-hook`（hook 适配器）、`internal/`（核心状态机、存储、服务端、安装、通知）、`web/`（React + Vite）、`native/macos`（Swift 通知助手）。

## 许可证

[MIT](LICENSE)
