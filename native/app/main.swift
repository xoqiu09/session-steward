// Session Steward 的 macOS App 外壳：带着 steward 程序，负责启动后台服务、打开小镇窗口。
// 只连本机 127.0.0.1；面板 token 从数据目录读取，用来自动登录，从不显示。
// 只用 macOS 自带的 AppKit / WebKit，用 swiftc 直接编译（见 scripts/build-app.sh）。
import AppKit
import ServiceManagement
import WebKit

// MARK: - 后台服务

/// 管理 steward serve。App 自己启动的才归它管（退出时停掉）；已经有别的在跑时只共用，不另起一个。
final class Backend {
    let paths: Paths
    private(set) var child: Process?
    var owned: Bool { child != nil }

    init(paths: Paths) { self.paths = paths }

    /// 面板是否在响应（任何 HTTP 回应都算，包括 401）。
    func isUp(timeout: TimeInterval = 1) -> Bool {
        var req = URLRequest(url: paths.base.appendingPathComponent("api/version"))
        req.timeoutInterval = timeout
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            ok = resp is HTTPURLResponse
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + timeout + 0.5)
        return ok
    }

    /// 启动 steward serve，日志写到数据目录的 logs/app-serve.log。
    func start() throws {
        let logs = paths.home.appendingPathComponent("logs")
        try FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let logURL = logs.appendingPathComponent("app-serve.log")
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(atPath: logURL.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let log = try FileHandle(forWritingTo: logURL)
        _ = try? log.seekToEnd()
        let p = Process()
        p.executableURL = paths.steward
        p.arguments = ["serve"]
        p.environment = ProcessInfo.processInfo.environment.merging(["STEWARD_HOME": paths.home.path]) { _, new in new }
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                if self?.child === proc { self?.child = nil }
                NotificationCenter.default.post(name: .backendStopped, object: nil)
            }
        }
        try p.run()
        child = p
    }

    func stop() {
        guard let p = child else { return }
        child = nil
        p.terminate()
        p.waitUntilExit()
    }

    /// 等面板起来、token 文件出现。
    func waitReady(seconds: Double = 15) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if isUp(timeout: 0.5), paths.token() != nil { return true }
            Thread.sleep(forTimeInterval: 0.3)
        }
        return false
    }

    /// 运行 App 里带的 steward 子命令（install、uninstall、service …），返回退出码和输出。
    @discardableResult
    func run(_ args: [String]) -> (Int32, String) {
        let p = Process()
        p.executableURL = paths.steward
        p.arguments = args
        p.environment = ProcessInfo.processInfo.environment.merging(["STEWARD_HOME": paths.home.path]) { _, new in new }
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do { try p.run() } catch { return (-1, error.localizedDescription) }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return (p.terminationStatus, String(decoding: data, as: UTF8.self))
    }
}

extension Notification.Name {
    static let backendStopped = Notification.Name("SessionStewardBackendStopped")
}

// MARK: - 窗口

private final class SnapshotReceiver: NSObject, WKScriptMessageHandler {
    weak var owner: TownWindow?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        owner?.receiveSnapshot(message)
    }
}

final class TownWindow: NSObject, WKNavigationDelegate, NSWindowDelegate {
    let window: NSWindow
    let web: WKWebView
    let paths: Paths
    var onSnapshot: (([String: Any]) -> Void)?
    private let receiver = SnapshotReceiver()

    init(paths: Paths) {
        self.paths = paths
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.add(receiver, name: "stewardSnapshot")
        web = WKWebView(frame: .zero, configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        receiver.owner = self
        window.title = "Session Steward"
        window.contentView = web
        window.setFrameAutosaveName("SessionStewardMain")
        window.isReleasedWhenClosed = false
        window.delegate = self
        web.navigationDelegate = self
        if window.frame.origin == .zero { window.center() }
    }

    /// 小镇世界地图、工作室（桌面模式）和每日十分钟的入口。
    static let world = PanelNavigation.world
    static let studio = "/?view=town&kiosk=1"
    static let today = "/?view=today"

    /// 用 token 自动登录，然后直接打开小镇世界地图。token 只在这一次请求里用，不显示。
    func open(path: String = TownWindow.world) {
        guard let token = paths.token() else { showMessage("还没拿到面板登录信息，服务可能没有启动。"); return }
        var c = URLComponents(url: paths.base.appendingPathComponent("login"), resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "t", value: token), URLQueryItem(name: "next", value: path)]
        web.load(URLRequest(url: c.url!))
        show()
    }

