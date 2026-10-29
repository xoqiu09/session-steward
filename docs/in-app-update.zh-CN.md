# macOS App 内置升级

状态：本分支为本地候选，尚未推送、合并或发布。现有安装不受构建和测试影响。第一版只做用户触发的正式版检查和安装，不定时检查、不静默安装。

## 用户操作

App 菜单或菜单栏 → **检查更新**，看到当前版本/构建序号、新版本与说明 → **下载更新** → 进度到达校验完成 → **安装并重启**。下载和准备阶段继续采集。只有最后一次点击才会退出 App、短暂停止后台并替换文件。下载失败可以重试，每次重新完整下载，未校验的部分文件永远不参与安装。

旧的公开 v0.1.0 没有签名清单，不会被当成当前开发安装的升级。当前 git 提交与语义版本分开记录；构建序号只比较发布端独立维护的正整数，同时禁止语义主/次/修订版本回退。相同或较小序号、预发布、芯片不匹配、系统版本不足均不安装。当前 `0.2.0-dev.1 / 2026102901` 是候选标识，发布者可在正式发布前决定下一个正式版本及更大序号。

失败时显示原因并保留原安装；如果已经替换，安装助手会停止新版，恢复整组旧文件，重新启动并核对旧后台版本。若恢复自身失败或安装助手被强制终止，下次正常启动会在启动后台前显示“恢复旧版并重启”。更新记录在数据目录的 `updates/install-*/transaction.json`、`install.log` 和 `helper-output.log`。旧 App/程序保留在原目录旁的 `.steward-update-*/old`，完成后也不自动删除。

未完成事务可退出 App 后，用该事务目录内的 `steward-updater recover /完整路径/transaction.json` 重试恢复。不要编辑记录或搬动备份。升级助手互斥锁随进程退出释放。恢复只支持尚未完成的事务，不能把成功安装后继续使用的数据随意回退到旧发布。

## 服务和数据边界

- **App 自管后台**：App 正常退出会停止自己的子进程；安装后重新启动 App，由 App 使用原 `STEWARD_HOME` 启动后台。
- **共用 launchd**：只有带 Steward 标识、使用同一数据目录、标准标签及受支持二进制路径的服务可以更新。停止后按原 plist 重新加载；不重写 PATH、环境变量、登录项、启动参数或服务模式。手动启动或自定义目录的共用后台会明确拒绝，避免更新 App 后后台仍停留在旧版。
- 每次替换主 App，并同步已存在于数据目录 `bin/` 的 `steward`、`steward-hook` 和旧通知助手；它们与 App 内组件来自同一校验包。旧通知助手仅按精确安装路径停止。未安装的 hook 不擅自安装，不改 Claude/Codex hook 条目和信任状态。
- 不复制或替换数据库、token、hub 密钥、device ID、config、spool、Tailscale 设置或网络配置。hub/agent 角色继续从原配置读取。
- 第一版要求发布端 schema 与当前程序相同，保证旧程序能打开升级期间收到的新事件。跨 schema 升级一律拒绝，发行说明必须安排备份、迁移和兼容性验证；不会用旧快照覆盖新 hook 数据。未来即使 schema 数字不变，发布者仍需验证新代码没有引入旧版无法理解的数据写法。
- 下载先验签，再验证精确大小、SHA-256；解压限制为单一 App、普通文件/目录，拒绝路径穿越、符号链接、重复文件、设备文件和过量文件/解压大小。校验 App/nested code signatures、架构、版本、构建、提交与 schema，再把整组文件预先复制到各目标目录所在卷。准备期间磁盘不足不会停止后台。
- 点击安装时重新核对 App、稳定程序和配置快照，避免覆盖准备后发生的另一次更新/手工修改。所有重命名在目标卷内完成；逐个组件替换并非跨卷整体原子操作，因此使用持久事务记录和反向恢复。断电/文件系统损坏不能保证完全自动恢复，备份和恢复记录是必要的恢复入口。
- 安装目录须可写且不可为符号链接/运行中临时转置位置；不请求管理员权限、不更改系统保护。只对自己的安装文件操作，不涉及托管 Agent 会话的进程。

## 下载、签名与当前限制

