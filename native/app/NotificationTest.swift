import AppKit

extension AppDelegate {
    /// A user-invoked, read-only check using an existing record. No synthetic business tasks are inserted.
    @objc func sendTestNotification() {
        guard let token = paths.token() else { return }
        var request = URLRequest(url: paths.base.appendingPathComponent("api/snapshot"))
        request.timeoutInterval = 5
        request.setValue("steward_panel=\(token)", forHTTPHeaderField: "Cookie")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self else { return }
            guard (response as? HTTPURLResponse)?.statusCode == 200, let data,
                  let snapshot = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
            let items = (snapshot["work_items"] as? [[String: Any]] ?? []).sorted {
                ($0["updated_at"] as? String ?? "") > ($1["updated_at"] as? String ?? "")
            }
            guard let id = items.first?["id"] as? String, let target = PanelTarget(kind: "item", id: id) else {
                DispatchQueue.main.async { self.notificationError("暂时没有可用于测试的工作项。") }
                return
            }
            DispatchQueue.main.async { self.enqueueTestNotification(target) }
        }.resume()
    }

    private func enqueueTestNotification(_ target: PanelTarget) {
        let directory = paths.home.appendingPathComponent("notifications")
        let file = directory.appendingPathComponent("test-\(UUID().uuidString).stewardnotice")
        let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/Session Steward.app")
        var link = URLComponents(url: paths.base, resolvingAgainstBaseURL: false)!
        link.path = "/"
        link.fragment = "\(target.kind.rawValue)=\(target.id)"
        let notice = ["id": "navigation-test-\(UUID().uuidString)", "title": "通知跳转测试", "body": "点击打开 \(target.id)。只查看，不会批准或验收。", "link": link.url!.absoluteString]
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let data = try JSONSerialization.data(withJSONObject: notice)
            try data.write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { notificationError("没能创建测试提醒：\(error.localizedDescription)"); return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = false
        NSWorkspace.shared.open([file], withApplicationAt: helper, configuration: configuration) { [weak self] _, error in
            if error != nil { DispatchQueue.main.async { self?.notificationError("没能启动通知助手。") } }
        }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result = file.appendingPathExtension("result")
            defer { try? FileManager.default.removeItem(at: file); try? FileManager.default.removeItem(at: result) }
            for _ in 0..<100 {
                if let data = try? Data(contentsOf: result), let object = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
                    if object["status"] != "queued" {
                        DispatchQueue.main.async { self?.notificationError("系统没有接受测试提醒。请在“系统设置 → 通知”中检查 Session Steward 的通知权限。") }
                    }
                    return
                }
                Thread.sleep(forTimeInterval: 0.1)
            }
            DispatchQueue.main.async { self?.notificationError("通知助手没有确认收到测试提醒。") }
        }
    }

    private func notificationError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "测试提醒未送出"
        alert.informativeText = message
        alert.runModal()
    }
}