    func show() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    fileprivate func receiveSnapshot(_ message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url,
              url.scheme == "http", url.host == paths.base.host, url.port == paths.base.port,
              let snapshot = message.body as? [String: Any], snapshot["cursor"] is NSNumber,
              snapshot["work_items"] is [[String: Any]], snapshot["approvals"] is [[String: Any]],
              JSONSerialization.isValidJSONObject(snapshot),
              let data = try? JSONSerialization.data(withJSONObject: snapshot), data.count <= 2_000_000 else { return }
        onSnapshot?(snapshot)
    }

    func refreshWhenActive() {
        web.evaluateJavaScript("window.dispatchEvent(new Event('steward:foreground'))", completionHandler: nil)
    }

    func showMessage(_ text: String) {
        let html = "<html><body style='font:15px -apple-system;color:#5a4a36;background:#f6f1e7;display:flex;align-items:center;justify-content:center;height:90vh'><p>\(text)</p></body></html>"
        web.loadHTMLString(html, baseURL: nil)
        show()
    }

    // 只在窗口里打开本机面板；其他链接交给系统浏览器。
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if url.scheme == "about" || (url.host == paths.base.host && url.port == paths.base.port) {
            return decisionHandler(.allow)
        }
        if action.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    // 关窗口只是隐藏，App 继续在后台采集。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}

// MARK: - Hooks 与首次引导

enum Hooks {
    static var home: URL { URL(fileURLWithPath: NSHomeDirectory()) }
    static let files = ["~/.claude/settings.json", "~/.codex/hooks.json"]

    /// 是否已经装过 Steward 的 hooks（看两个配置文件里有没有 steward-hook）。
    static func installed() -> Bool {
        for rel in [".claude/settings.json", ".codex/hooks.json"] {
            if let text = try? String(contentsOf: home.appendingPathComponent(rel), encoding: .utf8), text.contains("steward-hook") { return true }
        }
        return false
    }

    /// GUI App 拿不到终端的 PATH，按常见位置找 tmux。
    static func hasTmux() -> Bool {
        ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].contains { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static let explain = """
    要看到你自己的小镇，需要让 Claude Code / Codex 把会话情况告诉本机的 Session Steward。会做这些事：

    • 在 \(files.joined(separator: " 和 ")) 里追加 Steward 自己的几条 hooks。改之前会先备份，只增删自己的条目，以后可以在菜单栏里一键卸载。
    • 把 steward-hook 复制到数据目录的 bin 里，hooks 调用的是这一份。

    数据只留在这台电脑上：只监听 127.0.0.1，不上传任何东西。
    """
}

extension AppDelegate {
    /// 首次打开：说明要改哪些文件，同意才装；然后问要不要开机启动，并提示 tmux。
    func onboardIfNeeded() {
        if (ProcessInfo.processInfo.environment["STEWARD_UPDATE_NO_ONBOARD"] == "1" || ProcessInfo.processInfo.arguments.contains("--update-no-onboard")),
           paths.home.standardizedFileURL.path != FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".steward").path { return }
        let key = pref("onboarded")
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        if Hooks.installed() { return } // 已经用命令行装过，不打扰
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "欢迎使用 Session Steward"
        a.informativeText = Hooks.explain
        a.addButton(withTitle: "安装 hooks 并开始")
        a.addButton(withTitle: "先不装，只看看")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        installHooks(confirm: false)
    }

    @objc func installHooksMenu() { installHooks(confirm: true) }

    func installHooks(confirm: Bool) {
        if confirm {
            let a = NSAlert()
            a.messageText = "给 Claude Code / Codex 安装 hooks？"
            a.informativeText = Hooks.explain
            a.addButton(withTitle: "安装")
            a.addButton(withTitle: "取消")
            guard a.runModal() == .alertFirstButtonReturn else { return }
        }
        let (code, out) = backend.run(["install"])
        let done = NSAlert()
        if code == 0 {
            done.messageText = "hooks 装好了"
            var notes = ["之后新开的 Claude Code / Codex 会话会出现在小镇里。"]
            if out.contains("Codex") || out.contains("codex") { notes.append("Codex 需要在它自己的应用里确认（信任）新的 hooks 才会生效。") }
            if !Hooks.hasTmux() { notes.append("没检测到 tmux：在面板里直接开托管会话的功能不可用，其他功能照常。") }
            done.informativeText = notes.joined(separator: "\n\n")
            let box = NSButton(checkboxWithTitle: "开机时自动启动 Session Steward", target: nil, action: nil)
            box.state = SMAppService.mainApp.status == .enabled ? .on : .off
            done.accessoryView = box
            done.addButton(withTitle: "好")
            done.runModal()
            let want = box.state == .on, now = SMAppService.mainApp.status == .enabled
            if want != now { status?.toggleLogin() }
        } else {
            done.messageText = "安装 hooks 没有成功"
            done.informativeText = out.isEmpty ? "steward install 退出码 \(code)" : out
            done.runModal()
        }
        status?.refreshHooks()
    }

