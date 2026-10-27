// Session Steward 的 macOS App 外壳：带着 steward 程序，负责启动后台服务、打开小镇窗口。
// 只连本机 127.0.0.1；面板 token 从数据目录读取，用来自动登录，从不显示。
// 只用 macOS 自带的 AppKit / WebKit，用 swiftc 直接编译（见 scripts/build-app.sh）。
import AppKit
import ServiceManagement
import WebKit

// MARK: - 路径与配置

struct Paths {
    /// 数据目录：和命令行版本一样，STEWARD_HOME 优先，否则 ~/.steward。
    let home: URL
    /// App 里带的 steward 程序。
    let steward: URL
    /// 面板地址（来自 config.json 的 listen，缺省 127.0.0.1:7788）。
    let listen: String

    static func load() -> Paths {
        let env = ProcessInfo.processInfo.environment
        let home = env["STEWARD_HOME"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".steward")
        var listen = "127.0.0.1:7788"
        if let data = try? Data(contentsOf: home.appendingPathComponent("config.json")),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let l = obj["listen"] as? String, !l.isEmpty {
            listen = l
        }
        let steward = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/steward")
        return Paths(home: home, steward: steward, listen: listen)
    }

    var base: URL { URL(string: "http://\(listen)")! }
    var tokenFile: URL { home.appendingPathComponent("panel.token") }
    func token() -> String? {
        (try? String(contentsOf: tokenFile, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

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

final class TownWindow: NSObject, WKNavigationDelegate, NSWindowDelegate {
    let window: NSWindow
    let web: WKWebView
    let paths: Paths

    init(paths: Paths) {
        self.paths = paths
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Session Steward"
        window.contentView = web
        window.setFrameAutosaveName("SessionStewardMain")
        window.isReleasedWhenClosed = false
        window.delegate = self
        web.navigationDelegate = self
        if window.frame.origin == .zero { window.center() }
    }

    /// 用 token 自动登录，然后直接打开小镇世界地图。token 只在这一次请求里用，不显示。
    func open(path: String = "/?view=town&world=1") {
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
        let key = "onboarded"
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
        menu.addItem(withTitle: "打开完整面板", action: #selector(openPanel), keyEquivalent: "").target = self
        menu.addItem(.separator())
        loginItem.action = #selector(toggleLogin)
        loginItem.target = self
        menu.addItem(loginItem)
        hooksItem.target = self
        hooksItem.action = #selector(hooksAction)
        menu.addItem(hooksItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "退出并停止采集", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
        item.menu = menu
        refreshLoginItem()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.poll() }
        poll()
    }

    @objc func hooksAction() {
        if Hooks.installed() { app?.uninstallHooksMenu() } else { app?.installHooksMenu() }
    }

    func refreshHooks() {
        hooksItem.title = Hooks.installed() ? "卸载 hooks…" : "安装 hooks…"
    }

    @objc func openTown() { onOpen("/?view=town&world=1") }
    @objc func openPanel() { onOpen("/") }
    @objc func openQueue() { onOpen("/") }

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
    func poll() {
        guard let token = paths.token() else { return show(nil) }
        var req = URLRequest(url: paths.base.appendingPathComponent("api/snapshot"))
        req.timeoutInterval = 5
        req.setValue("steward_panel=\(token)", forHTTPHeaderField: "Cookie")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            var n: Int? = nil
            if (resp as? HTTPURLResponse)?.statusCode == 200, let data,
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let approvals = obj["approvals"] as? [[String: Any]] ?? []
                n = approvals.filter { ($0["status"] as? String) == "pending" }.count
            }
            DispatchQueue.main.async { self?.show(n) }
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

final class AppDelegate: NSObject, NSApplicationDelegate {
    let paths = Paths.load()
    lazy var backend = Backend(paths: paths)
    lazy var town = TownWindow(paths: paths)
    var status: StatusMenu?

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMainMenu()
        status = StatusMenu(paths: paths) { [weak self] path in self?.town.open(path: path) }
        status?.app = self
        NotificationCenter.default.addObserver(forName: .backendStopped, object: nil, queue: .main) { [weak self] _ in self?.backendStopped() }
        startBackend()
    }

    func startBackend() {
        town.showMessage("正在启动 Session Steward…")
        DispatchQueue.global().async { [self] in
            if !backend.isUp() {
                do { try backend.start() } catch {
                    DispatchQueue.main.async { self.town.showMessage("启动后台服务失败：\(error.localizedDescription)") }
                    return
                }
            }
            let ready = backend.waitReady()
            DispatchQueue.main.async {
                self.status?.poll()
                if ready { self.town.open(); self.onboardIfNeeded() } else { self.town.showMessage("后台服务没有在 \(self.paths.listen) 启动，日志在 \(self.paths.home.path)/logs/app-serve.log。") }
            }
        }
    }

    func backendStopped() {
        // App 自己的服务意外退出：提示，不自动无限重启。
        town.showMessage("后台服务已停止。可以从菜单“文件 → 重新启动服务”再试，日志在 \(paths.home.path)/logs/app-serve.log。")
    }

    @objc func reopenTown() { town.open() }
    @objc func restartBackend() { backend.stop(); startBackend() }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { town.show() }
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ note: Notification) {
        backend.stop() // 只停 App 自己启动的服务
    }

    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 Session Steward", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出并停止采集", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "文件")
        fileMenu.addItem(withTitle: "打开小镇", action: #selector(reopenTown), keyEquivalent: "1").target = self
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
