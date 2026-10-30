import Foundation
import CoreGraphics

@main
struct AttentionTests {
    static func main() {
        var count = 0
        func check(_ condition: @autoclosure () -> Bool, _ reason: String) {
            count += 1
            guard condition() else { fatalError(reason) }
        }
        let items: [[String: Any]] = [
            ["id": "SYN-001", "title": "待验收示例", "status": "review", "repo_id": 1],
            ["id": "SYN-002", "title": "静默整理", "status": "review", "repo_id": 1, "automatic_history": true],
            ["id": "SYN-003", "title": "已转交", "status": "blocked", "repo_id": 1, "management": ["state": "delegated"]],
            ["id": "SYN-004", "title": "已暂停", "status": "review", "repo_id": 1, "management": ["state": "paused"]],
            ["id": "SYN-005", "title": "已验收", "status": "review", "repo_id": 1, "management": ["state": "accepted"]],
            ["id": "SYN-006", "title": "受阻示例", "status": "blocked", "repo_id": 1],
            ["id": "SYN-007", "title": "已归档项目", "status": "review", "repo_id": 2],
            ["id": "SYN-008", "title": "已完成", "status": "done", "repo_id": 1],
        ]
        let approvals: [[String: Any]] = [
            ["id": "pending-decision", "kind": "decision", "status": "pending", "repo_id": 1, "work_item_id": "SYN-001"],
            ["id": "expired", "kind": "permission", "status": "expired", "handleable": true],
            ["id": "unsupported", "kind": "permission", "status": "pending", "handleable": false],
            ["id": "stale-merge", "kind": "merge", "status": "pending", "payload": ["stale": "source moved"]],
            ["id": "archived", "kind": "merge", "status": "pending", "repo_id": 2],
        ]
        let repos: [[String: Any]] = [["id": 1, "name": "合成项目"], ["id": 2, "name": "归档项目", "archived_at": "2026-01-01"]]
        let state = AttentionState.snapshot(["work_items": items, "approvals": approvals, "repos": repos])
        check(state.online, "successful snapshot is online")
        check(state.decisions == 1 && state.reviews == 1 && state.blocked == 1, "exclude automatic history, managed and archived work")
        check(state.records.map(\.target.id) == ["pending-decision", "SYN-006", "SYN-001"], "decisions first, then blockers, then review")
        check(state.records.first?.project == "合成项目", "project label is retained")
        check(AttentionState.snapshot([:]).records.isEmpty, "empty server arrays")
        check(!AttentionState().online, "offline does not claim an empty successful queue")
        let memory: [String: Any] = ["id": "MEM-SYN", "title": "整合会话记忆摘要", "status": "review", "repo_id": 3,
                                     "completion_policy": "auto_history", "automatic_history": false]
        let memoryRepos: [[String: Any]] = [["id": 3, "name": "memories_v2"]]
        let quiet = AttentionState.snapshot(["work_items": [memory], "repos": memoryRepos])
        check(quiet.count == 0 && quiet.records.isEmpty, "routine review with ongoing metadata must never request acceptance")
        let question = "建议记住：报告优先用中文。\n原因：后续报告可以按你的阅读习惯整理。需要保存吗？"
        let request: [String: Any] = ["id": "memory-question", "kind": "decision", "status": "pending", "work_item_id": "MEM-SYN", "preview": question]
        var formal = memory
        formal["automatic_issue"] = "存在正式审批或决定请求"
        formal["automatic_issue_kind"] = "formal"
        let proposed = AttentionState.snapshot(["work_items": [formal], "approvals": [request], "repos": memoryRepos])
        check(proposed.decisions == 1 && proposed.reviews == 0 && proposed.blocked == 0, "memory question is one decision, not an extra acceptance or blocker")
        check(proposed.records.first?.title == question && proposed.records.first?.project == "记忆与偏好", "show actual suggestion instead of internal summary and repository names")
        check(proposed.records.first?.titleLines == 2 && proposed.records.first?.target.id == "memory-question", "question has readable space and opens its own request")
        var sessionRequest = request
        sessionRequest.removeValue(forKey: "work_item_id")
        sessionRequest["session_id"] = 31
        let sessionQuestion = AttentionState.snapshot(["work_items": [formal], "approvals": [sessionRequest], "sessions": [["id": 31, "work_item_id": "MEM-SYN"]]])
        check(sessionQuestion.records.first?.project == "记忆与偏好", "session-bound questions use the same readable presentation")
        var failure = memory
        failure["automatic_issue"] = "验证失败，需要检查"
        failure["automatic_issue_kind"] = "validation"
        failure["status"] = "in_progress"
        let failed = AttentionState.snapshot(["work_items": [failure], "repos": memoryRepos])
        check(failed.blocked == 1 && failed.reviews == 0 && failed.records.first?.title == "验证失败，需要检查", "routine failures remain visible as checks, never acceptance")
        check(AttentionState.snapshot(["work_items": [memory], "approvals": [["id": "memory-permission", "kind": "permission", "status": "pending", "handleable": true, "work_item_id": "MEM-SYN"]]]).decisions == 1, "real routine permissions remain visible")
        var answered = request
        answered["status"] = "cancelled"
        check(AttentionState.snapshot(["work_items": [memory], "approvals": [answered]]).count == 0, "handled question clears without turning routine into acceptance")
        let external = AttentionGeometry(screen: CGRect(x: -1920, y: 120, width: 1920, height: 1080), visibleTop: 1175, safeTop: 0, left: nil, right: nil)
        let frame = external.frame(expanded: false, rows: 1)
        check(!external.hasNotch && frame.maxY == 1167, "non-notch display stays below the menu bar")
        check(frame.midX == -960, "negative display origin is respected")
        let builtIn = AttentionGeometry(screen: CGRect(x: 1920, y: 300, width: 1512, height: 982), visibleTop: 1244, safeTop: 38,
            left: CGRect(x: 1920, y: 1244, width: 656, height: 38), right: CGRect(x: 2776, y: 1244, width: 656, height: 38))
        check(builtIn.hasNotch && builtIn.housingWidth == 200, "camera housing comes from safe screen areas")
        check(builtIn.frame(expanded: false, rows: 0).midX == 2676, "global safe-area coordinates must not add the display origin twice")
        check(builtIn.frame(expanded: true, rows: 3).maxY == 1282, "expansion remains anchored to the screen top")
        check(builtIn.frame(expanded: true, rows: 30).height == builtIn.frame(expanded: true, rows: 3).height, "only three rows expand the surface")
        print("\(count) attention filtering and multi-display geometry checks passed")
    }
}
