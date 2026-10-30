import Foundation

@main
struct PanelLinkTests {
    static func main() {
        let base = URL(string: "http://127.0.0.1:7788")!
        var count = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            count += 1
            guard condition() else { fatalError(message) }
        }
        for (kind, id) in [("item", "SYN-001"), ("approval", "synthetic-approval"), ("session", "42")] {
            let target = PanelTarget(kind: kind, id: id)!
            check(PanelTarget.fromIncomingURL(target.appURL(port: 7788), base: base) == target, "app link round trip")
            check(PanelTarget.fromIncomingURL(URL(string: "http://localhost:7788/#\(kind)=\(id)")!, base: base) == target, "legacy notification link")
            check(target.path.contains("view=town&world=1#\(kind)=\(id)"), "keep the world and target")
        }
        let bad = [
            "https://example.invalid/#item=SYN-001", "http://127.0.0.1.evil.invalid:7788/#item=SYN-001",
            "http://user:secret@localhost:7788/#item=SYN-001", "http://localhost:7788/?token=secret#item=SYN-001",
            "http://localhost:7788/api/approve#item=SYN-001", "http://localhost:7788/#item=",
            "http://localhost:7788/#item=SYN-001&session=42", "http://localhost:7788/#item=SYN-001&item=SYN-002",
            "http://localhost:7788/#command=anything", "http://localhost:7799/#item=SYN-001",
            "session-steward://open?port=7788&item=SYN-001&item=SYN-002",
            "session-steward://open?port=7799&item=SYN-001", "session-steward://open?port=7788&command=approve",
            "session-steward://open?port=7788&item=SYN-001#approval=other",
            "session-steward://open/path?port=7788&item=SYN-001", "session-steward://open?port=7788&item=%0A",
        ]
        for text in bad { check(PanelTarget.fromIncomingURL(URL(string: text)!, base: base) == nil, "reject unsafe or foreign link: \(text)") }
        check(PanelTarget.fromPanelURL(URL(string: "http://[::1]:7788/#session=42")!) != nil, "IPv6 local origin")
        check(PanelTarget(kind: "item", id: String(repeating: "X", count: 257)) == nil, "bounded identifier")
        check(PanelTarget(kind: "session", id: "not-a-number") == nil, "session route needs a numeric record")
        check(PanelTarget(kind: "session", id: "0") == nil, "zero is not a session")
        var navigation = PanelNavigation()
        let first = PanelTarget(kind: "item", id: "SYN-001")!
        let testScheme = "steward-isolated-synthetic"
        check(PanelTarget.fromIncomingURL(first.appURL(port: 7788, scheme: testScheme), base: base, scheme: testScheme) == first, "isolated scheme round trip")
        check(PanelTarget.fromIncomingURL(first.appURL(port: 7788, scheme: testScheme), base: base) == nil, "production rejects isolated scheme")
        let latest = PanelTarget(kind: "approval", id: "synthetic-approval")!
        check(navigation.receive(first) == nil, "cold click waits")
        check(navigation.receive(latest) == nil, "latest cold click waits")
        check(navigation.backendReady() == latest.path, "startup preserves latest notification target")
        check(navigation.receive(first) == first.path, "warm click navigates immediately")
        navigation.restarting()
        check(navigation.receive(latest) == nil, "restart queues target")
        check(navigation.backendReady() == latest.path, "restart preserves target")
        var plain = PanelNavigation()
        check(plain.backendReady() == PanelNavigation.world, "normal opening remains the world")

