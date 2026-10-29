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
                  let snapshot = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                DispatchQueue.main.async { self.notificationError("本机小镇暂时没有响应，请先确认后台服务已连接。") }
                return
            }
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
        var link = URLComponents(url: paths.base, resolvingAgainstBaseURL: false)!
        link.path = "/"
        link.fragment = "\(target.kind.rawValue)=\(target.id)"
        let notice = ["id": "navigation-test-\(UUID().uuidString)", "title": "通知跳转测试", "body": "点击打开 \(target.id)。只查看，不会批准或验收。", "link": link.url!.absoluteString]
        noticeChannel.send(notice) { [weak self] result in
            if result?["status"] as? String != "queued" {
                self?.notificationError("系统没有接受测试提醒。请在“系统设置 → 通知”中检查 Session Steward 的通知权限。")
            }
        }
    }

    private func notificationError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "测试提醒未送出"
        alert.informativeText = message
        alert.runModal()
    }
}
