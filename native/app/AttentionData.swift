import Foundation
import CoreGraphics

struct AttentionRecord: Equatable, Identifiable {
    let target: PanelTarget
    let title: String
    let project: String
    let label: String
    let priority: Int
    let updated: String
    var id: String { target.kind.rawValue + ":" + target.id }
}

struct AttentionState: Equatable {
    var online = false
    var decisions = 0
    var reviews = 0
    var blocked = 0
    var records: [AttentionRecord] = []
    var count: Int { decisions + reviews + blocked }

    static func snapshot(_ object: [String: Any]) -> AttentionState {
        let items = object["work_items"] as? [[String: Any]] ?? []
        let repos = object["repos"] as? [[String: Any]] ?? []
        let approvals = object["approvals"] as? [[String: Any]] ?? []
        let byID = Dictionary(items.compactMap { item -> (String, [String: Any])? in
            guard let id = item["id"] as? String else { return nil }
            return (id, item)
        }, uniquingKeysWith: { first, _ in first })
        let archived = Set(repos.filter { !($0["archived_at"] as? String ?? "").isEmpty }.compactMap { $0["id"] as? Int })
        func project(_ repo: Any?) -> String {
            guard let repo = repo as? Int else { return "未归属项目" }
            return repos.first { ($0["id"] as? Int) == repo }?["name"] as? String ?? "项目"
        }
        func managed(_ item: [String: Any]) -> Bool {
            let state = (item["management"] as? [String: Any])?["state"] as? String ?? ""
            return ["accepted", "paused", "delegated"].contains(state)
        }
        func hidden(_ item: [String: Any]) -> Bool {
            managed(item) || (item["automatic_history"] as? Bool == true) || archived.contains(item["repo_id"] as? Int ?? -1)
        }
        var state = AttentionState(online: true)
        for approval in approvals where approval["status"] as? String == "pending" {
            let kind = approval["kind"] as? String ?? ""
            guard ["permission", "decision", "merge"].contains(kind),
                  kind != "permission" || approval["handleable"] as? Bool == true,
                  let id = approval["id"] as? String, let target = PanelTarget(kind: "approval", id: id) else { continue }
            if archived.contains(approval["repo_id"] as? Int ?? -1) { continue }
            if kind == "merge", let payload = approval["payload"] as? [String: Any], !(payload["stale"] as? String ?? "").isEmpty { continue }
            let item = byID[approval["work_item_id"] as? String ?? ""] ?? [:]
            // A still-live permission/decision is a real request even if the work item was paused.
            if kind == "merge" && hidden(item) { continue }
            let label = kind == "merge" ? "合并待决定" : kind == "permission" ? "工具权限待决定" : "等你决定"
            state.decisions += 1
            state.records.append(AttentionRecord(target: target, title: item["title"] as? String ?? label,
                                                  project: project(approval["repo_id"] ?? item["repo_id"]), label: label,
                                                  priority: 0, updated: approval["created_at"] as? String ?? ""))
        }
        for item in items where !hidden(item) {
            let status = item["status"] as? String ?? ""
            guard ["review", "blocked"].contains(status), let id = item["id"] as? String,
                  let target = PanelTarget(kind: "item", id: id) else { continue }
            let review = status == "review"
            if review { state.reviews += 1 } else { state.blocked += 1 }
            state.records.append(AttentionRecord(target: target, title: item["title"] as? String ?? id,
                                                  project: project(item["repo_id"]), label: review ? "待你验收" : "卡住了",
                                                  priority: review ? 2 : 1, updated: item["updated_at"] as? String ?? ""))
        }
        state.records.sort { a, b in
            if a.priority != b.priority { return a.priority < b.priority }
            if a.updated != b.updated { return a.updated > b.updated }
            return a.id < b.id
        }
        return state
    }
}

/// All positions are global display coordinates, including displays left of or above the primary.
struct AttentionGeometry: Equatable {
    let screen: CGRect
    let visibleTop: CGFloat
    let housingWidth: CGFloat
    let headerHeight: CGFloat
    let centerX: CGFloat
    var hasNotch: Bool { housingWidth > 0 }
    var compactWidth: CGFloat { min(screen.width - 24, max(232, housingWidth + 148)) }
    var expandedWidth: CGFloat { min(screen.width - 24, max(416, compactWidth)) }

    init(screen: CGRect, visibleTop: CGFloat, safeTop: CGFloat, left: CGRect?, right: CGRect?) {
        self.screen = screen
        self.visibleTop = visibleTop
        if safeTop > 0, let left, let right, right.minX > left.maxX {
            housingWidth = right.minX - left.maxX
            centerX = (right.minX + left.maxX) / 2
            headerHeight = max(28, safeTop)
        } else {
            housingWidth = 0
            centerX = screen.midX
            headerHeight = 36
        }
    }

    func frame(expanded: Bool, rows: Int) -> CGRect {
        let width = expanded ? expandedWidth : compactWidth
        let body = expanded ? (rows > 0 ? CGFloat(min(rows, 3)) * 58 + 100 : 144) : 0
        let height = min(screen.height - 60, headerHeight + body)
        let top = hasNotch ? screen.maxY : min(screen.maxY, visibleTop) - 8
        let x = min(max(centerX - width / 2, screen.minX + 12), screen.maxX - width - 12)
        return CGRect(x: x, y: top - height, width: width, height: height)
    }
}