        let root = FileManager.default.temporaryDirectory.appendingPathComponent("steward-host-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let hostID = "io.github.xoqiu09.session-steward.preview-test"
        func bundle(_ url: URL, id: String, scheme: Bool) {
            let contents = url.appendingPathComponent("Contents")
            try! FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
            var info: [String: Any] = ["CFBundleIdentifier": id, "CFBundlePackageType": "APPL", "CFBundleName": "Synthetic host"]
            if scheme { info["CFBundleURLTypes"] = [["CFBundleURLSchemes": ["session-steward"]]] }
            let data = try! PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            try! data.write(to: contents.appendingPathComponent("Info.plist"))
        }
        let enclosing = root.appendingPathComponent("Preview.app")
        let helper = enclosing.appendingPathComponent("Contents/MacOS/Session Steward.app")
        bundle(enclosing, id: hostID, scheme: true)
        let oldApp = root.appendingPathComponent("Old.app")
        bundle(oldApp, id: hostID, scheme: false)
        let installed = root.appendingPathComponent("Installed.app")
        bundle(installed, id: hostID, scheme: true)
        check(notificationHost(helper: helper, identifier: hostID, installed: [installed])?.standardizedFileURL.path == enclosing.standardizedFileURL.path, "embedded preview must not open another installation")
        let standalone = root.appendingPathComponent("bin/Helper.app")
        check(notificationHost(helper: standalone, identifier: hostID, installed: [oldApp, installed])?.standardizedFileURL.path == installed.standardizedFileURL.path, "legacy App without URL receiver must be skipped")
        check(notificationHost(helper: standalone, identifier: "unrelated.application", installed: [installed]) == nil, "wrong App identity is not opened")
        let syntheticHome = URL(fileURLWithPath: "/synthetic/user")
        func spool(_ args: [String], _ env: [String: String]) -> String {
            notificationDirectory(arguments: args, environment: env, userHome: syntheticHome).path
        }
        check(spool([], [:]) == "/synthetic/user/.steward/notifications", "normal notification directory")
        check(spool([], ["STEWARD_HOME": "/synthetic/env"]) == "/synthetic/env/notifications", "helper follows explicit environment")
        check(spool(["helper", "--steward-home", "/synthetic/argument"], ["STEWARD_HOME": "/synthetic/env"]) == "/synthetic/argument/notifications", "argument survives LaunchServices and wins over environment")
        var version = SnapshotVersion()
        check(version.accept(["cursor": 20]), "first snapshot")
        check(!version.accept(["cursor": 19]), "stale snapshot cannot resurrect reminders")
        check(!version.accept(["cursor": true]), "boolean is not a cursor")
        check(!version.accept(["cursor": -1]), "negative cursor rejected")
        check(!version.accept(["cursor": 20.5]), "fractional cursor rejected")
        check(version.accept(["cursor": 1, "reset": true]), "explicit reset permits server restore")
        let resolved = resolvedPanelTargets([
            "approvals": [["id": "syn-pending", "status": "pending"], ["id": "syn-decided", "status": "decided"]],
            "work_items": [
                ["id": "SYN-REVIEW", "status": "review"], ["id": "SYN-DONE", "status": "done"],
                ["id": "SYN-DELEGATED", "status": "blocked", "management": ["state": "delegated"]],
                ["id": "SYN-AUTO", "status": "review", "automatic_history": true],
                ["id": "SYN-RESUMED", "status": "in_progress", "brief": ["fields": ["next_owner": ["text": "agent", "at": "2026-10-29T00:00:00Z"]]]],
                ["id": "SYN-WAITING", "status": "in_progress", "brief": ["fields": ["next_owner": ["text": "user", "at": "2026-10-29T00:00:00Z"]]]]
            ],
            "sessions": [["id": 42, "state": "running"], ["id": 43, "state": "ended"]]
        ])
        func has(_ kind: String, _ id: String) -> Bool { resolved.contains(PanelTarget(kind: kind, id: id)!) }
        check(has("approval", "syn-decided") && !has("approval", "syn-pending"), "only answered approvals resolve")
        check(has("item", "SYN-DONE") && has("item", "SYN-DELEGATED") && has("item", "SYN-AUTO"), "explicit management and quiet history resolve notices")
        check(has("item", "SYN-RESUMED") && !has("item", "SYN-WAITING"), "actual hand-back clears input reminder")
        check(!has("item", "SYN-REVIEW"), "continuing an agent does not accept a review")
        check(has("session", "42") && !has("session", "43"), "session ended is not acceptance")
        check(notificationFailureMessage("permission_denied").contains("系统设置"), "only permission denial points to notification settings")
        check(notificationFailureMessage("helper_timeout").contains("未及时回应"), "timeout explains helper response")
        check(!notificationFailureMessage("helper_launch_failed").contains("权限"), "launch error is not misreported as permission")
        check(!notificationFailureMessage(nil).contains("权限"), "unknown delivery result is not a permission claim")
        print("\(count) panel navigation, snapshot ordering and reminder lifecycle checks passed")
    }
}
