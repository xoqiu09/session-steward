# Session Steward 使用手册（中文）

完整的行为语义、配置和安全说明。快速上手见 [README](../README.md)。

核心功能进度接入说明见 [CORE-FEATURES.md](CORE-FEATURES.md)：首页和详情按功能展示已实现、未验证、卡点和下一步负责人；由 Agent 更新，用户验收单独记录。

本地 Web 工作台，用来按项目查看 Claude Code、Codex 和其他 Agent 的会话与工作项。左侧是按仓库分组的工作项画布，显示状态、执行 Agent 和依赖；右侧是关注队列，分为：工具权限、需要决定、合并队列、阻塞、待验收、疑似需要关注。另有工作项和会话列表。

服务是一个 Go 单二进制（SQLite WAL，前端打包在二进制里），只监听回环地址。各 Agent 通过 hooks 调用适配器 `steward-hook`，把事件发给服务。

## 先用一个真实任务验证价值

首页默认是“项目简报”：按项目阅读阶段、一句话结论、卡点、下一步及负责人，右侧持续保留需要你处理的队列。完整回报、来源和时间可展开查看。画布和列表仍可切换；未归属会话不会伪装成已知任务。

项目简报优先展示有效的正式审批请求，其次是近期仍在运行的会话，再按最近活动排列。活动来自真实采集事件、任务登记和未被标错的简报/功能回报，不把 Git 扫描等造成的工作项更新时间当作继续推进。超过 24 小时无活动且没有正式审批的项目默认收在“近期无活动”，旧卡点和待验收仍保留，右侧审批与验收计数不受收起影响。搜索、选择具体项目或勾选“只看需我处理的项目”时，符合筛选的旧项目直接展示；新活动和正式请求会自动使项目重新出现。“最近活动”和“最近回报”分别显示，工具调用不会冒充业务进展。

顶部“谁在动”也使用相同的24小时活动范围和排序，收起的旧项目只显示总数。只有有效的正式审批或决定标为“需你处理”；普通交付与辅助回报标为“待审阅／验收”，仍有实际执行时优先显示“Agent 在做”。旧阻塞不计入当前活动阻塞数，完整记录和右侧队列保留。相同回报文字合并时，摘要时间取最新来源，全部来源仍可展开；“未填写卡点信息”表示缺少字段，不表示发现故障或已证实没有阻塞。

卡片上的“下一步”按负责人和类别分行：正式审批或决定标“正式请求，右侧处理”，普通交付标“待审阅，非审批”。来源超过 24 小时或来源会话已结束的卡点标为“待核查”，排在当前卡点之后，仍显示来源、时间和“查看”入口；这只表示需要核实，不表示已解决，也不改变计数和验收。同一文字只要有一个当前来源就按当前显示。旧安排折叠为“待核查的旧安排”。主卡片最多显示 3 条卡点，其余折叠并显示数量。依赖未就绪等服务状态标为“服务状态”，不显示可能被 Git 扫描改动的更新时间。只回报了负责人时显示“具体安排待回报”。

例行记忆整理可配置 `automatic_memory_projects`（Git common dir 的精确列表，例如 `["/approved/memories/.git"]`），默认不启用。只匹配这些项目内“整合／整理（本地）（代理／Agent）记忆”这类明确任务；不泛化到其他开发工作或所有周期任务。Agent 明确提交交付、没有未解决卡点、失败、正式请求或新的执行时，本轮直接进入“自动任务历史”，不计入待验收，也不发送成功通知；标注“Agent 回报完成”，不写成用户已验收。已有成功记录同样归档。失败、明确卡点、正式决定或运行中长时间无新事件仍展示并按新异常去重提醒；长时间无事件不代表已经确认卡死。普通项目交付照常验收。仅 Stop 或会话结束不足以自动归档；需要人决定时使用 `steward-hook ask` 或明确回报下一步负责人。

同一受阻状态不会因修改目标、验收说明或重复提交相同状态／依赖而重新提醒；上游仍未满足条件时的正常推进，也不重复提醒。实际恢复后再次受阻，或上游验收／合并条件重新不满足，仍视为新异常。依赖异常使用真实状态翻转记录和现有依赖满足规则判断，两次通知检查之间短暂恢复也不会丢失；升级和重启不会将普通编辑当作新异常。命令行拒绝空 `ask`；底层兼容事件即使没有文字，仍生成正式决定和对应通知。

