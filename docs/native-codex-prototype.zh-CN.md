# 本机 Codex 控制原型（个人非商业验证）

这是独立、默认不安装的原型。普通 `steward serve`、远程面板全局只读、Tailscale 和现有工具配置均不改变。只验证一个明确授权的 workspace、一条 Codex 原生 thread 和一个小镇工作项。

## 使用范围与实现

用户本次授权：先限个人非商业自用验证，完成“手机式客户端发任务 → 固定 Mac 执行 → 页面断开继续 → 同原生会话恢复 → 结果回小镇等待处理”。模型沿用本机 Codex 的既有配置；本机执行不意味着模型推理一定本地。

当前实现：

- 新命令 `cmd/steward-native-prototype` 使用显式隔离 home 和单一 workspace，拒绝默认正式库、未标记的已有数据库和状态符号链接；不扫描真实历史会话。
- `internal/nativecontrol` 通过本机 `codex app-server --stdio` 启动、恢复 thread、开始/停止 turn、处理结构化事件。协议对照 Codex 0.164.0 生成的 experimental JSON schema；动态交付工具需要 experimentalApi。
- 会话记录保留原生 thread ID、当前 turn ID、主机、workspace、小镇 Session/WorkItem；复用既有 Ingest、Run 和 Approval，不另建任务状态机，不写 Codex 状态数据库。
- 原型的服务上下文拥有执行进程，HTTP 页面断开不会取消任务。开始请求使用持久 operation key 去重；结果未知时禁止自动重发，服务重启也不自动重新执行旧 turn。
- 单一页面取得 90 秒控制租约，使用 epoch 拒绝旧写入者；同一时刻只允许一个受控 turn。交给电脑前要求本轮结束，释放并关闭原型的原生连接；之后手机不能自动抢回。
- 命令审批映射到既有 Approval，绑定 thread/turn/item、请求指纹和租约，只支持一次允许或拒绝。完整操作仅临时显示，不写原型状态文件；普通面板不能绕过控制租约批准原型请求。
- 工作交付由 Agent 明确调用 `ss_deliver`，只是 Agent 自述交付，进入 review 等用户处理。`turn/completed`、停止、CLI 退出都不自动交付或标已处理。用户已处理/放弃的工作不能由控制页悄悄重开。
- React 原型入口 `?view=native` 沿用小镇样式；结果可在同一个隔离服务的小镇中查看。普通小镇页面不默认增加控制按钮。

## 启动

使用现有 Go/npm 包装器、依赖与外置缓存；先在 `web` 构建，再构建独立命令。本项目没有新增依赖。

```sh
# 先在仓库的 web 目录执行 npm run build，再回仓库根目录。
go build -o /absolute/path/to/scratch/steward-native-prototype ./cmd/steward-native-prototype

/absolute/path/to/scratch/steward-native-prototype \
  --home /absolute/path/to/new-isolated-state \
  --workspace /absolute/path/to/authorized-test-workspace \
  --listen 127.0.0.1:18789
```

home 必须是隔离状态目录，不能指向正式 `.steward` 或它的子目录；workspace 建议选合成项目或专用 worktree，命令不会替用户隔离已有脏工作区。每个 home 只对应一条原生会话，交给电脑后想重新试验应使用新的隔离 home，保留旧数据。

打开 `http://127.0.0.1:18789/?view=native`，从该隔离 home 的 `native-control.token` 输入项目密钥。也可由本机用户打开含 `#control=<项目密钥>` 的 URL；页面随即移除 fragment，不使用查询参数或聊天传递密钥。密钥仅用于该实例/项目，重启会轮换。本机配对同样必须先持有密钥，远端不能换取普通面板 cookie。

原型不创建公网入口、不开启 Funnel、不改原 8443。`--remote-host` 只允许显式 `.ts.net` 私有主机名，**不配置网络**。真正手机访问需要另外明确安排隔离端口的私有代理与配对，当前没有替用户启用。

## 控制与恢复

