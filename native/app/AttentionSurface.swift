import AppKit
import SwiftUI
import QuartzCore

final class AttentionPresentation: ObservableObject {
    @Published var state = AttentionState()
    @Published var expanded = false
    @Published var geometry: AttentionGeometry
    @Published var reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    init(geometry: AttentionGeometry) { self.geometry = geometry }
}

private final class AttentionPanel: NSPanel {
    var onEscape: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onEscape?() }
        else { super.keyDown(with: event) }
    }
}

/// A navigation-only surface. It does not decide approvals or change work status.
final class AttentionSurface {
    private let panel: AttentionPanel
    let presentation: AttentionPresentation
    private let onOpen: (String) -> Void
    private var hoverWork: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []
    private(set) var enabled = false

    init?(onOpen: @escaping (String) -> Void) {
        guard let geometry = Self.geometry() else { return nil }
        self.onOpen = onOpen
        presentation = AttentionPresentation(geometry: geometry)
        panel = AttentionPanel(contentRect: geometry.frame(expanded: false, rows: 0),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "Session Steward 顶部提醒"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.onEscape = { [weak self] in self?.setExpanded(false) }
        panel.contentView = NSHostingView(rootView: AttentionSurfaceView(model: presentation,
            onToggle: { [weak self] in self?.setExpanded(!(self?.presentation.expanded ?? false)) },
            onHover: { [weak self] inside in self?.hover(inside) },
            onOpen: { [weak self] path in self?.setExpanded(false); self?.onOpen(path) }))
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main) { [weak self] _ in self?.screenChanged() })
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
            object: nil, queue: .main) { [weak self] _ in
                self?.presentation.reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            })
    }

    deinit {
        hoverWork?.cancel()
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        panel.orderOut(nil)
    }

    func setEnabled(_ enabled: Bool) {
        self.enabled = enabled
        hoverWork?.cancel()
        if enabled { screenChanged(); panel.orderFrontRegardless() }
        else { presentation.expanded = false; panel.orderOut(nil) }
    }

    func update(_ state: AttentionState) {
        guard presentation.state != state else { return }
        presentation.state = state
        if enabled { resize(animated: false) }
    }

    private func hover(_ inside: Bool) {
        hoverWork?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.setExpanded(inside) }
        hoverWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (inside ? 0.18 : 0.35), execute: work)
    }

    func setExpanded(_ expanded: Bool) {
        guard enabled, presentation.expanded != expanded else { return }
        hoverWork?.cancel()
        presentation.expanded = expanded
        resize(animated: !presentation.reduceMotion)
        if !expanded && panel.isKeyWindow { panel.orderOut(nil); panel.orderFrontRegardless() }
    }

    /// Explicit menu/keyboard navigation may take focus; hovering never does.
    func showExpanded() {
        guard enabled else { return }
        setExpanded(true)
        panel.makeKeyAndOrderFront(nil)
    }

    private func resize(animated: Bool) {
        let frame = presentation.geometry.frame(expanded: presentation.expanded, rows: presentation.state.records.count)
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.28
                context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                panel.animator().setFrame(frame, display: true)
            }
        } else { panel.setFrame(frame, display: true) }
    }

    private func screenChanged() {
        guard let geometry = Self.geometry() else { panel.orderOut(nil); return }
        presentation.geometry = geometry
        resize(animated: false)
        if enabled { panel.orderFrontRegardless() }
    }

    private static func geometry() -> AttentionGeometry? {
        guard let screen = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 && $0.auxiliaryTopLeftArea != nil }) ?? NSScreen.main else { return nil }
        return AttentionGeometry(screen: screen.frame, visibleTop: screen.visibleFrame.maxY, safeTop: screen.safeAreaInsets.top,
                                 left: screen.auxiliaryTopLeftArea, right: screen.auxiliaryTopRightArea)
    }
}

