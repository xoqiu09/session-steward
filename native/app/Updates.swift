// User-triggered updates. Network, signature verification, staging and rollback
// run in the bundled helper; this window never executes downloaded commands.
import AppKit

final class UpdateWindow: NSObject {
    weak var app: AppDelegate?
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 600), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    let current = NSTextField(labelWithString: "")
    let status = NSTextField(wrappingLabelWithString: "点“检查更新”查看最新正式版。")
    let notes = NSTextView()
    let progress = NSProgressIndicator()
    let button = NSButton(title: "检查更新", target: nil, action: nil)
    var process: Process?
    var envelope: Data?
    var helper: String?
    var plan: String?
    var recovery = false
    var busy = false
    var buffer = Data()
    var lastAction = "check"

    init(app: AppDelegate) {
        self.app = app
        super.init()
        window.title = "Session Steward 更新"
        window.isReleasedWhenClosed = false
        window.center()
        window.minSize = NSSize(width: 600, height: 550)
        current.stringValue = "当前版本：\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "未知") · 构建 \(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "未知")"
        current.font = .systemFont(ofSize: 16, weight: .semibold)
        notes.isEditable = false
        notes.isRichText = false
        notes.string = "检查后会在这里显示新版说明。"
        notes.textContainerInset = NSSize(width: 12, height: 12)
        notes.isHorizontallyResizable = false
        notes.autoresizingMask = [.width]
        notes.textContainer?.widthTracksTextView = true
        notes.font = .systemFont(ofSize: 13)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.documentView = notes
        progress.style = .bar
        progress.isIndeterminate = false
        progress.minValue = 0; progress.maxValue = 1
        button.bezelStyle = .rounded
        button.keyEquivalent = "\r"
        button.target = self; button.action = #selector(act)
        let footer = NSTextField(wrappingLabelWithString: "来源：github.com/xoqiu09/session-steward。安装前校验固定公钥签名和安装包完整性。下载不影响采集；安装会短暂重启 App 与后台。")
        footer.font = .systemFont(ofSize: 11); footer.textColor = .labelColor
        let stack = NSStackView(views: [current, status, scroll, progress, footer, button])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -24),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            footer.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 160),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            progress.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }
    func show() {
        if !busy && plan == nil { inspectRecovery() }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }
    func inspectRecovery(ignoreLive: Bool = false) {
        guard let app else { return }
        let root = app.paths.home.appendingPathComponent("updates")
        let dirs = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey])) ?? []
        for dir in dirs.sorted(by: { $0.lastPathComponent > $1.lastPathComponent }) {
            let path = dir.appendingPathComponent("transaction.json")
            guard let raw = try? Data(contentsOf: path), let obj = try? JSONSerialization.jsonObject(with: raw) as? [String: Any],
                  obj["App"] as? String == Bundle.main.bundleURL.path, obj["State"] as? String == "installing" else { continue }
            if !ignoreLive && updateTransaction() == dir.path { continue }
            plan = path.path; helper = dir.appendingPathComponent("steward-updater").path; recovery = true
            status.stringValue = "上次安装被中断。请先恢复旧版；恢复记录和失败安装包会保留。"
            notes.string = "恢复不会覆盖数据库、配置或密钥。记录：\(path.path)\n若恢复失败，请退出 App，并按更新文档使用此记录恢复。"
            button.title = "恢复旧版并重启"; return
        }
    }
    private var resultTimer: Timer?
    func observeInstallation() {
        guard let work = updateTransaction(), let app,
              URL(fileURLWithPath: work).deletingLastPathComponent().path == app.paths.home.appendingPathComponent("updates").path else { return }
        var attempts = 0
        resultTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            attempts += 1
            let path = URL(fileURLWithPath: work).appendingPathComponent("transaction.json")
            let raw = try? Data(contentsOf: path)
            let obj = raw.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let state = obj?["State"] as? String
            if state == "installed" || state == "rolled_back" {
                timer.invalidate()
                self.status.stringValue = state == "installed" ? "更新完成，App 与后台已通过版本检查。" : "新版未通过安装检查，旧版已恢复并重启。"
                self.notes.string = "安装记录与恢复材料：\(work)\n数据库、密钥与配置保持原位。"
                self.show()
            } else if attempts >= 90 {
                timer.invalidate(); self.inspectRecovery(ignoreLive: true); self.show()
            }
        }
    }
    @objc func act() {
        guard !busy, let app else { return }
        if let plan, let helper {
            // The user's explicit install/recovery click is the only install trigger.
            let p = Process(); p.executableURL = URL(fileURLWithPath: helper)
            p.arguments = [recovery ? "recover" : "apply", plan]
            do {
                let log = URL(fileURLWithPath: plan).deletingLastPathComponent().appendingPathComponent("helper-output.log")
                FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
                let handle = try FileHandle(forWritingTo: log)
                p.standardOutput = handle; p.standardError = handle
                try p.run()
                app.installingUpdate = true
                NSApp.terminate(nil)
            } catch { fail(error.localizedDescription) }
        } else if envelope != nil && lastAction != "check" { prepare() }
        else { check() }
    }
    func check() { envelope = nil; lastAction = "check"; run(["check"]) }
    func prepare() {
        guard let app, let envelope else { return }
        do {
            let root = app.paths.home.appendingPathComponent("updates")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let path = root.appendingPathComponent("manifest-\(UUID().uuidString).json")
            try envelope.write(to: path, options: [.atomic]); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            lastAction = "prepare"
            run(["prepare", Bundle.main.bundleURL.path, app.paths.home.path, app.mode == .shared ? "shared" : "own", String(ProcessInfo.processInfo.processIdentifier), path.path])
        } catch { fail(error.localizedDescription) }
    }
    func run(_ args: [String]) {
        let p = Process()
        p.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/steward-updater")
        p.arguments = args
        let pipe = Pipe(); p.standardOutput = pipe
        let errors = Pipe(); p.standardError = errors
        busy = true; button.isEnabled = false; buffer = Data()
        status.stringValue = args[0] == "check" ? "正在检查更新…" : "正在下载并校验安装包…"
        process = p
        DispatchQueue.global().async { [weak self] in
            do {
                try p.run()
                while true {
                    let data = pipe.fileHandleForReading.availableData
                    if data.isEmpty { break }
                    DispatchQueue.main.async { self?.consume(data) }
                }
                p.waitUntilExit()
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.busy = false; self.button.isEnabled = true; self.process = nil
                    if p.terminationStatus != 0 && self.status.stringValue.hasPrefix("正在") { self.fail("更新助手未完成，请重试。当前安装保持原样。") }
                }
            } catch { DispatchQueue.main.async { self?.busy = false; self?.button.isEnabled = true; self?.fail(error.localizedDescription) } }
        }
    }
    func consume(_ data: Data) {
        buffer.append(data)
        while let range = buffer.firstRange(of: Data([10])) {
            let line = buffer.subdata(in: 0..<range.lowerBound)
            buffer.removeSubrange(0..<range.upperBound)
            guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any], let event = obj["event"] as? String else { continue }
            switch event {
            case "available":
                envelope = try? JSONSerialization.data(withJSONObject: obj["manifest"] ?? [:])
                status.stringValue = "可升级至 \(obj["version"] as? String ?? "")"
                notes.string = obj["notes"] as? String ?? "此版本未提供更新说明。"
                button.title = "下载更新"; lastAction = "prepare"
            case "progress":
                if let n = obj["received"] as? Double, let total = obj["total"] as? Double, total > 0 {
                    progress.doubleValue = n / total
                    status.stringValue = "正在下载：\(Int(n / total * 100))%（\(Int(n / 1048576))/\(Int(total / 1048576)) MB）"
                }
            case "ready":
                helper = obj["helper"] as? String; plan = obj["plan"] as? String
                status.stringValue = "安装包已校验，准备好了。安装失败会尝试恢复旧版。"
                button.title = "安装并重启"; progress.doubleValue = 1
            case "error": fail(obj["message"] as? String ?? "更新失败")
            default: break
            }
        }
    }
    func cancelDownload() { if process?.isRunning == true { process?.terminate() } }
    func fail(_ message: String) {
        status.stringValue = message
        button.title = recovery ? "重试恢复并重启" : "重试"
    }
}