1. 连接项目后点“接管此项目”，再交代任务。执行电脑与 workspace 始终可见，客户端不能覆盖运行器 argv、目录、模型配置或执行主机。
2. 关闭页面后，本机进程继续。重新打开只读回状态，不自动重发任务；租约过期可显式重新接管。
3. 正常空闲后重启原型，点“恢复同一条原生会话”可通过 `thread/resume` 恢复原 ID，随后再开始新一轮。若上次执行结果不明，先在电脑核对，不自动恢复执行。
4. 点“交给电脑接着做”先释放原型写入权；CLI 使用 `codex resume <原生 ID>`，桌面可尝试 `codex://threads/<原生 ID>`。打开应用不等于成功续接，分别验。
5. 小镇租约不锁住用户绕过本页面另开的所有 CLI/App 客户端。请按交接流程先释放；这不是跨所有原生客户端的全局互斥实现。

`ss_deliver` 的执行器由本原型提供。原生 CLI/App 在交接后是否继续支持该动态工具、后续交付能否回传此隔离服务，不能由同 ID 恢复直接推定。当前真实 CLI 验证只做不调用该工具的只读续接；外部客户端持续回传留给后续受控 hook/桥接接线，不改全局 hooks。

## 来源与能力映射

| 来源 | 小镇映射 | 已验证范围 |
| --- | --- | --- |
| 原生 thread 创建/恢复 | 同一 host＋codex＋thread ID；关联既有 Session/WorkItem | 合成测试；本机真实 API 恢复和两轮模型执行 |
| command/file item 开始/结束 | 工具活动或失败观察，按原生 item/turn 去重 | 合成与真实本机工具观察；不保留命令输出 |
| `turn/completed` | 本轮停止/失败/中断观察 | 合成与真实完成；不代表工作已处理 |
| `ss_deliver` | 明确的 Agent 交付，沿用既有 review | 合成与真实两轮交付；不写用户确认 |
| 命令审批 | 同次请求、指纹、原生 turn 与控制租约 | 合成验证；真实审批尚未触发 |
| 文件修改审批 | 信息不足时仅可拒绝 | 未实现完整允许链路，不冒称全面支持 |
| 其他原生请求/用户输入工具 | 返回不支持错误，不授予权限 | 合成边界；完整交互待后续 |
| 原生 CLI 续接 | 同一 thread ID，未注入摘要 | 本机真实只读续接；不代表桌面 App 原位续写 |
| 手机浏览器、官方桌面窗口 | 准备私有连接/深链和人工步骤 | 真实设备与桌面窗口待用户检查 |

目前 P1 尚未整合，因此沿用原 Event 结构，用 `RawName=CodexAppServer` 和本地控制审计标识原生观察；没有冒称统一渠道展示已经上线。后续整合必须兼容 P1/P3，不回退它们的隐私/排序规则。

## 数据与权限

没有拷贝登录、模型密钥或更改原工具配置。子进程以命令级参数关闭 hooks/plugins/apps/chronicle，避免本次隔离执行向正式小镇/其他插件重复回报；这些开关不写用户配置。工具使用明确 workspace-write、禁网络策略；这是原生沙箱语义，不宣称操作系统级完整读隔离。

SS 只持久化映射、幂等键、有限结构化审计和既有交付简报。不保存提示、回复正文、工具输出或完整审批内容到原型状态；Codex 自身通过官方接口管理其原生历史。配对接口、Host/Origin、Bearer、动作白名单和普通远程只读均有测试。控制能力仍需独立审查，不作为生产远控发布。

## Ekko 与官方来源

对照 Ekko Studio `ba84e38d20452b69059e2e2194f835505741ffd6`，package 版本 0.7.39。其 coding-agents service 耦合 profile、provider、workspace、session、run-manager，不是已确认可独立复制的 runner；其支持工具/模型名单不能直接当作 Codex 桌面互通证据。

本原型没有提取或分发 Ekko 代码/依赖；实现基于官方 Codex 协议与 SS 原有核心。Ekko 的 BSL 1.1 及个人非商业使用边界作为来源记录保留；未来任何代码复用或商用仍要按所选版本重新核对授权，AI 改写不能替代授权。

