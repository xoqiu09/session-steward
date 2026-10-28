# Session Steward

给 Claude Code 和 Codex 用的本机进展与验收台。好几个 Agent 同时在好几个项目里干活时，它把这些工作画成一座小镇，让你一眼看出：每个项目做到哪了、卡在哪、下一步谁来做、哪些事在等你。

[完整使用手册](docs/GUIDE.zh-CN.md) · [安全策略](SECURITY.md) · MIT 许可证 · [English summary](#english-summary)

> **状态：早期试用版，欢迎体验和反馈。** 作者每天在 macOS 上使用。界面目前只有中文。App 只支持 macOS；Linux 能跑核心服务，测试较少；Windows 能编译，没有测试过。

![小镇世界地图：每栋房子是一个项目，相关的项目聚成村庄，中央广场上是告示栏（等你决定）和验收台（演示数据）](docs/images/town.jpg)

## 它能帮你做什么

- **一张地图看全部工作。** 房子是项目，小人是正在干活的会话，熟了的菜是等你验收的交付，广场上的告示栏是等你决定的事。地图可以拖动、缩放，点房子能走进项目内部。
- **一个队列放所有等你的事。** 工具权限请求、Agent 的明确提问、等待批准的合并、等待验收的交付，都集中在面板右侧。
- **在面板里批准或拒绝工具权限。** 每个决定绑定到具体的请求（工具、参数、目录），不会误用到别的请求上。面板不在线时，Agent 回到自己原来的确认方式。
- **“Agent 说做完了”不等于“已验收”。** 进展和交付由 Agent 自己回报，只有你能把工作标为已验收。会话停止、沉默或空闲都不算完成。
- **按项目看简报。** 每个项目显示阶段、一句话结论、卡点、下一步和负责人，而不是一长串会话。
- **多台电脑合成一座小镇（可选）。** 几台电脑的工作可以汇总到一台“中心机”，在任何一台上切到“全部设备”查看。

![项目简报：按项目列出进展、卡点和下一步，右侧是需要你处理的请求（演示数据）](docs/images/brief.jpg)

## 快速开始

数据只保存在你自己电脑的 `~/.steward`，仓库里不带任何人的工作记录。所以刚装好时小镇是空的，这是正常的：可以先[用演示数据看一眼](#先用演示数据看一眼)，或者装好 hooks 后让 Agent 干活。

### 方式一：下载 App（macOS，推荐）

1. 打开 [Releases](https://github.com/xoqiu09/session-steward/releases)，下载对应芯片的 `Session-Steward_<版本>_macOS_arm64.app.zip`（Apple 芯片）或 `…_amd64.app.zip`（Intel）。解压后把 **Session Steward** 拖进“应用程序”。还没有发布版本时，用方式二自己打包。
2. **第一次打开**：这个版本没有 Apple 签名和公证，macOS 会拦一下。
   - 在“应用程序”里**右键 → 打开 → 打开**。
   - 如果没有“打开”按钮（较新的 macOS）：先双击一次，再到“系统设置 → 隐私与安全性”，在下方找到 Session Steward，点“仍要打开”。
   - 熟悉终端的话，也可以运行 `xattr -dr com.apple.quarantine "/Applications/Session Steward.app"`。
3. 按引导点“**安装 hooks 并开始**”。引导会先说明要改哪两个文件，改之前会备份，只添加 Steward 自己的条目。
4. 新开一个 Claude Code 或 Codex 会话，让它干点活，小镇里就会出现房子和小人。用 Codex 的话，要先在 Codex 里信任新加的 hooks。

### 方式二：从源码打包 App（macOS）

需要 `git`、Go 1.26.5 及以上，以及 Xcode 命令行工具（`xcode-select --install`）。前端已经构建好放在仓库里，不需要 Node。

```sh
git clone https://github.com/xoqiu09/session-steward
cd session-steward
sh scripts/build-app.sh
```

产物是 `dist-app/Session Steward.app`。把它拖进“应用程序”，然后按方式一的第 2～4 步操作。

### 方式三：命令行版（macOS / Linux）

不想用 App，或者在 Linux 上：

```sh
git clone https://github.com/xoqiu09/session-steward
cd session-steward
go build -ldflags "-X main.BuildCommit=$(git describe --always --dirty)" -o bin/ ./cmd/...
bin/steward install            # 给 Claude Code 和 Codex 加 hooks
bin/steward service install    # 仅 macOS：登录后自动在后台运行
bin/steward open               # 打印登录链接并打开面板
```

- Linux 上没有 `service install`，用 `bin/steward serve` 在前台运行，或者自己写 systemd 用户服务。
- 仓库放在一个长期不动的位置，不要放在“文稿”“桌面”“下载”里，否则后台服务首次启动可能被系统卡住。
- 有发布版本后，macOS 也可以一行安装预编译的命令行版：`curl -fsSL https://raw.githubusercontent.com/xoqiu09/session-steward/main/scripts/install.sh | sh -s -- --setup`。脚本只下载 Release 里的文件并校验 SHA256，每一步都会先问你。

## 先用演示数据看一眼

用一个单独的数据目录和端口，不会碰 `~/.steward`、`~/.claude` 或 `~/.codex`。需要先按方式三构建出 `bin/`，还需要 `python3`、`curl` 和 `git`。

```sh
export STEWARD_HOME=/tmp/steward-demo && mkdir -p "$STEWARD_HOME"
echo '{"listen":"127.0.0.1:7799","history_days":0}' > "$STEWARD_HOME/config.json"
bin/steward serve        # 终端 1，保持运行
```

```sh
export STEWARD_HOME=/tmp/steward-demo
scripts/demo.sh          # 终端 2：灌入 3 个虚构项目
bin/steward open         # 打印登录链接并打开面板，顶部点“小镇”
```

看完在终端 1 按 Ctrl+C 停掉，删掉 `/tmp/steward-demo` 即可。

## 怎么用

### 跑通第一个真实任务

1. 装好 hooks 后，新开一个 Claude Code 或 Codex 会话，像平时一样给它任务。
2. hooks 会在会话开始时给 Agent 一段说明，Agent 会自己登记任务、回报进展、在做完时交付。小镇里出现一栋房子，门口有正在干活的小人。
3. Agent 需要权限时，告示栏上会多一张卡片，面板右侧的“关注队列”里可以直接允许或拒绝。
4. Agent 交付后，菜地里的菜会“熟了”。点“收菜”逐个查看交付了什么、在哪个分支、验收标准是什么，满意就“验收通过”，不满意就“退回修改”。

更细的说明和常见问题见[使用手册](docs/GUIDE.zh-CN.md#先用一个真实任务验证价值)。

### 小镇

App 打开就是小镇的世界地图。

| 地图上的东西 | 意思 |
| --- | --- |
| 房子 | 一个项目。越大说明未完成的工作和最近的活动越多：小木屋 → 房子 → 工坊 → 大楼 |
| 村庄 | 最近一起开发、互相有关的几个项目，围着一口井 |
| 野外的小屋 | 还有未完成的工作、但 7 天没动静的项目 |
| 中央广场 | 全镇合计、你的验收台、告示栏（等你决定的事） |
| 小人 | 一个会话，衣服颜色表示是哪个 Agent；同一个 Agent 的两个会话是两个人 |
| 熟了的菜 | 一个等你验收的交付 |
| 红白路障、退件筐、小纸箱 | 有受阻的工作项、最近失败的运行、正在进行的运行 |
| 灰色、云朵 | 状态待更新：很久没有新事件，不当作还在工作 |

常用操作：

- **拖动和缩放**：拖动地图移动，滚轮缩放；右上角“全景”看全部，“广场”回到中间，右下角小地图点哪飞到哪。
- **点房子**：走进项目内部，工作台是工作项，墙上白板是这个项目等你决定的事；按 Esc 或“← 回到世界”出来。
- **点小人**：打开会话详情，“复制恢复命令”粘到终端就能接着那个会话干。
- **收菜 N**：逐个打开等你验收的交付。
- **按 Agent 看**：名牌改成每个 Agent 有几个会话，点图例只突出一个。
- **回放**：选一天、拖到某个时刻，看当时小镇的样子。
- **怎么看**：打开小镇里的完整说明。第一次来时按钮旁有提示。

小镇只用来看：它不批准、不验收、不派单，这些都在面板里做。连接中断时画面会变灰，并写明停在哪一刻。

其他视图：

- **工作室**：App 菜单“文件 → 打开工作室”（⌘2），一个桌面上的微缩工作室，适合常开在副屏上，项目多时自动翻页。
- **完整面板**：菜单栏小房子图标 → “打开完整面板”，里面有项目简报、画布、列表和历史。
- 在浏览器里：`http://127.0.0.1:7788/?view=town&world=1` 是世界地图，`?kiosk=1` 是全屏的工作室，`?kiosk=1&world=1` 是全屏的世界地图。

### App 菜单

菜单栏的小房子图标显示“等你决定”的数量，有新的审批时会弹系统通知。菜单里可以：打开小镇、工作室或完整面板；开关“开机时启动”；安装或卸载 hooks；“退出并停止采集”。关掉窗口不会停止采集。

已经装过命令行版时，App 会问你“接管”还是“共用”：接管会移除命令行版的开机服务，由 App 在后台运行；共用则命令行服务照常运行，App 只当窗口用。同一份数据不会有两个服务同时在跑。

### 多台电脑（可选，默认关闭）

选一台常开的电脑当中心机，其他电脑每 15 秒把摘要推给它，任何一台的小镇顶部都可以切到“全部设备”。摘要只含项目名、工作项标题和状态、会话的 Agent 和状态、审批的种类，不含对话、命令和目录路径。别的电脑上的工作只能看，审批和验收要回到那台电脑上做。需要 Tailscale，配置步骤见[使用手册](docs/GUIDE.zh-CN.md#在其他设备上查看小镇只读)。

在其他设备上只读查看面板也是同样的方式：用 `tailscale serve` 只在你的 tailnet 内转发，**不要**用 `tailscale funnel` 或公网代理暴露面板。

## 更新与卸载

- **App**：下载新版本替换“应用程序”里的旧版；从源码打包的，`git pull --ff-only` 后重新运行 `sh scripts/build-app.sh` 再替换。
- **命令行版**：`git pull --ff-only`，重新构建，再运行 `bin/steward install` 和 `bin/steward service restart`。`install` 会把新的 `steward-hook` 复制到 `~/.steward/bin/`，不重新运行的话 hooks 还在用旧版本。
- **卸载 App**：菜单栏选“卸载 hooks…”，Claude Code / Codex 的配置会恢复原样；再“退出并停止采集”，把 App 拖进废纸篓。
- **卸载命令行版**：`bin/steward service uninstall && bin/steward uninstall`。
- 数据在 `~/.steward`，确定不要了再自己删除。

## 已知限制

- App 没有 Apple 签名和公证，第一次打开要手动放行。
- 界面只有中文。App 只支持 macOS；Linux 只测过核心服务；Windows 没有测试过。
- Agent 要按 hooks 给的说明登记和回报，项目简报和小镇才有内容；没有 Agent 在干活时小镇会比较空。
- 小镇只画有未完成工作项或近期会话的项目，其他项目不会出现在地图上（在完整面板里仍然能看到）。
- 没装 tmux 时，“在面板里直接开托管会话”不可用，其他功能照常。

## 隐私与安全

- 只在本机运行，只监听回环地址，`Host` 不是回环地址的请求会被拒绝。没有遥测。
- 两个随机 token，权限 `0600`：一个给 hooks（只能访问 `/hook/*`），一个给面板（只能访问 `/api/*`，使用 HttpOnly、SameSite=Strict 的 cookie，写操作还要检查 Origin 和 `X-Steward`）。`steward open` 打印的登录链接含面板 token，不要发给别人。
- 保存的是脱敏后的事件元数据（事件类型、工具名、指纹、截断并遮蔽密钥的预览），不保存原始载荷或完整对话。
- 只有你配置了才会访问网络：`ntfy_url`、`summary_command`、`remote_hosts` 或多设备的 `hub`。远程查看是只读的，使用单独的 token。

发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 Issue。

## 反馈

欢迎在 [Issues](https://github.com/xoqiu09/session-steward/issues) 里反馈。为了能复现，请附上：

- 版本：App 菜单“关于 Session Steward”或 `bin/steward version`，以及你用的 Claude Code / Codex 客户端和版本；
- 发生了什么、你期望的是什么；
- 截图（小镇、项目简报或详情）。截图前确认里面没有不想公开的项目名或内容，**不要贴登录链接、token、`~/.steward` 下的文件或对话全文**。

## 开发

```sh
make build     # 在 web/ 里 npm ci && npm run build，再 go build（注入版本号）
make test      # go test -race ./... 和 web 下的 npm test
make notifier  # 仅 macOS：带深链跳转的通知助手
sh scripts/build-app.sh   # 仅 macOS：打包 App 到 dist-app/
```

- 改 Go：`go test ./...`，改状态机或并发相关时再跑 `go test -race ./...`。
- 改前端：在 `web/` 里 `npm test` 和 `npm run build`，并提交重新构建的 `web/dist`。
- 发布：推送 `v*` 标签后，GitHub Actions 会构建 arm64 / Intel 两种 App 和命令行包，建一个草稿 Release，检查后手动发布。
- 测试和演示只用合成数据；开发约定见 [AGENTS.md](AGENTS.md)。

目录：`cmd/steward`（服务与命令行）、`cmd/steward-hook`（hook 适配器）、`internal/`（核心状态机、存储、服务端、安装、通知、后台服务）、`web/`（React + Vite，小镇在 `web/src/town/`）、`native/app`（macOS App 外壳）、`native/macos`（通知助手）。

## 许可证

[MIT](LICENSE)

## English summary

Session Steward is a local progress and acceptance desk for Claude Code and Codex. Hooks forward session events to a single Go binary listening on `127.0.0.1:7788`; the web panel draws your work as a town (projects are houses, sessions are people, deliveries waiting for review are ripe crops), groups work by project, shows what is blocked and what is waiting for you, and lets you approve tool permissions in place. Only you can mark work as accepted. Optionally, several Macs can be merged into one town through a hub. Status: early; the UI is Chinese-only; used daily on macOS. Get the macOS app from Releases or build it with `sh scripts/build-app.sh` (Go 1.26.5+ and Xcode command line tools), or build the CLI with `go build -o bin/ ./cmd/...`, try it with demo data via `scripts/demo.sh`, then `bin/steward install`. Feedback is welcome in Issues; report security issues privately per [SECURITY.md](SECURITY.md).
