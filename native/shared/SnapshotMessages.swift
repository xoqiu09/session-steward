import Foundation

struct SnapshotVersion {
    private(set) var cursor: Int64 = -1
    mutating func accept(_ snapshot: [String: Any]) -> Bool {
        guard let number = snapshot["cursor"] as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue.rounded() == number.doubleValue, number.int64Value >= 0 else { return false }
        if snapshot["reset"] as? Bool == true { cursor = -1 }
        guard number.int64Value >= cursor else { return false }
        cursor = number.int64Value
        return true
    }
}

/// Resolving a reminder is separate from accepting a work item. A stopped session alone is insufficient.
func resolvedPanelTargets(_ snapshot: [String: Any]) -> [PanelTarget] {
    var targets = Set<PanelTarget>()
    func add(_ kind: String, _ id: String) { if let target = PanelTarget(kind: kind, id: id) { targets.insert(target) } }
    for approval in snapshot["approvals"] as? [[String: Any]] ?? [] {
        if ["decided", "delivered", "confirmed", "expired", "cancelled"].contains(approval["status"] as? String ?? ""),
           let id = approval["id"] as? String { add("approval", id) }
    }
    for item in snapshot["work_items"] as? [[String: Any]] ?? [] {
        guard let id = item["id"] as? String else { continue }
        let state = (item["management"] as? [String: Any])?["state"] as? String ?? ""
        let status = item["status"] as? String ?? ""
        var resolved = ["done", "abandoned"].contains(status) || ["accepted", "paused", "delegated"].contains(state) || item["automatic_history"] as? Bool == true
        if status == "in_progress", let brief = item["brief"] as? [String: Any],
           let owner = (brief["fields"] as? [String: Any])?["next_owner"] as? [String: Any] {
            let next = owner["text"] as? String ?? ""
            let ownerAt = owner["at"] as? String ?? ""
            let answeredAt = brief["input_resolved_at"] as? String ?? ""
            resolved = resolved || ["agent", "claude", "codex"].contains(next) || (!ownerAt.isEmpty && !answeredAt.isEmpty && answeredAt >= ownerAt)
        }
        if resolved { add("item", id) }
    }
    for session in snapshot["sessions"] as? [[String: Any]] ?? [] {
        if session["state"] as? String == "running", let id = session["id"] as? Int { add("session", String(id)) }
    }
    return targets.sorted { ($0.kind.rawValue + $0.id) < ($1.kind.rawValue + $1.id) }
}
