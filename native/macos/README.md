# Steward 系统通知

使用 macOS 内置 AppKit / UserNotifications 和已有 Steward 图标，无第三方依赖。构建：`make notifier`；将生成的 `bin/Session Steward.app` 和 `bin/steward` 放在一起。源码、图标和脚本可跨设备重建，生成的应用不进入 Git。

默认横幅，无 Dock 主窗口和阻塞对话框。首次运行需系统通知授权。每条通知的 `userInfo` 绑定自己的本机 URL，点击使用系统默认浏览器打开；不读面板 token，不调用审批/验收 API。已验收工作项打开后保持已验收，不会重新显示验收按钮。

Go 端向私有 `~/.steward/notifications` 写入短暂的 0600 请求文件，通过 LaunchServices 打开通知助手；助手校验文件和本机 URL，再交给系统。Go 等待的是系统排队回执，绝不等待用户点击。排队/打开审计只记录类别、时间和哈希 ID，不记录正文、命令或 token。普通通知发送失败也不改工作项状态，面板队列仍保留。

本机可显式运行只读桌面探针：设置 `STEWARD_NOTIFICATION_TEST_APP` 为应用绝对路径，运行 `go test ./internal/notify -run '^TestNativeNotificationLive$' -count=1 -v`。它只发送一条注明只读的 STW-001 跳转测试，不写数据库或替用户验收；通常测试不设置此环境变量。

实现依据：[Apple 通知响应回调](https://developer.apple.com/documentation/usernotifications/unusernotificationcenterdelegate/usernotificationcenter(_:didreceive:withcompletionhandler:))、[AppKit 应用代理](https://developer.apple.com/documentation/appkit/nsapplicationdelegate)。