    @objc func uninstallHooksMenu() {
        let a = NSAlert()
        a.messageText = "卸载 Steward 的 hooks？"
        a.informativeText = "只删除 Steward 自己加在 \(Hooks.files.joined(separator: " 和 ")) 里的条目，其他设置不动。之后新的会话不会再出现在小镇里；已有的记录保留。"
        a.addButton(withTitle: "卸载")
        a.addButton(withTitle: "取消")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let (code, out) = backend.run(["uninstall"])
        let done = NSAlert()
        done.messageText = code == 0 ? "hooks 已卸载" : "卸载没有成功"
        done.informativeText = code == 0 ? "想停止后台采集，可以在菜单栏选“退出并停止采集”。" : out
        done.runModal()
        status?.refreshHooks()
    }
}

// MARK: - 菜单栏

/// 菜单栏小图标：显示“等你决定”的数量（待处理的审批），每 10 秒向本机面板问一次。
/// 新审批的系统通知仍由 steward 自己发（通过 App 里带的通知助手），这里不重复发。
final class StatusMenu: NSObject {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let paths: Paths
    let onOpen: (String) -> Void
    private var timer: Timer?
    private let countItem = NSMenuItem(title: "等你决定：—", action: nil, keyEquivalent: "")
    private let loginItem = NSMenuItem(title: "开机时启动", action: nil, keyEquivalent: "")
    private let hooksItem = NSMenuItem(title: "安装 hooks…", action: nil, keyEquivalent: "")
    private let reminderItem = NSMenuItem(title: "显示顶部提醒（刘海 / 浮层）", action: nil, keyEquivalent: "")
    private var polling = false
    private var pollAgain = false
    private var version = SnapshotVersion()
    private var generation = 0
    private var lastWebSnapshot = Date.distantPast
    weak var app: AppDelegate?
    private(set) var pending = -1

