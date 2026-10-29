import AppKit
import UserNotifications

struct Notice: Codable {
    let id: String
    let title: String
    let body: String
    let link: String
}

// Notifications only navigate. They never carry a token, execute a command or decide an approval.
func panelURL(_ text: String) -> URL? {
    guard let url = URL(string: text), PanelTarget.fromPanelURL(url) != nil else { return nil }
    return url
}

final class Notifications: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    let center = UNUserNotificationCenter.current()
    let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".steward/notifications")
    let auditQueue = DispatchQueue(label: "steward.notification-audit")

    override init() {
        super.init()
        center.delegate = self
        let view = UNNotificationAction(identifier: "OPEN_STEWARD", title: "查看详情", options: [.foreground])
        center.setNotificationCategories([UNNotificationCategory(identifier: "STEWARD_RECORD", actions: [view], intentIdentifiers: [])])
    }

    func record(_ kind: String, _ id: String) {
        auditQueue.async {
            let entry = ["at": ISO8601DateFormatter().string(from: Date()), "kind": kind, "id": id]
            guard let data = try? JSONSerialization.data(withJSONObject: entry) else { return }
            let file = self.directory.appendingPathComponent("activity.jsonl")
            if !FileManager.default.fileExists(atPath: file.path) {
                FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            if let handle = try? FileHandle(forWritingTo: file) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data + Data([10]))
            }
        }
    }

    func result(_ file: URL, _ status: String) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["status": status]) else { return }
        try? data.write(to: file.appendingPathExtension("result"), options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.appendingPathExtension("result").path)
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        for filename in filenames { receive(URL(fileURLWithPath: filename)) }
        sender.reply(toOpenOrPrint: .success)
    }

    func receive(_ file: URL) {
        // Only process private files in Steward's own spool, never arbitrary documents or URLs.
        guard file.deletingLastPathComponent().standardizedFileURL == directory.standardizedFileURL,
              file.pathExtension == "stewardnotice",
              let attrs = try? FileManager.default.attributesOfItem(atPath: file.path),
              attrs[.type] as? FileAttributeType == .typeRegular,
              ((attrs[.size] as? NSNumber)?.intValue ?? 65537) <= 65536,
              let data = try? Data(contentsOf: file), let notice = try? JSONDecoder().decode(Notice.self, from: data),
              !notice.id.isEmpty, notice.id.count <= 128, notice.title.count <= 256,
              notice.body.count <= 2048, panelURL(notice.link) != nil else { return }
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .notDetermined {
                self.center.requestAuthorization(options: [.alert, .sound]) { allowed, _ in
                    if allowed { self.enqueue(notice, file) } else { self.result(file, "permission_denied") }
                }
            } else if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional {
                self.enqueue(notice, file)
            } else {
                self.result(file, "permission_denied")
            }
        }
    }

    func enqueue(_ notice: Notice, _ file: URL) {
        let content = UNMutableNotificationContent()
        content.title = "Session Steward"
        content.subtitle = notice.title
        content.body = notice.body
        content.sound = .default
        content.userInfo = ["link": notice.link]
        content.categoryIdentifier = "STEWARD_RECORD"
        let request = UNNotificationRequest(identifier: notice.id, content: content, trigger: nil)
        center.add(request) { error in
            self.result(file, error == nil ? "queued" : "delivery_failed")
            self.record(error == nil ? "queued" : "delivery_failed", notice.id)
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        defer { completionHandler() }
        guard [UNNotificationDefaultActionIdentifier, "OPEN_STEWARD"].contains(response.actionIdentifier),
              let text = response.notification.request.content.userInfo["link"] as? String,
              let url = panelURL(text) else { return }
        DispatchQueue.main.async {
            self.openRecord(url, id: response.notification.request.identifier)
        }
    }

    func openRecord(_ url: URL, id: String) {
        guard let target = PanelTarget.fromPanelURL(url) else { return }
        let identifier = Bundle.main.object(forInfoDictionaryKey: "StewardHostBundleIdentifier") as? String
            ?? "io.github.xoqiu09.session-steward.app"
        let home = FileManager.default.homeDirectoryForCurrentUser
        var installed = [URL(fileURLWithPath: "/Applications/Session Steward.app"), home.appendingPathComponent("Applications/Session Steward.app")]
        if let registered = NSWorkspace.shared.urlForApplication(withBundleIdentifier: identifier) { installed.append(registered) }
        guard let app = notificationHost(helper: Bundle.main.bundleURL, identifier: identifier, installed: installed) else {
            record(NSWorkspace.shared.open(url) ? "opened_browser" : "open_failed", id)
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.open([target.appURL(port: url.port ?? 80)], withApplicationAt: app, configuration: config) { _, error in
            if error == nil { self.record("opened_app", id) }
            else { self.record("open_failed", id) }
        }
    }
}

if CommandLine.arguments.contains("--check-links") {
    let checks: [(String, Bool)] = [
        ("http://127.0.0.1:7788/#item=SYN-1", true),
        ("http://localhost:7788/#approval=synthetic", true),
        ("https://example.invalid/#item=SYN-1", false),
        ("http://127.0.0.1.evil.invalid/#item=SYN-1", false),
        ("file:///tmp/test", false),
        ("http://user:secret@localhost:7788/#item=SYN-1", false),
        ("http://localhost:7788/?token=secret#item=SYN-1", false),
        ("http://localhost:7788/#command=delete", false),
        ("http://localhost:7788/#item=", false),
        ("http://localhost:7788/#item=SYN-1&session=1", false),
        ("http://[::1]:7788/#session=1", true)
    ]
    guard checks.allSatisfy({ (panelURL($0.0) != nil) == $0.1 }) else { exit(1) }
    print("11 notification link checks passed")
} else {
    let app = NSApplication.shared
    let delegate = Notifications()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
