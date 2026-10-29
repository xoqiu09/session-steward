import AppKit

final class NativeNoticeChannel {
    let directory: URL
    let helper: URL
    init(home: URL, helper: URL) { directory = home.appendingPathComponent("notifications"); self.helper = helper }

    func send(_ payload: [String: Any], completion: @escaping ([String: Any]?) -> Void) {
        let file = directory.appendingPathComponent("app-\(UUID().uuidString).stewardnotice")
        let result = file.appendingPathExtension("result")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let data = try JSONSerialization.data(withJSONObject: payload)
            guard data.count <= 65536 else { completion(nil); return }
            try data.write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { completion(nil); return }
        let config = NSWorkspace.OpenConfiguration(); config.activates = false
        NSWorkspace.shared.open([file], withApplicationAt: helper, configuration: config) { _, error in
            DispatchQueue.global(qos: .utility).async {
                defer { try? FileManager.default.removeItem(at: file); try? FileManager.default.removeItem(at: result) }
                if error != nil { DispatchQueue.main.async { completion(nil) }; return }
                for _ in 0..<100 {
                    if let data = try? Data(contentsOf: result), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        DispatchQueue.main.async { completion(value) }; return
                    }
                    Thread.sleep(forTimeInterval: 0.1)
                }
                DispatchQueue.main.async { completion(nil) }
            }
        }
    }
}

final class NativeNoticeReconciler {
    let channel: NativeNoticeChannel
    private var latest: [PanelTarget] = []
    private var last: [PanelTarget] = []
    private var lastSent = Date.distantPast
    private var busy = false
    init(channel: NativeNoticeChannel) { self.channel = channel }

    func update(_ snapshot: [String: Any]) {
        latest = resolvedPanelTargets(snapshot)
        reconcile()
    }

    private func reconcile() {
        guard !busy, !latest.isEmpty, latest != last || Date().timeIntervalSince(lastSent) > 30 else { return }
        busy = true
        let sending = latest
        var offset = 0
        func next() {
            if offset >= sending.count {
                self.busy = false; self.last = sending; self.lastSent = Date()
                if self.latest != sending { self.reconcile() }
                return
            }
            let end = min(offset + 128, sending.count)
            let targets = sending[offset..<end].map { ["kind": $0.kind.rawValue, "id": $0.id] }
            offset = end
            self.channel.send(["action": "reconcile", "targets": targets]) { result in
                guard result?["status"] as? String == "reconciled" else { self.busy = false; return }
                next()
            }
        }
        next()
    }
}