    init(paths: Paths, onOpen: @escaping (String) -> Void) {
        self.paths = paths
        self.onOpen = onOpen
        super.init()
        item.button?.image = NSImage(systemSymbolName: "house", accessibilityDescription: "Session Steward")
        item.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        countItem.action = #selector(openQueue)
        countItem.target = self
        menu.addItem(countItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "打开小镇", action: #selector(openTown), keyEquivalent: "").target = self
        menu.addItem(withTitle: "打开工作室", action: #selector(openStudio), keyEquivalent: "").target = self
        menu.addItem(withTitle: "每日十分钟", action: #selector(openToday), keyEquivalent: "").target = self
        menu.addItem(withTitle: "打开完整面板", action: #selector(openPanel), keyEquivalent: "").target = self
        reminderItem.action = #selector(toggleReminder)
        reminderItem.target = self
        menu.addItem(reminderItem)
        menu.addItem(withTitle: "发送测试提醒", action: #selector(testNotification), keyEquivalent: "").target = self
        menu.addItem(.separator())
        loginItem.action = #selector(toggleLogin)
        loginItem.target = self
        menu.addItem(withTitle: "检查更新…", action: #selector(AppDelegate.checkUpdates), keyEquivalent: "").target = NSApp.delegate
        menu.addItem(loginItem)
        hooksItem.target = self
        hooksItem.action = #selector(hooksAction)
        menu.addItem(hooksItem)
        menu.addItem(.separator())
        quitItem = menu.addItem(withTitle: "退出并停止采集", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        item.menu = menu
        refreshLoginItem()
        refreshReminder()
        poll()
    }

    private var quitItem: NSMenuItem?
    @objc func toggleReminder() { app?.toggleTopReminder() }
    @objc func testNotification() { app?.sendTestNotification() }

    func refreshReminder() {
        let enabled = app?.topReminderEnabled ?? false
        reminderItem.state = enabled ? .on : .off
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: enabled ? 3 : 10, repeats: true) { [weak self] _ in self?.poll() }
    }
    func setShared(_ shared: Bool) {
        quitItem?.title = shared ? "退出（后台服务由命令行版本管理，不会停止）" : "退出并停止采集"
    }

    @objc func hooksAction() {
        if Hooks.installed() { app?.uninstallHooksMenu() } else { app?.installHooksMenu() }
    }

    func refreshHooks() {
        hooksItem.title = Hooks.installed() ? "卸载 hooks…" : "安装 hooks…"
    }

    @objc func openTown() { onOpen(TownWindow.world) }
    @objc func openStudio() { onOpen(TownWindow.studio) }
    @objc func openToday() { onOpen(TownWindow.today) }
    @objc func openPanel() { onOpen("/") }
    // 菜单栏“等你决定：N”：直接打开每日十分钟，一页处理完
    @objc func openQueue() { onOpen(TownWindow.today) }

    /// 开机时启动：由 App 自己登记为登录项（代替单独装的 launchd 服务）。
    @objc func toggleLogin() {
        let svc = SMAppService.mainApp
        do {
            if svc.status == .enabled { try svc.unregister() } else { try svc.register() }
        } catch {
            let a = NSAlert()
            a.messageText = "没能修改开机启动"
            a.informativeText = "\(error.localizedDescription)\n可以在“系统设置 → 通用 → 登录项”里手动添加 Session Steward。"
            a.runModal()
        }
        refreshLoginItem()
    }

    func refreshLoginItem() {
        let st = SMAppService.mainApp.status
        loginItem.state = st == .enabled ? .on : .off
        loginItem.title = st == .requiresApproval ? "开机时启动（等你在系统设置里同意）" : "开机时启动"
    }

    /// 读快照里待处理的审批数。拿不到（服务没起来、没登录信息）时显示“—”。
    func consumeSnapshot(_ snapshot: [String: Any], fromWeb: Bool = false) {
        guard version.accept(snapshot) else { return }
        if fromWeb {
            lastWebSnapshot = Date()
            if snapshot["reset"] as? Bool == true { generation += 1 }
        }
        let approvals = snapshot["approvals"] as? [[String: Any]] ?? []
        show(approvals.filter { $0["status"] as? String == "pending" }.count)
        app?.updateAttention(AttentionState.snapshot(snapshot))
        app?.noticeReconciler.update(snapshot)
    }

    func poll(force: Bool = false) {
        if polling { if force { pollAgain = true }; return }
        if !force && Date().timeIntervalSince(lastWebSnapshot) < 8 { return }
        guard let token = paths.token() else { app?.updateAttention(AttentionState()); return show(nil) }
        polling = true
        let started = generation
        let requestedAt = Date()
        var req = URLRequest(url: paths.base.appendingPathComponent("api/snapshot"))
        req.timeoutInterval = 5
        req.setValue("steward_panel=\(token)", forHTTPHeaderField: "Cookie")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            var snapshot: [String: Any]?
            if (resp as? HTTPURLResponse)?.statusCode == 200, let data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                snapshot = obj
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.polling = false
                if started == self.generation, let snapshot { self.consumeSnapshot(snapshot) }
                else if snapshot == nil && self.lastWebSnapshot < requestedAt {
                    self.show(nil); self.app?.updateAttention(AttentionState())
                }
                if self.pollAgain { self.pollAgain = false; self.poll(force: true) }
            }
        }.resume()
    }

    func show(_ n: Int?) {
        pending = n ?? -1
        let title = n.map { $0 > 0 ? " \($0)" : "" } ?? " —"
        item.button?.attributedTitle = NSAttributedString(string: title, attributes: [
            .foregroundColor: (n ?? 0) > 0 ? NSColor.systemOrange : NSColor.labelColor,
            .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold),
        ])
        refreshHooks()
        countItem.title = n.map { $0 > 0 ? "等你决定：\($0) 项（点开处理）" : "没有等你决定的事" } ?? "等你决定：—（服务没在运行）"
        refreshLoginItem()
    }
}

// MARK: - App

/// 偏好按数据目录分开记：用临时数据目录测试时，不影响正式使用时的首次引导和共存选择。
func pref(_ name: String) -> String {
    let home = Paths.load().home.standardizedFileURL.path
    let def = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".steward").standardizedFileURL.path
    return home == def ? name : "\(name)@\(home)"
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    let paths = Paths.load()
    lazy var backend = Backend(paths: paths)
    lazy var town = TownWindow(paths: paths)
    lazy var noticeChannel = NativeNoticeChannel(home: paths.home, helper: Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/Session Steward.app"))
    lazy var noticeReconciler = NativeNoticeReconciler(channel: noticeChannel)
    var status: StatusMenu?
    var mode: Mode = .own
    var installingUpdate = false
    lazy var updates = UpdateWindow(app: self)
    @objc func checkUpdates() { updates.show() }
    private var navigation = PanelNavigation()
    private var attention: AttentionSurface?
    var topReminderEnabled: Bool { UserDefaults.standard.bool(forKey: pref("topReminderEnabled")) }

    func toggleTopReminder() {
        UserDefaults.standard.set(!topReminderEnabled, forKey: pref("topReminderEnabled"))
        configureAttention()
        status?.poll()
    }

    private func configureAttention() {
        if attention == nil && topReminderEnabled {
            attention = AttentionSurface { [weak self] path in self?.town.open(path: path) }
        }
        attention?.setEnabled(topReminderEnabled)
        status?.refreshReminder()
    }

    func updateAttention(_ state: AttentionState) { attention?.update(state) }

    @objc func showTopReminder() {
        if !topReminderEnabled { toggleTopReminder() }
        attention?.showExpanded()
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            guard let target = PanelTarget.fromIncomingURL(url, base: paths.base, scheme: panelURLScheme(in: Bundle.main) ?? "session-steward") else { continue }
            if let path = navigation.receive(target) { town.open(path: path) }
        }
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        // Isolated UI validation never touches onboarding, hooks or a backend.
        if ProcessInfo.processInfo.environment["STEWARD_UPDATE_UI_ONLY"] == "1",
           paths.home.standardizedFileURL.path != FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".steward").path {
            buildMainMenu(); updates.show(); return
        }
        if let error = paths.configurationError {
            buildMainMenu(); town.showMessage(error); return
        }
        // 已经开着一个 App：把它叫到前面，自己退出，避免两个 App 抢着管后台服务
        let mine = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
        if let other = mine.first(where: { $0 != NSRunningApplication.current }) {
            other.activate()
            NSApp.terminate(nil)
            return
        }
        buildMainMenu()
        status = StatusMenu(paths: paths) { [weak self] path in self?.town.open(path: path) }
        status?.app = self
        town.onSnapshot = { [weak self] snapshot in self?.status?.consumeSnapshot(snapshot, fromWeb: true) }
        configureAttention()
        NotificationCenter.default.addObserver(forName: .backendStopped, object: nil, queue: .main) { [weak self] _ in self?.backendStopped() }
        updates.inspectRecovery()
        if updates.recovery { updates.show(); return }
        updates.observeInstallation()
        startBackend()
    }

    /// 和命令行版本共存：同一个数据目录只能有一个 steward serve。
    /// 已有命令行的开机服务（或别处已在运行）时先问：接管，还是只当窗口共用。选择记在偏好里。
    enum Mode { case own, shared }
    var cliPlist: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/io.github.xoqiu09.session-steward.plist") }

    /// 命令行版的开机服务是否用的是同一个数据目录（只有那样才会冲突）。
    func cliUsesSameData() -> Bool {
        guard let plist = NSDictionary(contentsOf: cliPlist) else { return false }
        let env = plist["EnvironmentVariables"] as? [String: String] ?? [:]
        let theirs = env["STEWARD_HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".steward")
        return theirs.standardizedFileURL.path == paths.home.standardizedFileURL.path
    }

    func decideMode() -> Mode {
        let hasCLI = cliUsesSameData()
        let up = backend.isUp()
        if !hasCLI && !up { return .own }
        if !hasCLI && up {
            // 别处手动跑着 steward serve（或另一个数据目录的服务占着端口）：只能共用，不另起
            return .shared
        }
        let key = pref("coexist")
        if let saved = UserDefaults.standard.string(forKey: key) { return saved == "takeover" ? takeOver() : .shared }
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = "这台电脑上已经装了命令行版的 Session Steward"
        a.informativeText = """
        它作为开机服务在后台运行\(up ? "（现在正在运行）" : "")，和 App 用的是同一份数据。两个不能同时运行。

        • 接管：停掉并移除命令行版的开机服务，以后由 App 负责后台采集和开机启动。数据和 hooks 不动。
        • 共用：命令行服务继续运行，App 只当窗口和菜单栏用；退出 App 不会停止采集。
        """
        a.addButton(withTitle: "接管")
        a.addButton(withTitle: "共用")
        let takeover = a.runModal() == .alertFirstButtonReturn
        UserDefaults.standard.set(takeover ? "takeover" : "share", forKey: key)
        return takeover ? takeOver() : .shared
    }

    /// 移除命令行版的开机服务，等端口空出来再由 App 启动自己的。失败就退回共用。
    func takeOver() -> Mode {
        let (code, out) = backend.run(["service", "uninstall"])
        if code != 0 {
            let a = NSAlert()
            a.messageText = "没能停掉命令行版的服务，先共用它"
            a.informativeText = out
            a.runModal()
            return .shared
        }
        let deadline = Date().addingTimeInterval(10)
        while backend.isUp(timeout: 0.5), Date() < deadline { Thread.sleep(forTimeInterval: 0.3) }
        return backend.isUp(timeout: 0.5) ? .shared : .own
    }

    func startBackend() {
        navigation.restarting()
        town.showMessage("正在启动 Session Steward…")
        mode = decideMode()
        status?.setShared(mode == .shared)
        DispatchQueue.global().async { [self] in
            if mode == .own, !backend.isUp() {
                do { try backend.start() } catch {
                    DispatchQueue.main.async { self.town.showMessage("启动后台服务失败：\(error.localizedDescription)") }
                    return
                }
            }
            let ready = backend.waitReady()
            DispatchQueue.main.async {
                self.status?.poll()
                if ready { self.town.open(path: self.navigation.backendReady()); self.onboardIfNeeded() }
                else if self.mode == .shared { self.town.showMessage("命令行版的服务现在没有响应（\(self.paths.listen)）。可以在终端运行 steward service restart，或在菜单里“重新启动服务”时选择接管。") }
                else { self.town.showMessage("后台服务没有在 \(self.paths.listen) 启动，日志在 \(self.paths.home.path)/logs/app-serve.log。") }
            }
        }
    }

    func backendStopped() {
        if installingUpdate { return }
        // App 自己的服务意外退出：提示，不自动无限重启。
        town.showMessage("后台服务已停止。可以从菜单“文件 → 重新启动服务”再试，日志在 \(paths.home.path)/logs/app-serve.log。")
    }

    @objc func reopenTown() { town.open() }
    @objc func reopenStudio() { town.open(path: TownWindow.studio) }
    @objc func reopenToday() { town.open(path: TownWindow.today) }
    @objc func restartBackend() {
        // 共用模式下重启：清掉记住的选择，重新问一次（可以改成接管）
        if mode == .shared { UserDefaults.standard.removeObject(forKey: pref("coexist")) }
        backend.stop(); startBackend()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { town.show() }
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        status?.poll(force: true)
        town.refreshWhenActive()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ note: Notification) {
        updates.cancelDownload()
        attention?.setEnabled(false)
        backend.stop() // 只停 App 自己启动的服务
    }

    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Session Steward", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(withTitle: "检查更新…", action: #selector(checkUpdates), keyEquivalent: "").target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出并停止采集", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "文件")
        fileMenu.addItem(withTitle: "打开小镇", action: #selector(reopenTown), keyEquivalent: "1").target = self
        fileMenu.addItem(withTitle: "打开工作室", action: #selector(reopenStudio), keyEquivalent: "2").target = self
        fileMenu.addItem(withTitle: "每日十分钟", action: #selector(reopenToday), keyEquivalent: "3").target = self
        fileMenu.addItem(withTitle: "展开顶部提醒", action: #selector(showTopReminder), keyEquivalent: "4").target = self
        fileMenu.addItem(withTitle: "发送测试提醒", action: #selector(sendTestNotification), keyEquivalent: "").target = self
        fileMenu.addItem(withTitle: "重新启动服务", action: #selector(restartBackend), keyEquivalent: "").target = self
        fileMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        main.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "显示")
        viewMenu.addItem(withTitle: "重新载入", action: #selector(WKWebView.reload(_:)), keyEquivalent: "r")
        viewItem.submenu = viewMenu
        main.addItem(viewItem)
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
// 被 kill / 关机时也走正常退出，停掉自己启动的服务，不留孤儿进程。
signal(SIGTERM, SIG_IGN)
let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termSource.setEventHandler { NSApp.terminate(nil) }
termSource.resume()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
