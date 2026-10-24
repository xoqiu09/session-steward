package core

import (
	"database/sql"
	"encoding/json"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

// permissionExecution 是执行证据的关联信息，不替代审批使用的完整内容指纹。
// Codex 的 PermissionRequest 没有 tool_use_id 时，只关联同一轮、同一子
// Agent 中唯一尚未结束的匹配工具调用；并行同命令存在歧义时保持未确认。
type permissionExecution struct {
	Required   bool   `json:"required"`
	TurnID     string `json:"turn_id,omitempty"`
	ToolUseID  string `json:"tool_use_id,omitempty"`
	SubagentID string `json:"subagent_id,omitempty"`
}

func permissionExecutionFor(tx *sql.Tx, sid int64, e *event.Event) (permissionExecution, error) {
	ref := permissionExecution{
		Required: e.TurnID != "" || e.ToolUseID != "",
		TurnID:   e.TurnID, ToolUseID: e.ToolUseID, SubagentID: e.SubagentID,
	}
	if ref.ToolUseID != "" || e.ExecutionFingerprint == "" || (ref.TurnID == "" && e.Source.Provider != "claude") {
		return ref, nil
	}
	query := `SELECT body FROM events WHERE session_id=?
		AND kind IN ('tool_pre','tool_post','tool_fail') AND occurred_at<=?
		AND json_extract(body,'$.tool_name')=?`
	args := []any{sid, store.TS(e.OccurredAt), e.ToolName}
	if ref.TurnID != "" {
		query += ` AND json_extract(body,'$.turn_id')=?`
		args = append(args, ref.TurnID)
	} else {
		// Claude omits both IDs in PermissionRequest. Only a uniquely matching
		// unfinished PreToolUse in this session's current turn can identify it.
		query += ` AND occurred_at>=COALESCE((SELECT MAX(occurred_at) FROM events
			WHERE session_id=? AND kind IN ('prompt','session_start') AND occurred_at<=?), '')`
		args = append(args, sid, store.TS(e.OccurredAt))
	}
	query += ` ORDER BY occurred_at, seq`
	rows, err := tx.Query(query, args...)
	if err != nil {
		return ref, err
	}
	defer rows.Close()
	active := map[string]string{}
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			return ref, err
		}
		var call event.Event
		if err := json.Unmarshal([]byte(body), &call); err != nil {
			return ref, err
		}
		if call.ToolUseID == "" || call.ToolName != e.ToolName || call.SubagentID != e.SubagentID {
			continue
		}
		if call.Kind == event.KindToolPre {
			active[call.ToolUseID] = call.ExecutionFingerprint
		} else {
			delete(active, call.ToolUseID)
		}
	}
	if err := rows.Err(); err != nil {
		return ref, err
	}
	for id, fp := range active {
		if fp != e.ExecutionFingerprint {
			continue
		}
		if ref.ToolUseID != "" {
			ref.Required = true
			ref.ToolUseID = "" // 不以顺序或最近一次猜测并行调用
			return ref, nil
		}
		ref.ToolUseID = id
		ref.Required = true
	}
	return ref, nil
}

type permissionEvidence struct {
	ID, Status, Decision, Fingerprint, ToolName, CreatedAt string
	Execution                                              permissionExecution
}

func decodePermissionEvidence(id, status, decision, fp, tool, created, payload string) (permissionEvidence, error) {
	a := permissionEvidence{ID: id, Status: status, Decision: decision, Fingerprint: fp, ToolName: tool, CreatedAt: created}
	var p struct {
		Execution permissionExecution `json:"execution"`
	}
	if err := json.Unmarshal([]byte(payload), &p); err != nil {
		return a, err
	}
	a.Execution = p.Execution
	return a, nil
}

func (a permissionEvidence) matches(e *event.Event) bool {
	if a.ToolName != e.ToolName || a.CreatedAt > store.TS(e.OccurredAt) {
		return false
	}
	ref := a.Execution
	if ref.ToolUseID != "" {
		return ref.ToolUseID == e.ToolUseID && ref.SubagentID == e.SubagentID &&
			(ref.TurnID == "" || ref.TurnID == e.TurnID)
	}
	// 旧版事件缺少调用标识时，只允许完整参数指纹的唯一匹配。
	// 现代事件若有轮次但没找到唯一调用，绝不能退回命令文本匹配。
	return !ref.Required && a.Fingerprint != "" && a.Fingerprint == e.Fingerprint
}