来源：[OpenAI app-server](https://learn.chatgpt.com/docs/app-server)、[Ekko 固定版本 service](https://github.com/EKKOLearnAI/ekko-studio/blob/ba84e38d20452b69059e2e2194f835505741ffd6/packages/server/src/modules/coding-agents/services/index.ts)、[Ekko 固定版本 LICENSE](https://github.com/EKKOLearnAI/ekko-studio/blob/ba84e38d20452b69059e2e2194f835505741ffd6/LICENSE)。本轮没有运行 REA，也没有搬入 Ekko 的 Vue/Koa/会话库。

## 尚未验证

官方桌面窗口原位续写、真实手机网络/配对、真实命令审批/停止、外部客户端后续交付回传以及完整断电/磁盘满演练未完成。本轮浏览器工具被 Work 设置禁用，没有新增页面截图；组件测试和 HTTP 成功不是视觉验收。

## 本轮验证记录

- Go 全仓普通与竞态各 588 项通过（含子用例），各 2 项可选检查跳过、0 失败，20 个包完成；go vet 通过。
- 前端 55 文件、430 项通过，生产构建成功；重建后的 dist 随源码提交。
- 真实本机：创建验证文件并读取、显式交付；正常重启隔离服务，按原 thread ID 恢复并完成第二轮，保留原 WorkItem；释放控制后原生 CLI 在同一 ID 只读续接，未注入摘要、未修改验证文件。
- Codex 应用后端能读取该 thread，不能据此认定桌面窗口可打开并续写。真实 CLI 续接最终 exit0、上下文核对成功，但期间出现 4 条 error 事件，简化证据未保留其具体原因；不将一次成功当作连接稳定性保证。
- 最终认证读回：无密钥请求和本机配对均 401，持有密钥的本机配对 200，不返回密钥；重启后保留交接状态且工作仍等用户处理。正式版本、hub 角色及四份受保护配置保持不变。

真实测试只在合成项目执行，原生 ID、运行数据、密钥和完整日志留在本地，不提交到仓库。开发候选上的真实执行与最终配对收紧后的自动回归/HTTP 读回分别记录；没有声称生产安装或用户已确认。

## 后续接入点

- Claude：沿用控制租约、项目授权和 Core 对象，但先按官方会话接口核对 native session、事件和审批语义。当前 Manager/RPC 是 Codex 专用，不能仅换执行文件就称为 Claude 适配。用户既有自定义服务地址、登录、模型配置和全局 hooks 不改，官方远控是否支持另验。
- Hermes：另做 profile＋原生会话身份的适配，不能把 Studio 会话、模型 provider 或一段摘要冒充 Hermes 原生会话。保留它的新历史、skills、长期记忆和暂停的旧任务；本轮没有触碰这些状态。
- 多工具公共层：独立审查后再提取 Driver 与标准化事件接口，复用本次权限/租约测试，与 D0/A0 契约对齐。此原型不抢先冻结公共协议或解除普通远程只读。

## PR #42 审查修订

本批仅修订隔离原型，不改变正式安装、普通远程只读或手机权限方案。

- `Start` 和 `Resume` 在锁内校验、保留请求并落盘，原生初始化、创建／恢复会话与发起本轮均在锁外等待；原生连接一建立即读取事件，状态查询和审批回调不会被漫长 RPC 挡住。
- RPC 返回后重新核对控制者、epoch 和操作身份；旧控制请求的迟到响应、审批 ready／结束回调及连接断开都不能改写新租约。未决请求遇到接管或未知结果保留 `uncertain`，不自动重发。
- 原生事件可能早于发起响应；交付、审批或本轮结束已经被观察到时，迟到的响应不再把它复活成运行中。
- 普通面板对原型审批的 `decide` 和 `dismiss` 均返回 409。没有指定私有主机时传入 nil，空 Host 即使遇到旧空白名单也被拒绝。
- 最终代码的 Go 普通／竞态各 603 项通过、各 2 项可选检查跳过；vet 通过。前端 430 项通过，两次构建一致，`web/dist` 没有漂移。测试均使用临时 HOME、STEWARD_HOME、CODEX_HOME 和合成数据。

独立复核额外覆盖了“早期审批尚在 ready 回调前发生接管”和“旧 RPC 等待期间旧连接断开”两个交错。这里的结果是开发自测，不是用户确认。

真实复测使用独立状态和合成项目，既有登录缓存仅作临时私有副本，结束即移除，原文件不用于运行。原生服务发回本轮 ID 可能早于实际执行，立即停止曾返回 `no active turn to interrupt`；连接模型服务时也观察到 TLS 握手中断与原生重连。真实发起、执行中取消和随后显式交付的结果另以本机本批验收记录为准，不用单元测试代替。没有为复测更改代理或网络。

手机能否批准命令、真实手机私网配对与官方桌面 App 接手仍分别等待用户决定或现场核对；官方 App 接手保持未知，未重复 CLI 续接测试。
