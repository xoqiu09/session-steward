# 通知直达与顶部提醒

目标：点击 macOS 右上角的 SS 通知后，直接唤起 Session Steward，打开通知对应的工作项、审批所属工作项或会话。顶部提醒提供同样的入口，不执行批准、验收或命令。

## 已定位的两处缺口

1. 共用后台模式运行的是数据目录 `bin/steward`，旧代码只在它旁边寻找通知助手。App 内虽然带着助手，后台仍可能找不到而退回普通 AppleScript 横幅。这个回退渠道没有 SS 的点击回调。
2. 原生助手已有 `UNUserNotificationCenterDelegate`，但点击后只用默认浏览器打开 HTTP 地址。主 App 没有链接接收入口，也没有保存冷启动过程中的目标。

## 通知导航方案与实现

- 后台优先使用与自己配套的助手，并能发现 `/Applications` 或用户 `Applications` 中 App 内嵌的助手。
- 传入通知的内容仍只有类别、编号和本机记录链接，不含登录 token、命令或对话内容。
- 点击系统横幅或“查看详情”后，助手显式打开配套主 App。它优先寻找包含自己的 App，再按已知 App 标识寻找安装位置，避免测试预览唤起另一份正式 App。
- 主 App 注册 `session-steward` 链接，只接受 `item`、`approval`、`session` 三种编号，且端口必须匹配自己的本地服务。远程地址、凭据、API 路径、重复或多余参数均不接受。
- 主 App 继续使用自己本地保存的面板登录信息。收到链接时，已经就绪则立即导航；尚在启动则保存最后一次点击，服务就绪后打开该记录，默认世界入口不会覆盖它。
- 记录详情继续使用现有网页路由和权限检查。审批通知落到对应工作项；无工作项时落到会话。整个导航不会改变审批或验收状态。
- 纯命令行安装没有支持链接的主 App 时，保留原来的本机浏览器入口。

## 顶部提醒的交互

菜单栏 SS →“显示顶部提醒（刘海 / 浮层）”开关，默认关闭。也可以按 `⌘4` 主动展开并聚焦提醒；`Esc` 收起。

- MacBook 有刘海时，使用 `NSScreen.safeAreaInsets`、`auxiliaryTopLeftArea`、`auxiliaryTopRightArea` 得到摄像头遮挡宽度和位置；内容让开摄像头区域。
- 普通显示器在菜单栏下方显示紧凑小条。显示器重连和布局改变时重新计算，不假设主屏原点一定是 `(0, 0)`。
- 以原生非激活 `NSPanel` 承载 SwiftUI。悬停不切换当前工作 App，主动点条目才唤起 SS 对应详情。通过菜单或键盘主动展开时可获得焦点，支持按钮辅助功能和 `Esc`。
- 收起时只显示 SS 和待处理条数；展开后最多显示三条，按正式决定、受阻、待验收排列，其余通过“每日十分钟”查看。决定与交付验收分开计数。
- 自动历史、已暂停、已转交、已验收和已归档项目不会重新列成普通待办。仍然有效的工具权限或决定请求保留其正式请求身份。
- 悬停进入延迟 180ms、离开延迟 350ms，避免经过菜单栏时反复展开。窗口在 280ms 内平滑变形，内容使用短弹簧过渡；系统“减少动态效果”开启后不执行这两种动画。
- 开启顶部提醒时复用现有快照请求，每 3 秒更新；关闭时恢复原有 10 秒菜单栏更新。请求进行中不叠加另一轮请求。没有常驻动画循环。
- 离线显示连接提示，不把旧数据或失败请求解释为“没有待办”。

视觉沿用 macOS 系统字体、黑色刘海背景、SS 的紫色强调色与琥珀色待决定标记。交互方案遵循本机默认 baoyu-design 标准，并沿用 AppKit / SwiftUI 技术栈。

## 调研来源

本轮核对公开源码与 Apple 文档，独立实现 SS 的导航和提醒组件，没有导入其他项目的 Agent 采集、批准操作或保活设置。

- [Agent Notch：NotchController](https://github.com/Forichok/Agent-Notch/blob/70dd0cb81f0406affb817a916ee5e58a3b40a9e4/Sources/AgentsNotch/NotchController.swift)：刘海几何、原生浮层、无刘海的菜单栏回退。
- [AgentNotch：系统通知回调](https://github.com/Aforno/AgentNotch/blob/3606bf0dd2ada56e7bf0cfef9bd9ce5b194d3811/Sources/AgentsNotch/Services/AgentNotificationService.swift)：通知保存会话标识，点击回调再打开具体会话。
- [AgentNotch：NotchRootView](https://github.com/Aforno/AgentNotch/blob/3606bf0dd2ada56e7bf0cfef9bd9ce5b194d3811/Sources/AgentsNotch/UI/Notch/NotchRootView.swift)：展开状态、悬停防抖、弹簧过渡与减少动态效果。
- [Apple：在指定 App 中打开 URL](https://developer.apple.com/documentation/appkit/nsworkspace/open(_:withapplicationat:configuration:completionhandler:))。
- [Apple：safeAreaInsets](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets)、[auxiliaryTopLeftArea](https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytopleftarea-uglc)。
- 用户提到的项目已核对为 [morluto/rea — Reverse Engineer Anything](https://github.com/morluto/rea)。本轮没有安装或运行 REA；目标实现的公开源码足以核对上述链路，没有进行二进制逆向。

源码来源提交和文件映射另见 [notification-research-github.md](notification-research-github.md)。

## 验证方法与边界

`sh scripts/test-native.sh` 检查链接范围、冷暖启动顺序、宿主 App 选择、状态筛选和非零原点的多屏几何，不启动服务或写入业务数据。

`sh scripts/build-attention-preview.sh <输出目录>` 构建使用独立应用标识的合成数据预览，只运行提醒界面，不读取真实小镇配置，也不占用 7788。

实际安装后，可在 SS 菜单栏选择“发送测试提醒”。它选取一条已有工作项，发送只含编号的测试通知，点击只查看。分别验证主 App 已打开，以及退出主 App 后点击通知的情况；共用后台模式下退出 App 不停止中心机。

更新之前由普通横幅生成的旧通知不会自动获得点击动作；使用更新后新产生的提醒验证。

这台 Mac Studio 能验证普通显示器浮层和系统通知。MacBook 的实体刘海、多屏热插拔和全屏使用体验仍应在对应硬件上检查；几何单元检查不能代替硬件验收。生产签名、公证和内置升级不在本轮改动中。