func permissionsCompletedBy(tx *sql.Tx, sid int64, e *event.Event, now string) ([]string, error) {
	rows, err := tx.Query(`SELECT id,status,decision,fingerprint,tool_name,created_at,payload FROM approvals
		WHERE kind='permission' AND handleable=1 AND session_id=? AND status IN ('pending','delivered')`, sid)
	if err != nil {
		return nil, err
	}
	var strong, legacy []permissionEvidence
	for rows.Next() {
		var id, status, decision, fp, tool, created, payload string
		if err := rows.Scan(&id, &status, &decision, &fp, &tool, &created, &payload); err != nil {
			rows.Close()
			return nil, err
		}
		a, err := decodePermissionEvidence(id, status, decision, fp, tool, created, payload)
		if err != nil {
			rows.Close()
			return nil, err
		}
		if !a.matches(e) || (a.Status == "delivered" && a.Decision != "allow") {
			continue
		}
		if a.Execution.ToolUseID != "" {
			strong = append(strong, a)
		} else {
			legacy = append(legacy, a)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	matches := strong
	if len(strong) == 0 && len(legacy) == 1 {
		matches = legacy
	}
	var cancelled []string
	for _, a := range matches {
		var err error
		if a.Status == "pending" {
			_, err = tx.Exec(`UPDATE approvals SET status='cancelled',close_reason='resolved_elsewhere',closed_at=? WHERE id=? AND status='pending'`, now, a.ID)
			cancelled = append(cancelled, a.ID)
		} else {
			_, err = tx.Exec(`UPDATE approvals SET status='confirmed',confirmed_at=? WHERE id=? AND status='delivered' AND decision='allow'`, now, a.ID)
		}
		if err != nil {
			return nil, err
		}
		if err := store.Touch(tx, now, "approval", a.ID); err != nil {
			return nil, err
		}
	}
	return cancelled, nil
}

// 工具可能在适配器确认送达前就已完成。收到送达确认时再检查已落库的执行
// 证据，避免永久停在 delivered；依然应用同样严格的调用标识匹配规则。
func reconcileDeliveredPermission(tx *sql.Tx, id, now string) error {
	var sid int64
	var created, decision string
	if err := tx.QueryRow(`SELECT session_id,created_at,decision FROM approvals WHERE id=?`, id).Scan(&sid, &created, &decision); err != nil {
		return err
	}
	if decision != "allow" {
		return nil
	}
	rows, err := tx.Query(`SELECT body FROM events WHERE session_id=? AND kind IN ('tool_post','tool_fail') AND occurred_at>=? ORDER BY occurred_at,seq`, sid, created)
	if err != nil {
		return err
	}
	var completed []event.Event
	for rows.Next() {
		var body string
		if err := rows.Scan(&body); err != nil {
			rows.Close()
			return err
		}
		var e event.Event
		if err := json.Unmarshal([]byte(body), &e); err != nil {
			rows.Close()
			return err
		}
		completed = append(completed, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, e := range completed {
		// 这里只确认本次已送达的审批，不处理其他等待中的请求。
		var status, dec, fp, tool, at, payload string
		if err := tx.QueryRow(`SELECT status,decision,fingerprint,tool_name,created_at,payload FROM approvals WHERE id=?`, id).Scan(&status, &dec, &fp, &tool, &at, &payload); err != nil {
			return err
		}
		a, err := decodePermissionEvidence(id, status, dec, fp, tool, at, payload)
		if err != nil {
			return err
		}
		if status != "delivered" || !a.matches(&e) {
			continue
		}
		if a.Execution.ToolUseID == "" {
			var n int
			if err := tx.QueryRow(`SELECT COUNT(*) FROM approvals WHERE kind='permission' AND session_id=? AND fingerprint=? AND status IN ('pending','decided','delivered') AND created_at<=?`, sid, fp, store.TS(e.OccurredAt)).Scan(&n); err != nil {
				return err
			}
			if n != 1 {
				continue
			}
		}
		if _, err := tx.Exec(`UPDATE approvals SET status='confirmed',confirmed_at=? WHERE id=? AND status='delivered'`, now, id); err != nil {
			return err
		}
		return store.Touch(tx, now, "approval", id)
	}
	return nil
}
