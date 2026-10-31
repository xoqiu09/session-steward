# Session Steward

给 Claude Code 和 Codex 用的本机进展台。好几个 Agent 同时在好几个项目里干活时，它把这些工作画成一座小镇：每个项目做到哪了、卡在哪、哪些事在等你，一眼就能看出来。

[试用说明](docs/TRYOUT.zh-CN.md) · [完整使用手册](docs/GUIDE.zh-CN.md) · [安全策略](SECURITY.md) · MIT 许可证 · [English summary](#english-summary)

> **v0.2.0 试用版。** 只支持 macOS（Apple 芯片和 Intel），界面只有中文。所有数据只存在你自己的电脑上，不需要账号，也不上传任何东西。作者每天在用，欢迎试用和反馈。

![小镇世界地图：每栋房子是一个项目，常一起开发的项目聚成村庄，中央广场上是告示栏（等你决定）和验收台（演示数据）](docs/images/town.jpg)

## 它能帮你做什么

- **一张地图看全部工作。** 房子是项目，小人是正在干活的会话，熟了的菜是等你看的交付，广场上的告示栏是等你决定的事。房子的位置固定，不会因为状态变化跑来跑去。
- **有新进展时带你去看。** 某个项目交付了，镜头会飞到那栋房子；你正在拖地图或读东西时不会抢镜头，看完点“回到刚才的位置”。
- **等你的事集中在一处。** 工具权限请求、Agent 的提问、等批准的合并、等你看的交付，都在面板右侧的队列里，可以直接允许、拒绝或处理。
- **“Agent 说做完了”不等于你点了头。** 进展和交付由 Agent 自己回报，只有你能把工作标为“已处理”。会话停止、沉默或空闲都不算完成。
- **按项目看简报。** 每个项目显示阶段、一句话结论、卡点、下一步和该谁动手，而不是一长串会话。

![项目简报：按项目列出进展、卡点和下一步，右侧是需要你处理的请求（演示数据）](docs/images/brief.jpg)

## 三步装好

需要：macOS 13 或更新版本，以及 Claude Code 或 Codex（任一即可，桌面版和命令行版都行）。

1. **下载。** 打开 [Releases](https://github.com/xoqiu09/session-steward/releases)，下载 v0.2.0 里对应芯片的 `Session-Steward_v0.2.0_macOS_arm64.app.zip`（Apple 芯片）或 `…_amd64.app.zip`（Intel）。解压后把 **Session Steward** 拖进“应用程序”。
2. **第一次打开。** 这个版本没有 Apple 签名和公证，macOS 会拦一下：
   - 在“应用程序”里**右键 Session Steward → 打开 → 打开**；
   - 如果没有“打开”按钮（较新的 macOS）：先双击一次，再到“系统设置 → 隐私与安全性”，在下方找到 Session Steward，点“仍要打开”。
3. **按引导点“安装 hooks 并开始”。** 引导会先说明要改哪两个文件（`~/.claude/settings.json` 和 `~/.codex/hooks.json`），改之前会备份，只添加 Steward 自己的条目。用 Codex 的话，还要在 Codex 里信任新加的 hooks。

装好后新开一个 Claude Code 或 Codex 会话，让它干点活，小镇里就会出现房子和小人。刚装好时小镇是空的，这是正常的：数据只来自你自己的会话。想先看看效果，见下面的[演示数据](#先用演示数据看一眼)。

<details>
<summary>想自己从源码打包 App</summary>

需要 `git`、Go 1.26.5 及以上，以及 Xcode 命令行工具（`xcode-select --install`）。前端已经构建好放在仓库里，不需要 Node。

```sh
git clone https://github.com/xoqiu09/session-steward
cd session-steward
sh scripts/build-app.sh
```

产物在 `dist-app/Session Steward.app`。把它拖进“应用程序”，然后从上面第 2 步继续。
</details>

## 先用演示数据看一眼

用一个单独的数据目录和端口，不会碰 `~/.steward`、`~/.claude` 或 `~/.codex`。需要 Go、`python3`、`curl` 和 `git`。

```sh
git clone https://github.com/xoqiu09/session-steward && cd session-steward
go build -o bin/ ./cmd/...
export STEWARD_HOME=/tmp/steward-demo && mkdir -p "$STEWARD_HOME"
echo '{"listen":"127.0.0.1:7799","history_days":0}' > "$STEWARD_HOME/config.json"
bin/steward serve        # 终端 1，保持运行
```

```sh
cd session-steward && export STEWARD_HOME=/tmp/steward-demo
scripts/demo.sh          # 终端 2：灌入 3 个虚构项目
bin/steward open         # 打开面板，顶部点“小镇”
```

演示里有两个权限请求会一直等你在面板里允许或拒绝，这是故意的。看完在终端 1 按 Ctrl+C 停掉，删掉 `/tmp/steward-demo` 即可。

## 用起来

### 跑通第一个真实任务

1. 新开一个 Claude Code 或 Codex 会话，像平时一样给它任务。
2. hooks 会在会话开始时给 Agent 一段说明，Agent 会自己登记任务、回报进展、做完时交付。小镇里出现一栋房子，门口有正在干活的小人。
3. Agent 需要权限时，告示栏上会多一张卡片，面板右侧的队列里可以直接允许或拒绝。
4. Agent 交付后，菜地里的菜会“熟了”。点“收菜”逐个查看交付了什么、在哪看、怎么验证；看过没问题点“已处理”，不行就“退回”。

更细的说明和常见问题见[使用手册](docs/GUIDE.zh-CN.md#先用一个真实任务验证价值)。

### 小镇

App 打开就是小镇的世界地图。

| 地图上的东西 | 意思 |
| --- | --- |
| 房子 | 一个项目。越大说明未完成的工作和最近的活动越多：小木屋 → 房子 → 工坊 → 大楼 |
| 村庄 | 最近常一起开发、互相有关的几个项目，围着一口井 |
| 野外的小屋 | 7 天没动静的项目 |
| 中央广场 | 全镇合计、验收台、告示栏（等你决定的事） |
| 小人 | 一个会话，衣服颜色表示是哪个 Agent |
| 熟了的菜 | 一个等你看的交付 |
| 红白路障、退件筐、小纸箱 | 有受阻的工作、最近失败的运行、正在进行的运行 |
| 灰色、云朵 | 很久没有新事件，不当作还在工作 |

常用操作：

- **拖动和缩放**：拖动地图移动，滚轮缩放；“全景”看全部，“广场”回到中间。
- **点项目名牌**：镜头飞到那栋房子和门前的菜地，人还在世界里；点**片区名牌**（例如“xx 一带 · 7 个项目”）看整片。看完点“回到刚才的位置”。
- **点房子本身**或“进入工作室”：走进项目内部，工作台是工作项，墙上白板是等你决定的事；按 Esc 出来。
- **点小人**：打开会话详情，可以回到原来的会话接着干。
- **收菜 N**：逐个打开等你看的交付。
- **按 Agent 看**、**回放**（看过去某一刻的小镇）、**怎么看**（小镇里的完整说明）。

房子的位置会记在浏览器里，刷新或重开 App 后还在原处；看过的动态不会重复飞过去。所有没归档的项目都会留在地图上，不想看到某个项目就在完整面板的“项目”里归档它，随时可以恢复。

小镇只用来看和找：批准、处理、退回都在面板里做。

### 合并审批

如果 Agent 在分支上干活，交付后会出现一张“合并审批”卡片。你在 GitHub 网页上合并以后，SS 要读到远端才会自动收起这张卡，卡片上会写明多久前核对过、结果是什么，可以点“立即核对”。分支已经被别的改动取代、不打算合并了，就点“不再合并”：只关掉这张卡，工作的处理状态不变。

### App 菜单

菜单栏的小房子图标显示“等你决定”的数量，有新的审批时会弹系统通知。菜单里可以打开小镇、工作室、每日十分钟或完整面板，开关“开机时启动”，安装或卸载 hooks，以及“退出并停止采集”。关掉窗口不会停止采集。

## 进阶（可选，默认关闭）

试用不需要这些，按需开启：

- **命令行版**：不想用 App 时，`go build -o bin/ ./cmd/...` 后运行 `bin/steward install`、`bin/steward service install`、`bin/steward open`。仓库要放在一个长期不动的位置，不要放在“文稿”“桌面”“下载”里。已经装过命令行版再装 App 时，App 会问你“接管”还是“共用”。
- **多台电脑合成一座小镇**、**在手机上只读查看**：需要 Tailscale，见[使用手册](docs/GUIDE.zh-CN.md#在其他设备上查看小镇只读)。只在你的 tailnet 内转发，**不要**用 `tailscale funnel` 或公网代理暴露面板。
- **本机 Codex 控制原型**：实验功能，默认不安装，见 [docs/native-codex-prototype.zh-CN.md](docs/native-codex-prototype.zh-CN.md)。

## 更新与卸载

- **更新**：v0.2.0 不支持在 App 里升级。有新版本时到 [Releases](https://github.com/xoqiu09/session-steward/releases) 下载新的 App，退出旧的，替换“应用程序”里的旧版再打开即可。数据在 `~/.steward`，不受影响。
- **卸载**：App 菜单选“卸载 hooks…”，Claude Code 和 Codex 的配置会恢复原样；再“退出并停止采集”，把 App 拖进废纸篓。命令行版用 `bin/steward service uninstall && bin/steward uninstall`。
- 数据在 `~/.steward`，确定不要了再自己删除。

## 已知限制

- App 没有 Apple 签名和公证，第一次打开要手动放行；也不能在 App 里升级。
- 只支持 macOS，界面只有中文。
- Agent 要按 hooks 给的说明登记和回报，项目简报和小镇才有内容；没有 Agent 在干活时小镇会比较空。
- 合并状态只认 Git 的证据：网络不好、读不到 GitHub 时，网页上的合并要等下次核对成功才会显示出来。
- 没装 tmux 时，“在面板里直接开托管会话”不可用，其他功能照常。

## 隐私与安全

- 只在本机运行，只监听回环地址，`Host` 不是回环地址的请求会被拒绝。没有遥测。
- 两个随机 token，权限 `0600`：一个给 hooks（只能访问 `/hook/*`），一个给面板（只能访问 `/api/*`，使用 HttpOnly、SameSite=Strict 的 cookie，写操作还要检查 Origin 和 `X-Steward`）。`steward open` 打印的登录链接含面板 token，不要发给别人。
- 保存的是脱敏后的事件元数据（事件类型、工具名、指纹、截断并遮蔽密钥的预览），不保存原始载荷或完整对话。
- 只有你配置了才会访问网络：读 Git 远端核对合并、`ntfy_url`、`summary_command`、`remote_hosts` 或多设备的 `hub`。远程查看是只读的，使用单独的 token。

发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 Issue。

## 反馈

试用时请照着[试用说明](docs/TRYOUT.zh-CN.md)走一遍，把卡住的地方和看不懂的地方记下来。问题和建议欢迎发到 [Issues](https://github.com/xoqiu09/session-steward/issues)，请附上：

- 版本：App 菜单“关于 Session Steward”，以及你用的 Claude Code / Codex 和版本；
- 发生了什么、你期望的是什么；
- 截图。截图前确认里面没有不想公开的项目名或内容，**不要贴登录链接、token、`~/.steward` 下的文件或对话全文**。

## 开发

```sh
make build     # 在 web/ 里 npm ci && npm run build，再 go build（注入版本号）
make test      # go test -race ./... 和 web 下的 npm test
sh scripts/build-app.sh   # 打包 App 到 dist-app/
```

- 改 Go：`go test ./...`，改状态机或并发相关时再跑 `go test -race ./...`。
- 改前端：在 `web/` 里 `npm test` 和 `npm run build`，并提交重新构建的 `web/dist`。
- 发布：推送 `v*` 标签后，GitHub Actions 会构建 Apple 芯片和 Intel 两种 App 和命令行包，建一个草稿 Release，检查后手动发布。
- 测试和演示只用合成数据；开发约定见 [AGENTS.md](AGENTS.md)。

目录：`cmd/steward`（服务与命令行）、`cmd/steward-hook`（hook 适配器）、`internal/`（核心状态机、存储、服务端、安装、通知、后台服务）、`web/`（React + Vite，小镇在 `web/src/town/`）、`native/app`（macOS App 外壳）、`native/macos`（通知助手）。

## 许可证

[MIT](LICENSE)

## English summary

Session Steward is a local progress desk for Claude Code and Codex on macOS. Hooks forward session events to a single Go service on `127.0.0.1:7788`; the app draws your work as a town (projects are houses that keep their place, sessions are people, deliveries waiting for you are ripe crops), flies to the house that just delivered, groups work by project, shows what is blocked and what is waiting for you, and lets you answer tool permission requests in place. Only you can mark work as handled. Everything stays on your machine; there is no account and no telemetry. v0.2.0 is a trial release: macOS only, Chinese UI, unsigned (open it with right-click → Open), no in-app updates. Download the app from Releases, or build it with `sh scripts/build-app.sh` (Go 1.26.5+ and Xcode command line tools). See [docs/TRYOUT.zh-CN.md](docs/TRYOUT.zh-CN.md) for the trial walkthrough. Feedback is welcome in Issues; report security issues privately per [SECURITY.md](SECURITY.md).