struct AttentionSurfaceView: View {
    @ObservedObject var model: AttentionPresentation
    let onToggle: () -> Void
    let onHover: (Bool) -> Void
    let onOpen: (String) -> Void
    private let amber = Color(red: 1, green: 0.75, blue: 0.36)
    private let violet = Color(red: 0.76, green: 0.70, blue: 1)

    var body: some View {
        VStack(spacing: 0) {
            Button(action: onToggle) {
                HStack(spacing: 8) {
                    Image(systemName: "house.fill").foregroundStyle(violet)
                    Text("小镇").font(.system(size: 12, weight: .semibold))
                    Spacer(minLength: model.geometry.housingWidth)
                    Circle().fill(model.state.online ? (model.state.count > 0 ? amber : Color.green) : Color.gray).frame(width: 5, height: 5)
                    Text(model.state.online ? (model.state.count > 0 ? "待处理 \(model.state.count)" : "无待处理") : "连接中")
                        .font(.system(size: 11, weight: .medium)).monospacedDigit()
                }.padding(.horizontal, 14).frame(height: model.geometry.headerHeight)
                    .contentShape(Rectangle())
            }.buttonStyle(.plain)
                .accessibilityLabel("小镇顶部提醒，\(model.state.online ? "待处理 \(model.state.count) 项" : "服务未连接")")
                .accessibilityHint(model.expanded ? "点击收起提醒" : "点击展开提醒")
            if model.expanded {
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("需要你看一眼").font(.system(size: 15, weight: .semibold))
                        Spacer()
                        Text("这台电脑").font(.system(size: 11)).foregroundStyle(.white.opacity(0.64))
                    }.padding(.bottom, 9)
                    if model.state.records.isEmpty {
                        Text(model.state.online ? "暂时没有待决定、待验收或受阻的工作。" : "正在连接本机小镇。服务恢复后会更新。")
                            .font(.system(size: 12)).foregroundStyle(.white.opacity(0.76))
                            .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, minHeight: 63, alignment: .leading)
                    } else {
                        ForEach(Array(model.state.records.prefix(3))) { record in
                            AttentionRow(record: record, tint: record.priority == 2 ? violet : amber) { onOpen(record.target.path) }
                        }
                    }
                    HStack {
                        Text("决定 \(model.state.decisions) · 验收 \(model.state.reviews) · 受阻 \(model.state.blocked)")
                            .font(.system(size: 10)).foregroundStyle(.white.opacity(0.64))
                        Spacer()
                        Button { onOpen("/?view=today") } label: {
                            HStack(spacing: 4) { Text("每日十分钟"); Image(systemName: "arrow.up.right") }
                        }.buttonStyle(.plain).font(.system(size: 11, weight: .medium)).foregroundStyle(violet)
                    }.padding(.top, 10)
                }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 16)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .foregroundStyle(.white)
        .background(.black)
        .clipShape(RoundedRectangle(cornerRadius: model.expanded ? 22 : (model.geometry.hasNotch ? 9 : 18), style: .continuous))
        .animation(model.reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.87), value: model.expanded)
        .onHover(perform: onHover)
        .accessibilityElement(children: .contain)
    }
}

private struct AttentionRow: View {
    let record: AttentionRecord
    let tint: Color
    let onOpen: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 10) {
                Circle().fill(tint).frame(width: 6, height: 6)
                VStack(alignment: .leading, spacing: 4) {
                    Text(record.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                    Text("\(record.project) · \(record.label)").font(.system(size: 10)).foregroundStyle(.white.opacity(0.66)).lineLimit(1)
                }
                Spacer(minLength: 6)
                Image(systemName: "arrow.up.right").font(.system(size: 10)).foregroundStyle(.white.opacity(0.55))
            }.padding(.horizontal, 9).frame(height: 54).frame(maxWidth: .infinity, alignment: .leading)
                .background(hovering ? Color.white.opacity(0.12) : Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).padding(.bottom, 4).onHover { hovering = $0 }
            .accessibilityLabel("\(record.target.id)，\(record.title)，\(record.label)")
            .accessibilityHint("在小镇中查看详情")
    }
}