固定入口是 [官方仓库最新 Release 的 update-manifest.json](https://github.com/xoqiu09/session-steward/releases/latest/download/update-manifest.json)。采用 GitHub [官方 latest/download 附件链接](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)，不依赖匿名 API 配额。下载仅允许 GitHub 与其发布附件域名的 HTTPS 重定向；无 GitHub token，不上传用户项目或配置。

清单为 `{"payload":"base64 JSON bytes","signature":"base64 Ed25519 signature"}`。发布者签名精确 payload 字节，不重编码后验签。App 内固定的 Ed25519 公钥通过构建参数注入，不从网络或配置目录接受新公钥。清单内含 format=1、version、build、40 位 commit、schema、min_macos、notes 和 arm64/amd64 的 URL/size/sha256。签名覆盖版本、说明、兼容信息和包哈希。安装包 URL 必须属于该仓库对应版本的附件目录。

**SHA256SUMS 是同源完整性校验，不是独立的发布者签名。** 固定公钥的 Ed25519 签名才是本协议的发布者真实性边界。公钥为空、错误或签名不匹配时关闭安装能力。首个启用升级的 App 必须由发布者通过现有安装流程分发并让用户确认它的公钥来源；不能靠从未签名网络响应中下载一个公钥建立信任。本地交付候选未配置生产公钥，因此不能直接进行生产内置安装。

当前是 ad-hoc 代码签名、未 Apple 公证。`codesign --verify` 只能检查包内签名完整性，不代表 Apple 验证开发者或 Gatekeeper 接受新版本。独立 Ed25519 签名也不能代替 Developer ID/公证。不同 macOS/Gatekeeper 情况可能拒绝启动新版；助手会尝试恢复旧版并记录失败。代码不清除 quarantine，不使用 `spctl` 绕过、修改信任或降低系统保护。正式面向常规用户承诺无手动干预的升级前，应完成 Developer ID 签名/公证、保留嵌套组件签名，并在目标系统真实验收。

调研过 [Sparkle 官方集成/签名要求](https://sparkle-project.org/documentation/) 与 [安全更新记录](https://sparkle-project.org/documentation/security-and-reliability/)：它是成熟方案，但新增依赖且不能单独解决本项目外部 bin、共用 launchd 与数据库恢复。当前用现有 Go 标准库与 AppKit 实现，未新增第三方依赖。Apple 分发条件参见 [Apple 官方说明](https://developer.apple.com/macos/distribution/)。本实现不是完整替代 Sparkle 的通用更新框架，后续仍需维护协议与恢复测试。

## 发布者接入

1. 自己保管已有/经授权建立的 **Ed25519 PKCS#8 PEM 私钥**，获取对应 32 字节公钥的标准 base64。工具不会生成生产私钥，不写 GitHub secrets，不上传私钥。建议离线签名；私钥只通过文件路径传给签名工具，不在命令行放内容。
2. 修改 `native/app/update-version.json` 的 version/build。序号必须严格递增且高于已分发的所有构建，不能由 Git 哈希、提交数或 CI 重跑号推导。正式 Release 使用 `v<version>` 标签；不要给预发布打 latest。
3. 用 `UPDATE_PUBLIC_KEY=<base64公钥>` 构建首个 bootstrap App 与之后所有 App。`UPDATE_BUILD` 可显式覆盖序号，正式发布应与受审版本文件一致。先验证 Go/race、前端、两个芯片 App 与真实安装环境，再保存发布提交。
4. 发布包示例（只构建，不发布）：

   ```sh
   UPDATE_PUBLIC_KEY='<base64公钥>' UPDATE_BUILD='<更大的整数>' \
     RELEASE_OUT='/完整外置盘路径/release' sh scripts/release.sh v0.2.0
   ```

5. 完成签名/公证和最终 ZIP 后，再离线签清单（不能签完清单又修改 App/ZIP）：

   ```sh
   UPDATE_PUBLIC_KEY='<同一公钥>' UPDATE_SIGNING_KEY_FILE='/私钥的受保护路径/key.pem' \
     go run ./cmd/steward-update-manifest -version v0.2.0 -build '<同一整数>' \
       -commit '<完整发布提交>' -dir '/最终附件目录' -notes '/更新说明.txt'
   ```

   签名工具检查私钥类型及其对应公钥，生成 `update-manifest.json`。`scripts/release.sh` 同时提供 UPDATE_SIGNING_KEY_FILE、UPDATE_NOTES_FILE 时也会在打包后执行此步骤；未提供签名身份时只生成手动下载包，明确不产生更新清单。公钥轮换暂不支持自动迁移，需要受信任的 bootstrap App，不允许清单自带替换公钥。
6. 人工检查并上传两种 `.app.zip`、SHA256SUMS、签名清单到**同一个待发布 Release**，确认精确版本 URL 后才标为正式最新发布。现有 CI 继续只创建草稿；不默认把私钥接入 CI，也不自动发布。本任务没有推送、打标签、创建 Release 或配置任何生产签名材料。

## 开发验证

运行 `go test ./...`、`go test -race ./...`、`go vet ./...`；`web/` 的 `npm test`、`npm run build`，确认已提交的 web/dist 没有漂移。`scripts/build-app.sh arm64` 和 `amd64` 构建两个候选，校验嵌套代码签名；Intel 运行仍须 Intel 设备验收。

`internal/updater` 用随机临时测试密钥、合成清单和本地 HTTP 服务测试篡改、错误签名、重放、版本/芯片/schema、下载中断和重试、zip 越界、替换中断、写入/启动/健康检查失败、整组恢复与数据保留。随机测试密钥只存在测试进程，不是生产私钥。

macOS 的真实程序/隔离服务验证需显式设置 `SS_UPDATE_TEST_BUNDLE` 指向刚构建的测试 App。用外置 Scratch 设置 TMPDIR。只有这项 opt-in 测试会临时创建独立标签的 LaunchAgent plist，结束后卸载并删除；不使用真实服务标签、不读取真实数据。测试服务的 plist 必须临时位于系统 LaunchAgents 目录（这是系统运行夹具，非报告或产物）；独立标签测试完成后卸载并删除。数据、App、程序和测试日志保留在指定外置 Scratch，合成库随测试目录清理。真实 launchd 参与，App 由测试父进程直接启动以继承已授予的外置卷访问，不弹出/批准新磁盘权限。正式 LaunchServices 重启受目标机器磁盘权限/Gatekeeper 影响，仍列为人工验收边界，不能把直接启动测试说成已通过该边界。

可复现命令：`sh scripts/test-app-update.sh /完整外置Scratch路径`。该脚本构建无生产公钥的隔离 App，运行两种模式的成功和失败恢复以及 Swift 配置读取超时测试。Swift 外壳读取配置超过 2 秒会显示问题并停止启动后台，避免权限/磁盘等待造成无响应。详细运行结果和局限见本轮交付报告。

只看窗口可设置隔离的 STEWARD_HOME 和 `STEWARD_UPDATE_UI_ONLY=1` 后运行候选的 `Contents/MacOS/SessionSteward`，此模式不启动后台和引导安装。不要直接运行普通候选去连接真实 `.steward` 做验收。完成首次生产 bootstrap、签名发布以及真实双芯片/Gatekeeper 验收之前，不能把本地自测写成用户已验收或线上升级成功。
