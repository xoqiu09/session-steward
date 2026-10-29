import AppKit
import SwiftUI

final class PreviewNavigation: ObservableObject {
    @Published var path = "尚未点击提醒"
}

private func sampleAttention() -> AttentionState {
    AttentionState.snapshot([
        "repos": [["id": 1, "name": "合成演示项目"]],
        "work_items": [
            ["id": "SYN-101", "title": "通知点击后直接打开对应任务", "status": "review", "repo_id": 1],
            ["id": "SYN-102", "title": "等待补充验证材料", "status": "blocked", "repo_id": 1],
        ],
        "approvals": [["id": "synthetic-decision", "kind": "decision", "status": "pending", "repo_id": 1, "work_item_id": "SYN-101"]],
    ])
}

struct PreviewControls: View {
    let surface: AttentionSurface
    @ObservedObject var navigation: PreviewNavigation
    @ObservedObject var model: AttentionPresentation
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Label("小镇 · 顶部提醒预览", systemImage: "house.fill").font(.system(size: 24, weight: .semibold))
            Text("屏幕顶部的小条与正式 App 共用同一界面。这里只使用合成数据，不启动后台、不读取真实任务。")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Button("展开 / 收起提醒") {
                    if model.expanded { surface.setExpanded(false) } else { surface.showExpanded() }
                }
                Button("合成待办") { surface.update(sampleAttention()) }
                Button("没有待办") { surface.update(AttentionState(online: true)) }
                Button("服务离线") { surface.update(AttentionState()) }
            }
            Toggle("减少动态效果（仅本次预览）", isOn: Binding(get: { model.reduceMotion }, set: { model.reduceMotion = $0 }))
            Divider()
            Text("点击任一提醒后，这里显示将要打开的页面：").font(.system(size: 13, weight: .medium))
            Text(navigation.path).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                .frame(maxWidth: .infinity, minHeight: 40, alignment: .leading)
            Spacer(minLength: 0)
            Button("退出预览") { NSApp.terminate(nil) }
        }.padding(28).frame(width: 670, height: 350)
    }
}

final class PreviewDelegate: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var surface: AttentionSurface!
    let navigation = PreviewNavigation()
    func applicationDidFinishLaunching(_ notification: Notification) {
        surface = AttentionSurface { [weak self] path in self?.navigation.path = path }
        guard let surface else { NSApp.terminate(nil); return }
        surface.update(sampleAttention())
        surface.setEnabled(true)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 726, height: 406),
            styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "SS 提醒预览（合成数据）"
        window.contentView = NSHostingView(rootView: PreviewControls(surface: surface, navigation: navigation, model: surface.presentation))
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        let menu = NSMenu()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "退出预览", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let item = NSMenuItem(); item.submenu = appMenu; menu.addItem(item); NSApp.mainMenu = menu
    }
    func applicationWillTerminate(_ notification: Notification) { surface?.setEnabled(false) }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

@main
struct AttentionPreview {
    static func main() {
        let app = NSApplication.shared
        let delegate = PreviewDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