已接入 hooks 的新会话在 `SessionStart` 收到简短的本地回报说明；现有会话则在下一次 `UserPromptSubmit` 时仅提醒一次。说明包含适配器的完整路径和该会话的 ID，不依赖 Agent 是否暴露会话环境变量。说明只建议在用户允许工具调用、正在做实际项目工作时回报；不会阻止会话，不会读取或发送对话全文。设置 `reporting_hints: false` 可关闭说明，采集和审批继续工作。协议依据：[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Claude Code hooks](https://code.claude.com/docs/en/hooks)。

Agent 明确任务后可调用（替换标题和实际项目目录）：

```sh
"$HOME/.steward/bin/steward-hook" begin --title "本次任务" --project "/实际项目目录" --goal "目标" --stage "planning" --summary "已明确本轮范围" --next-owner "agent" --progress "当前进展"
"$HOME/.steward/bin/steward-hook" report --stage "validating" --summary "改动已完成，正在验证" --progress "实际验证结果" --blocker "" --next "Codex 完成验证后提交交付" --next-owner "agent"
```

`begin` 在一个事务里完成创建或复用、会话关联和首份简报；同项目同分支的明确同名任务可复用，已有不同任务归属时拒绝改绑。集合启动目录无法确定项目时要求显式 `--project`。多个活跃会话无法唯一定位时加 `--provider claude|codex --session ID`；新会话的 hook 说明已带好这两个参数。历史会话仍只给建议，不自动批量创建工作项。

Agent 在实质进展、需要帮助或交付时回报，不按每个工具调用刷屏。内容标记为“Agent 自述”；有来源、时间和纠错入口。迟到回报按内容产生时的执行关系归属，旧进展不覆盖新进展；用户确认的内容保持优先，后续回报只待对照。服务不可用时回报报错，主任务照常进行。

阶段带依次显示“准备 → 实施 → 验证 → 待验收 → 已验收”，只高亮当前阶段，不表示之前所有步骤均已通过，不估算百分比。`--stage` 仅接受 `unknown/planning/implementing/validating`；Agent 通过 `deliver` 进入待验收，只有用户标记完成才显示已验收。项目汇总显示各阶段工作项数量，不把会话数或代码量当成项目完成率。

同一项目可以有多个工作项，每项单独展示。多个近期会话协作同一工作项时，首页改为逐会话列出阶段、进展、卡点和下一步负责人，不把最后发言会话的阶段当成全体阶段。一方清除自己的卡点不影响另一方；工具活动和过期提示也分别计算。会话结束或长时间无活动后，其回报收在历史中；接手者没有回报时保持未知，不借用前任的结论。工作项被用户更正的字段仍保持优先。

Agent 明确回报 `next_owner=user` 且提供下一步或卡点时，右侧“回报中需你处理”显示原始来源与恢复入口；此处不会允许工具或执行命令。Agent 后续更正负责人、完成或放弃工作项后，这条回报会自动退出对应队列。实际工具权限、显式求助、合并和用户验收仍按原有规则处理。

同一来源会话收到用户的新输入，或完成 Claude 的提问/计划确认工具后，更早的辅助接手提醒自动收起，原简报与来源保留。其他会话的输入、普通工具调用或空闲不会清除它，新回报仍可再次请求用户处理。Claude 的 `AskUserQuestion` 和 `ExitPlanMode` 交由原界面收集实际答案或计划确认，Steward 只显示“需要决定”，不会用通用的允许/拒绝代替回答；对应调用结束后该问题自动关闭。

另一个会话继续工作或原会话结束，都不算用户已回应；明确的用户接手回报继续保留，直到该会话更新负责人、工作项完成/放弃，或重新开始新一轮工作。

整项工作之后又明确提交新交付时，更早的辅助接手提醒归入该次待验收入口，避免旧检查建议一直常驻。正式求助和工具权限请求仍由各自生命周期关闭；交付本身不代表它们已获批准。

`--summary` 是首页的一句话结论，`--next-owner` 选择 `agent`（回报者自己）、`claude/codex`（明确交接）、`user`、`external` 或 `unknown`。阶段和下一步负责人按内容时间更新，不需用户逐项维护；原有目标和文字字段仍保留用户更正优先规则。旧会话在下一次提示时也能收到新版回报说明。重新开始待验收、已完成或已放弃工作项时保留目标，清除上一轮简报的展示并等待本轮新回报；旧离线回报不跨轮覆盖。

已经运行中的旧会话若仍使用原简报格式，成功回报后也会收到简短的格式升级提示，让 Agent 在下一次自然进展时补齐阶段、结论和负责人，不要求用户重新登记或重跑测试；关闭 `reporting_hints` 时不输出此提示。

验收重点是：离开工作一阵后，能否在一分钟内读懂当前真实任务的进展和下一步，并从同一入口处理阻塞。前端有内容字段不等于已经采集到真实回报；空态和过期提示应保持诚实。仅由问句产生的低置信提醒默认折叠，不计入“需要你处理”，也不会让旧空闲会话常驻首页。`steward version`、`steward-hook version` 和已登录的 `/api/version` 可核对实际运行提交。

会话结束会关闭执行记录。恢复同一会话时，hook 可给出上次工作项的准确编号：仅在仍继续原任务时，Agent 可自行 `claim` 恢复原归属再回报，无需用户重复登记；开始新任务仍使用 `begin`。这条提示不会自动改绑，也不会恢复人工解绑、已撤销归属或已完成的任务。

## 支持情况

- 核心：可靠采集（适配器、本地暂存、去重、乱序保护、SSE 游标、冷启动历史扫描）、权限审批闭环、项目画布与依赖（判环、条件）、决策队列、绑定提交的合并审批、由 Git 验证的“已合并”、项目简报与功能进度。
- 已在维护者的 macOS 上实测：Claude Code CLI / 桌面；Codex CLI 与桌面（引擎 `0.163.0-alpha.10.2`）的事件采集、权限允许 / 拒绝和执行确认。CLI 另验证了超时、重启与离线补发；桌面验证了等待审批时服务断开会回到原生审批。其他客户端版本和子代理生命周期未系统验证。
- 可选功能，测试只使用合成数据，真实场景使用经验仍少：托管会话（独立 worktree + tmux）与只读实时终端、“需要你”推送、检查门合并、跨 Agent 交接包、用量统计、更多 Agent、远程只读访问、复盘、AI 摘要。见下文对应章节。
- 平台：macOS 完整支持。Linux 可构建运行核心服务（通知仅 ntfy），Windows 可编译但未测试。
- 不支持：远程执行环境（SSH、云端会话）。那里的 `127.0.0.1` 不是这台机器。

## 构建

需要 Go 和 Node（npm）。

```sh
make build   # 先构建 web/（npm ci && npm run build），再 go build -o bin/ ./cmd/...（注入 git describe 作为版本号）
make test    # go test -race ./... 和 web 下的 vitest
```

产物是 `bin/steward` 和 `bin/steward-hook`。两者需要放在同一目录，`steward install` 会在 `steward` 所在目录查找 `steward-hook`，并把它复制到 `~/.steward/bin/steward-hook`，hooks 条目调用的是这份副本。因此**重新构建后要再运行一次 `steward install`**，否则 hooks 仍在使用旧版本的 `steward-hook`。`steward version` 和 `steward-hook version` 输出构建时注入的版本号（直接 `go build` 时为 `dev`），报告问题时请附上。

## 快速开始

```sh
bin/steward serve                      # 启动服务，默认 http://127.0.0.1:7788
bin/steward open                       # 打印面板登录链接并用默认浏览器打开（macOS 用 open，Linux 用 xdg-open）
bin/steward install [claude|codex|all] # 追加 hooks 条目，默认 all
bin/steward status                     # 查看已接入的事件、Codex 信任状态、服务是否在运行
bin/steward uninstall [claude|codex|all]
```

- `install` 会写入 `~/.claude/settings.json` 和 `~/.codex/hooks.json`。安装器只在每个事件数组末尾追加自己的一组条目，不改动、不重排已有条目（例如其他工具已有的 hooks）。每个 Steward 条目的命令里带标识 `--mark=steward-v1`。重复安装是幂等的，只替换自己的条目。
- 首次安装会把原文件备份到 `~/.steward/install/<claude|codex>.orig`。写入采用“临时文件 + rename”，rename 前确认文件没被其他程序改过。配置文件是符号链接（例如由 dotfiles 管理）时，写入链接指向的真实文件，链接本身保持不变。
- `uninstall` 有两种结果：
  - 文件在安装后没被修改过：逐字恢复安装前的文件（原本不存在则删除）。
  - 文件被其他程序修改过：只移除带 `--mark=steward-v1` 的条目，保留他人的修改。
  - 如果某次重新安装时发现文件在上次写入后被改过，原始备份即作废，之后的卸载一律只移除 Steward 条目，不会用旧备份覆盖他人的修改。
- Codex 需要在应用内确认新的 hooks 才会启用。`steward status` 会根据 `~/.codex/config.toml` 里是否存在信任记录列出待确认的事件；它无法校验哈希，最终以 Codex 内的提示为准。
- `PermissionRequest` hook 的超时设为 `permission_wait_sec + 30` 秒；Codex 的 `Interrupt` / `SessionEnd` 为 3 秒，其他事件为 10 秒。

适配器在 hooks 模式下始终以退出码 0 结束，普通事件不向 stdout 输出任何内容。服务不可用时事件写入本地暂存，下次发送成功后补发；也可以手动运行 `steward-hook flush`，它会打印剩余条数和累计丢弃数。

## 后台常驻（macOS launchd）

手动运行的 `steward serve` 会随终端关闭而退出。想让面板一直可用，可以把服务注册为当前用户的 LaunchAgent：

```sh
bin/steward service install    # 写入 ~/Library/LaunchAgents/io.github.xoqiu09.session-steward.plist 并加载
bin/steward service status     # plist 是否由 steward 写入、launchd 是否已加载、state / pid / 上次退出码
bin/steward service restart    # 让 launchd 重启服务进程
bin/steward service uninstall  # 停止服务并删除这份 plist
```

- 默认不安装，需要你手动运行 `service install`。
- plist 运行的是执行 `install` 时那个 `steward` 的绝对路径（解析符号链接后），参数为 `serve`。`RunAtLoad` 和 `KeepAlive` 都开启：登录后自动启动，进程退出后 launchd 会重新拉起（launchd 两次启动之间至少间隔 10 秒）。
- launchd 不继承登录 shell 的环境，plist 里会写入：`STEWARD_HOME`（当前数据目录的绝对路径）、UTF-8 的 `LANG`（当前 `LANG` 不含 UTF-8 时用 `en_US.UTF-8`）、安装时的 `PATH`（托管会话靠它找到 `claude`、`codex`、`git`），以及设置了的 `CODEX_HOME`。之后修改了这些变量，重新运行一次 `service install` 即可更新。
- 日志写到 `$STEWARD_HOME/logs/serve.out.log` 和 `serve.err.log`（服务日志在 `serve.err.log`）。日志不会自动轮转，卸载时保留。
- 只操作自己这份 plist：文件里带标识 `steward-service-v1`。同名文件不带标识时，`install` 拒绝覆盖，`uninstall` 也拒绝删除。plist 没有变化且服务已加载时，`install` 什么也不做。
- 用 `launchctl bootstrap gui/$UID` / `bootout gui/$UID/<标签>` 加载和卸载，`restart` 用 `launchctl kickstart -k`。
- `steward service` 不能用 `go run` 运行：`go run` 的二进制是临时文件，会被删除。请先构建。

**同一个数据目录和端口只能有一个 `serve`。** 两个 `serve` 共用 `STEWARD_HOME` 会同时写同一个 SQLite 库；后启动的那个绑定端口失败后退出，launchd 又会每隔约 10 秒拉起一次。因此 `service install` 发现监听地址已被占用、而服务尚未加载时会拒绝安装，并提示先停止已有的 `steward serve`（Ctrl-C 或结束该进程）。确认占用端口的不是 steward 时，可加 `--force` 跳过这项检查。服务装好后不要再手动运行 `steward serve`。用 `STEWARD_HOME=/tmp/steward-demo` 和另一个端口运行演示不受影响；后台服务只有一个，用另一个 `STEWARD_HOME` 再运行 `service install` 会把它切换过去。

**更新 steward：**

- 在原位置重新构建（例如 `make build`，产物仍是 `bin/steward`），然后运行 `bin/steward service restart`，launchd 会用新的二进制重新启动。
- `steward` 换了位置时，从新位置运行 `steward service install`，plist 会指向新路径并重新加载。也可以先 `uninstall` 再 `install`。
- 不要删除或移动 plist 指向的那个 `steward`，否则 launchd 无法启动服务（`service status` 会显示非零的上次退出码）。
- `steward-hook` 的更新方式不变：重新构建后仍需运行一次 `steward install`。

### 在其他设备上查看小镇（只读）

服务常驻后，可以在手机或另一台电脑上查看面板和小镇。只能在你自己的私有网络（例如 Tailscale tailnet）内这样做：

1. 本机常驻：`steward service install`（见上文）。
2. 只在 tailnet 内转发：`tailscale serve --bg --https=443 http://127.0.0.1:7788`。不要用 `tailscale funnel` 或其他公网代理。代理必须保留原始 `Host` 头（`tailscale serve` 默认如此），否则远程请求会被当作本机请求，一直无法登录。
3. 在 `$STEWARD_HOME/config.json` 的 `remote_hosts` 填写这台 Mac 的 tailnet 主机名，例如 `["mac.<tailnet>.ts.net"]`，再运行 `steward service restart`：配置只在服务启动时读取。
4. 运行 `steward remote` 打印远程登录链接。链接本身就是凭据，只在自己的设备上打开，不要分享。`steward remote --rotate` 会生成新链接并让旧链接失效，同样要运行 `steward service restart` 后才生效。
5. 在另一台设备上打开这个链接，登录后会跳到面板首页（登录状态保留 30 天）。然后打开 `https://<主机名>/?view=town` 进入小镇；挂在副屏或手机上常开时，用 `https://<主机名>/?kiosk=1` 进入桌面模式（自动轮播项目）。这两个入口在小镇相关 PR 合并后才有。

远程是只读的：可以看小镇、简报和队列，也可以点开详情；托管会话的终端画面（包括只读画面）在远程看不到。审批、验收、编辑简报等所有写操作都要回到本机面板做，服务端会拒绝远程的写请求。

Linux 暂不支持 `steward service`。可以自己写一个 systemd 用户单元，例如 `~/.config/systemd/user/steward.service`：

```ini
[Service]
ExecStart=/path/to/bin/steward serve
Environment=LANG=C.UTF-8
Restart=always

[Install]
WantedBy=default.target
```

然后运行 `systemctl --user enable --now steward`。这个示例没有经过测试。

## 把会话归属到工作项

工作项编号格式为 `ABC-123`（字母开头，最多 16 个字母数字，加 1–6 位数字）。可以先在面板中创建，也可以由 Agent 用 `begin` 一次创建并关联。

归属优先级从高到低：

1. 人工绑定：在面板会话详情里绑定，优先级最高，低优先级来源不会覆盖它。
2. 显式标识：
   - 在 prompt 里写 `#ABC-123`（工作项须已存在）。
   - Agent 在会话里运行 `steward-hook claim ABC-123`。
3. 分支名推断：分支名形如 `feat/ABC-123-xxx` 时参与自动归属；同项目唯一的明确匹配可自动关联，歧义交由面板确认（见文末自动归属规则）。

同一会话切换到另一个工作项时，旧的执行尝试以“转交”结束，再开新的执行尝试。

Agent 可以在会话里调用：

```sh
steward-hook claim ABC-123            # 声明当前工作项
steward-hook ask "断网提示放哪里？"     # 提交需要人决定的问题，进入“需要决定”
steward-hook deliver "已完成，报告在 …" # 提交交付，当前工作项进入“待验收”
steward-hook report --goal "…" --progress "…" --blocker "…" --next "…"  # 回报工作简报，字段可省略，空串清除
```

`deliver` 也支持结构化字段，例如 `steward-hook deliver --summary "候选已就绪" --progress "已通过的检查；尚未验证的边界" --blocker "" --next "请用户核对验收条件"`。交付的阶段固定为待验收、下一步负责人固定为用户；参数不会拼入显示正文，未知参数会报错。简单的 `deliver "说明"` 继续有效。

这些命令会依次查找会话：`--session ID [--provider P]` 参数 → 环境变量 `CLAUDE_SESSION_ID` / `CODEX_THREAD_ID` → 当前目录所在 worktree 里唯一的活跃会话。找不到或有多个时报错并以非 0 退出。Claude 和 Codex 是否真的在工具环境里提供这两个环境变量，待确认（M0）。

## 关键语义

四类对象的状态：

| 对象 | 状态 |
|---|---|
| 工作项 | 待开始 / 执行中 / 阻塞 / 待验收 / 已完成 / 已放弃；合并状态单独记录：无需合并 / 未就绪 / 待合并审批 / 已批准 / 已合并 |
| 会话 | 运行中 / 等待权限 / 空闲 / 已中断 / 出错 / 已结束 / 状态未知；另有数据来源：实时采集中 / 仅历史发现 / 长时间无活动 |
| 执行尝试 | 进行中 / 已结束，结果为交付 / 失败 / 放弃 / 转交，或待定 |
| 审批 | pending / decided / delivered / confirmed / expired / cancelled |

事件映射：

- 工作简报（目标 / 最新进展 / 卡点 / 下一步）只来自 Agent 主动回报（`report`；`ask` 写卡点，`deliver` 写进展）和面板编辑，每条记录来源会话、命令和内容时间，不读取对话正文。会话未关联工作项时 `report` 报错。面板里填写或确认的字段不被之后的 Agent 回报覆盖，新回报显示为“待对照”；“标记有误”的回报不再显示，也不回退到更早的回报。所有简报操作按条目追加记录，可撤销。
- 最近一次进展回报之后又有 20 次以上工具调用，或持续 60 分钟以上仍有活动，只提示“可能过期”，内容不变；待验收及之后的状态不提示。
- `Stop` 只表示一轮回复结束，会话变为空闲，工作项状态不变。工作项只能由人工操作或 `steward-hook deliver` 进入待验收。
- `Interrupt`（Codex）记为已中断，不算出错；`StopFailure`（Claude）记为出错并附原因。
- `SessionEnd`：会话已结束，执行尝试结束，结果待定，可在面板补记。
- `Notification(idle_prompt)` 只表示空闲，不进入决策队列。`agent_needs_input`、`elicitation_dialog` 进入“需要决定”。
- `Stop` 时最后一条回复以问句结尾，生成低置信度的“疑似需要关注”，同一会话合并。用户在该会话再次输入后，它和“需要决定”条目都会自动关闭。
- 运行中超过 `stale_after_min` 分钟没有事件，只显示“长时间无活动”，不判定为卡死。
- 主画布与会话列表默认收起“长时间无活动”的会话，以及空闲 / 中断 / 出错等非运行状态超过 30 分钟的会话。有待处理审批的仍保留；工具栏“已收起会话”可查看，会话范围切到“全部及历史”可查看所有记录。收到新事件后重新显示，工作项、执行记录和会话状态不因此改写。工作卡的“等权限”以实际未处理审批为准。
- “同目录并发”只计入仍新鲜的运行中或等待权限会话；空闲、中断、出错、结束和过期状态不参与。它表示需要留意同目录并发，不断言多个会话正在写文件。
- 乱序事件按发生时间合并，较旧事件不会覆盖较新状态；重复的 `event_id` 被忽略。

权限审批：

- 适配器收到 `PermissionRequest` 后同步调用服务，等待面板决定。生命周期为 pending → decided（面板已决定）→ delivered（适配器已把决定写回 Agent）→ confirmed（之后观察到对应工具的 `PostToolUse`）。
- 面板决定必须同时匹配审批 ID 和内容指纹（工具名、参数、cwd 的哈希）。迟到的决定不会作用到下一次相似请求。
- Codex 执行确认单独使用 `turn_id` / `tool_use_id` 关联。权限事件缺少工具调用 ID 时，只绑定同轮、同子代理、同工具中唯一未完成的调用；并行同参数请求存在歧义时保持未确认。执行关联不参与放行，审批内容指纹保持完整。
- 拒绝后不会有成功的 `PostToolUse`，因此“已送达拒绝”是正常终态，不升级为“已确认执行”。Codex 的 client 统一显示为 `cli` / `desktop` / `unknown`，原始 originator 保留在事件里。
- 以下情况审批变为 expired 或 cancelled，按钮失效：超时、出错、中断或结束、适配器断开、服务重启。`Stop` 只是一轮结束，不取消仍有效的权限请求。
- 超时、服务不在线或请求被取消时，适配器不输出任何决定，Agent 回到原生审批流程。
- 只支持对单次请求“允许本次 / 拒绝”。Codex 中其他 hook 的拒绝可能优先，所以“已批准”不等于放行，以“已确认继续”为准。
- 只通过通知观察到、未经过 `PermissionRequest` 的权限提示，显示为“请回原界面处理”，面板只能标记已处理。

合并审批（复制指令版）：

- 服务每 30 秒做一次只读 Git 扫描。工作项处于待验收或已完成、设置了分支、且分支领先目标分支（仓库默认 `main`）时，生成合并审批。
- 批准绑定仓库、源分支 SHA、目标分支和目标 SHA。源分支有新提交后旧批准作废并重新排队；目标分支前进后标记“需重建候选”，此时不能批准。
- 批准后可以“复制合并指令”，粘贴到任一会话执行。“已批准”“已复制指令”“已合并”分别记录。
- “已合并”只由 Git 确认：目标分支包含源分支 SHA。

依赖条件为“上游已验收”（`accepted`，默认）或“上游已合并”（`merged`）。写入时检测环；已放弃的上游不满足依赖。

## 安全与隐私

- `listen` 只允许 `127.0.0.1:`、`localhost:`、`[::1]:` 开头的地址；请求的 Host 不是回环地址时返回 403，用于防 DNS rebinding。
- 两种凭据，首次使用时随机生成，文件权限 0600：
  - 采集 token `ingest.token`：只能访问 `/hook/*`（写事件、权限请求），通过 `Authorization: Bearer` 发送。
  - 面板凭据 `panel.token`：`steward open` 生成 `/login?t=...` 链接，登录后写入 `steward_panel` cookie（HttpOnly、SameSite=Strict）。只有它能访问 `/api/*`。非 GET 请求还要求 `X-Steward: 1` 头并检查 Origin。
- 默认只保存脱敏事件：事件类型、工具名、内容指纹、截断并遮盖密钥后的命令/路径预览，不保存原始 payload。
- `keep_summary` 默认关闭；开启后保存 prompt 和最后回复的截断摘要。即使关闭，最后回复以问句结尾时也会保存末尾约 200 字，作为“疑似需要关注”的上下文；`ask`、`deliver` 的文本会截断并脱敏后保存。
- 冷启动只读取 `~/.claude/projects/*/*.jsonl` 和 `~/.codex/sessions/`（可用 `CODEX_HOME` 覆盖）文件开头的元数据，登记为“仅历史发现”。

数据目录为 `~/.steward`，可用环境变量 `STEWARD_HOME` 覆盖：

| 路径 | 内容 |
|---|---|
| `config.json` | 配置，可选 |
| `ingest.token`、`panel.token`、`host_id` | 凭据和本机标识 |
| `steward.sqlite` | 数据库 |
| `spool/` | 服务不可用时的事件暂存（`events.jsonl`、丢弃计数 `dropped`） |
| `install/` | 安装状态和原文件备份 |

`config.json` 字段（缺省值）：

```json
{
  "listen": "127.0.0.1:7788",
  "reporting_hints": true,
  "permission_wait_sec": 600,
  "keep_summary": false,
  "stale_after_min": 10,
  "history_days": 14,
  "spool_max": 2000,
  "agents": {"claude": ["claude"], "codex": ["codex"]},
  "tmux": "",
  "worktree_root": "",
  "notify_macos": true,
  "notify_dialog": false,
  "ntfy_url": "",
  "checks": {"my-repo": [["go", "test", "./..."], ["npm", "--prefix", "web", "test"]]},
  "auto_merge": true,
  "check_timeout_sec": 900,
  "usage_from_transcripts": false,
  "remote_hosts": [],
  "summary_command": [],
  "summary_repos": []
}
```

`auto_merge` 缺省为 `true`，只对 `checks` 中配置了检查命令的仓库生效：配置后批准合并即自动运行检查并更新本地目标分支。`spool_max` 是暂存上限，满了丢弃最旧的事件并计数。修改 `listen` 或 `permission_wait_sec` 后需要重新运行 `steward install`，hook 超时才会同步更新。

数值字段有下限：`permission_wait_sec`、`check_timeout_sec`、`spool_max` 不小于 10，`stale_after_min` 不小于 1，`history_days` 不小于 0（0 表示不扫描历史会话）。低于下限（包括 0 和负数）时按缺省值处理，服务与 hook 使用同一套规则。`config.json` 无法解析或 `listen` 不是回环地址时，`steward serve` 等命令报错退出；`steward-hook` 不发送任何请求，直接以退出码 0 结束，不影响 Agent。

## 托管会话与推送

- 面板“＋ 新建会话”：选项目（须为 Git）、Agent（只能选 `agents` 配置里的名字，面板不能提交命令）和任务标题。服务从目标分支（默认 `main`）`git worktree add -b steward/<id>`，在独立 tmux socket（`tmux -L steward`）里 `steward-<id>` 启动命令，并在同一事务创建工作项。该 worktree 里出现的 hooks 会话自动关联到这个工作项（绑定来源“托管”，不覆盖人工绑定）。
- 终端画面：服务每 0.5 秒 `capture-pane`，有变化才经 SSE（`/api/managed/{id}/terminal`）推送；默认只读。勾选“接管输入”后才能发送文本或有限的按键（回车、Esc、Ctrl-C、方向键等），开关和每次输入都写入审计，审计只记长度不记内容。非托管会话显示“未托管，无画面”。
- 服务每 2 秒按 tmux 实际状态同步：重启后仍在运行的会话照常接上；进程退出记录退出码；tmux 会话消失记为已退出并写明原因。停止、退出都不改变工作项状态。
- 归档只移除 worktree 目录，分支和提交保留；有未提交改动时返回改动列表，需在面板确认后才丢弃。
- “需要你”推送：新的可处理权限请求、需要决定、Agent 回报 `next_owner=user`、会话出错/中断、托管会话异常退出。按条目去重，只推送服务启动之后出现的条目；内容只有类别和编号，不含命令或对话。macOS 默认只发系统横幅，不弹出阻塞对话框。运行 `make notifier` 后，服务会使用同目录的 `Session Steward.app`，显示项目图标；每条通知保存自己的本机深链，点击只打开相应工作项/审批/会话，不批准工具或验收交付。首次使用独立来源需在 macOS 允许通知；横幅样式遵循系统通知设置。未安装助手时退回脚本编辑器的普通横幅（该退路不支持深链）；旧 `notify_dialog: true` 仅作显式兼容选项。`ntfy_url` 填写后才发送 ntfy。允许/拒绝沿用原有指纹校验。 macOS 以外的系统不发系统通知，可用 `ntfy_url`。
- 首页顶部一行：等你 / 运行中 / 阻塞 / 无活动 数量，及每个项目当前行动方（等你、Agent 在做、等外部、待回报）。

## 检查门、交接与用量

- 检查门合并：只对 `checks` 里配置了命令的仓库（按仓库名或 git common dir 匹配）生效。批准合并后（`auto_merge`，或面板“运行检查并合并”），服务先确认源/目标仍是批准时的 SHA，再在临时 detached worktree 中合并并逐条运行检查（argv，不经过 shell）。全部通过才用比较后交换更新本地目标分支；目标分支在某个目录中检出时要求该目录没有已跟踪改动并用 `--ff-only`。任一检查失败、SHA 移动或服务重启都不合并。检查输出末尾脱敏后保存。“已合并”仍只由 Git 扫描确认；不推送远程。合并提交使用仓库自己的 Git 身份。
- 跨 Agent 交接：工作项详情“交接给其他 Agent”。交接包只由简报、功能清单和 Git 记录生成，不含对话正文，标明是 Agent 自述。确认后从当前分支头新建 worktree 启动接手 Agent，交接包作为首条提示传入（`prompt_arg`），并写到该 worktree 私有 git 目录的 `steward-handoff.md`（不会进入提交）。上一位会话不会被停止，未提交改动不会带过去；接手会话自动关联同一工作项。
- 用量：`usage_from_transcripts: true` 时，每分钟从本机 `~/.claude/projects` 与 `~/.codex/sessions` 的 JSONL 中只解码 token 计数字段，按会话保存，按工作项汇总；同一会话做过多个工作项时无法拆分，界面会标出重复计入。默认关闭。
- 更多 Agent：`agents` 的值可以是命令数组，也可以是 `{"argv": [...], "provider": "...", "hooks": false, "prompt_arg": false}`。没有 hooks 的 Agent 只有托管终端画面，界面会说明它不会自动回报。

## 远程访问、复盘与 AI 摘要

- 远程访问默认关闭。服务仍只监听回环；在 `remote_hosts` 填写 HTTPS 代理的主机名（例如 Tailscale 的 `mac.<tailnet>.ts.net`），再由 `tailscale serve --bg --https=443 http://127.0.0.1:7788` 之类的代理转发。反向代理必须保留原始 `Host` 头（`tailscale serve` 默认如此；nginx 等需设置 `proxy_set_header Host $host`）：服务按 Host 区分远程和本机请求，Host 被改写为 `127.0.0.1` 后远程请求会被当作本机请求，远程 token 无法登录（这是安全的拒绝，但表现为一直 401）。只有列出的主机名可访问，必须是 HTTPS 同源 Origin，采集接口 `/hook/` 不对远程开放。远程使用独立的 `remote.token`（`steward remote` 打印登录链接，`steward remote --rotate` 吊销并重新生成，重启服务后生效）；本机 token 在远程无效，反之亦然。远程只能查看：审批、简报编辑等所有写操作，以及启动会话、终端画面（含只读画面）、合并、交接、生成摘要，只在本机进行，服务端同样拒绝。远程会看到全部项目的简报和脱敏后的命令预览；只使用 tailnet 内的 `tailscale serve`，不要用 `tailscale funnel` 或其他公网转发；登录链接本身就是凭据，不要分享。开启远程后，ntfy 推送的点击链接指向远程面板。
- 复盘（“复盘”标签）：按 Agent 汇总最近 7/30/90 天的执行记录：执行、交付（Agent 的 deliver）、已验收（你标为完成）、交付后重开、待验收、放弃、交接出去、检查门结果。只展示计数与比例和口径说明，不打分。
- AI 摘要默认关闭。`summary_command` 是本机命令 argv（材料经 stdin 传入，不经 shell），只对 `summary_repos` 中列出的仓库可用。材料与交接包相同：简报、功能清单、Git 记录，不含对话正文，已脱敏。摘要始终标为“AI 推断”，不改写简报；材料变化后标出“可能过期”。若命令会把材料发给云端模型，请只对允许外发的项目开启。

## 演示

演示脚本在隔离的数据目录里建三个真实 Git 仓库，并通过 `steward-hook` 发送模拟事件，不会触碰 `~/.steward`、`~/.claude`、`~/.codex`。需要 `python3`、`curl`、`git`，并先完成 `make build`。

```sh
export STEWARD_HOME=/tmp/steward-demo
mkdir -p "$STEWARD_HOME"
# 可选：换端口，并把 history_days 设为 0，跳过对真实历史会话的扫描
echo '{"listen":"127.0.0.1:7799","history_days":0}' > "$STEWARD_HOME/config.json"

bin/steward serve            # 终端 1：先启动服务，会生成 panel.token 和 ingest.token
scripts/demo.sh              # 终端 2：同一个 STEWARD_HOME 下运行
bin/steward open             # 打开面板
```

`scripts/serve-demo.sh` 是终端 1 的简写，固定使用 `/tmp/steward-demo`。脚本最后会在后台挂起两个权限请求，等待面板决定，输出写到 `$STEWARD_HOME/perm1.out`、`perm2.out`。

## 目录结构

```
cmd/steward/        服务与管理命令
cmd/steward-hook/   hooks 适配器和 claim/ask/deliver/report/flush
internal/config/    数据目录、配置、凭据
internal/install/   hooks 安装/卸载、Codex 信任检测
internal/service/   后台常驻（macOS LaunchAgent）
internal/hook/      适配器逻辑和本地暂存
internal/event/     统一事件格式、hook 输入解析、脱敏
internal/server/    HTTP 接口、鉴权、SSE
internal/core/      状态机、归属、审批、依赖、合并扫描
internal/store/     SQLite 存储和变更游标
internal/gitx/      只读 Git 查询
internal/scan/      冷启动历史扫描
internal/ojson/     保序 JSON，用于不打乱他人的配置
internal/tmux/      托管会话的 tmux 封装（独立 socket）
internal/notify/    “需要你”推送渠道（macOS、ntfy）
internal/usage/     transcript token 计数解析（只读数字字段）
web/                React + Vite 前端
scripts/            演示脚本
```

### 项目推进视图与会话归属

- 卡片优先展示工作项标题；未归属会话读取 Codex `session_index.jsonl` 的 `thread_name`，以及存在时的 Claude `sessions-index.json` 标题元数据。每 30 秒刷新，保留来源标记，不读取对话正文或 `firstPrompt`，标题索引本身只更新元数据，归属整理按下列规则执行。
- 标题缺失时展示分支线索或“工作内容待登记”，每个会话以本地编号区分。搜索支持未归属会话标题。
- 点击会话可以选择已有工作项，或用标题预填创建并关联。创建与关联在同一个事务中完成。创建时可填写已有项目目录；启动目录与工作项实际项目分开，关联后按工作项项目展示。
- 工作卡展示具体执行会话、最近活动，以及待审批 / 待决定 / 依赖 / 待验收原因。工具预览只是最近观察到的操作，不宣称正在执行或已经完成。
- 右侧队列展示工作名称和会话编号，跟随项目与 Agent 筛选。工作项页签可查看已有事项和新建；画布默认使用可读比例，左下角“适应视图”可查看全图。

### 自动归属与批量确认

- 每 30 秒整理一次；人工绑定 / 显式 claim 保持优先，不覆盖已有执行关系。也可从“归属待确认”点“立即整理”。
- 未归属的实时会话在近 24 小时有活动时：同项目唯一的明确工作项编号、非公共分支、具体完整标题可自动关联。跨项目冲突、不同工作分支、多个明确匹配、相似标题只给候选。
- 项目目录明确、标题具体或有描述性功能分支、且没有既有候选时，自动创建并关联工作项。同项目同任务的并行会话复用同一工作项。公共分支 / 集合目录 / 项目名式标题不单独证明工作内容。
- 历史会话、已结束会话、无活动超过 24 小时的会话只作建议，不自动新建工作项。已有归属历史的会话不重复登记。确认历史归属时记录已结束的历史 run，不宣称仍在运行或已验收。
- 右侧归属面板可按项目 / Agent 范围查看，分近期、历史和整理记录。选择项目后可“全选可确认”并批量新建 / 关联。多候选必须明确选择；统一项目只补充原先项目不明的项，不改掉每项已明确的项目。
- 确认绑定元数据指纹；线索或绑定变化后旧决定返回 409。批量操作在同一事务中完成，任一失败全部回滚。暂不关联不会反复提示同一线索。
- 自动 / 确认操作保存理由、目标工作项和对应 run。撤销只结束这一次关联；自动创建且未修改、无其他有效执行关系的工作项移到已放弃，保留审计，不删除。后续人工绑定和交付记录不会被旧撤销覆盖。
