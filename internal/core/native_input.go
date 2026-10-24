package core

import (
	"database/sql"
	"encoding/json"
	"errors"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

// Native questions are observations, never permission waiters. Keep the call
// identity so a matching answer closes only that question, not a peer's input.
func upsertNativeInput(tx *sql.Tx, sid int64, e *event.Event, now string) error {
	ref, err := permissionExecutionFor(tx, sid, e)
	if err != nil || ref.ToolUseID == "" {
		return err // do not recreate an already-completed or ambiguous call
	}
	var completed int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM events WHERE session_id=? AND kind IN ('tool_post','tool_fail')
		AND occurred_at>=? AND json_extract(body,'$.tool_name')=? AND json_extract(body,'$.tool_use_id')=?
		AND COALESCE(json_extract(body,'$.subagent_id'),'')=?`, sid, store.TS(e.OccurredAt), e.ToolName, ref.ToolUseID, ref.SubagentID).Scan(&completed); err != nil {
		return err
	}
	if completed > 0 {
		return nil // offline replay may deliver the completed call before its PreToolUse
	}
	var id string
	err = tx.QueryRow(`SELECT id FROM approvals WHERE session_id=? AND kind='decision'
		AND json_extract(payload,'$.source')='native_user_input'
		AND json_extract(payload,'$.execution.tool_use_id')=?
		AND COALESCE(json_extract(payload,'$.execution.subagent_id'),'')=? LIMIT 1`,
		sid, ref.ToolUseID, ref.SubagentID).Scan(&id)
	if err == nil {
		return nil // PreToolUse and PermissionRequest describe the same call
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return insertApproval(tx, approvalRow{kind: "decision", sessionID: sid,
		tool: e.ToolName, fp: e.Fingerprint, preview: e.Preview,
		payload: map[string]any{"source": "native_user_input", "execution": ref, "confidence": "high"}}, now)
}

func closeNativeInput(tx *sql.Tx, sid int64, e *event.Event, now string) error {
	rows, err := tx.Query(`SELECT id,created_at,fingerprint,tool_name,payload FROM approvals
		WHERE session_id=? AND kind='decision' AND status='pending'
		AND json_extract(payload,'$.source')='native_user_input'`, sid)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id, created, fp, tool, payload string
		if err := rows.Scan(&id, &created, &fp, &tool, &payload); err != nil {
			rows.Close()
			return err
		}
		a, err := decodePermissionEvidence(id, "pending", "", fp, tool, created, payload)
		if err != nil {
			rows.Close()
			return err
		}
		if a.Execution.ToolUseID != "" && a.matches(e) {
			ids = append(ids, id)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	reason := "answered_in_session"
	if e.Kind == event.KindToolFail {
		reason = "tool_failed"
	}
	for _, id := range ids {
		if _, err := tx.Exec(`UPDATE approvals SET status='cancelled',close_reason=?,closed_at=? WHERE id=? AND status='pending'`, reason, store.TS(e.OccurredAt), id); err != nil {
			return err
		}
		if err := store.Touch(tx, now, "approval", id); err != nil {
			return err
		}
	}
	return nil
}

// Older versions sent a generic allow for native questions. Recover only a
// unique call ID from the original request and reconcile real completion
// evidence; never infer an answer from silence or unrelated tool activity.
func reconcileLegacyNativePermissions(tx *sql.Tx, now string) error {
	rows, err := tx.Query(`SELECT a.id,a.session_id,a.payload,e.body FROM approvals a
		JOIN sessions s ON s.id=a.session_id JOIN events e ON e.event_id=json_extract(a.payload,'$.event_id')
		WHERE a.kind='permission' AND a.status='delivered' AND s.provider='claude'
		AND a.tool_name IN ('AskUserQuestion','ExitPlanMode')`)
	if err != nil {
		return err
	}
	type legacy struct {
		id            string
		sid           int64
		payload, body string
	}
	var old []legacy
	for rows.Next() {
		var v legacy
		if err := rows.Scan(&v.id, &v.sid, &v.payload, &v.body); err != nil {
			rows.Close()
			return err
		}
		old = append(old, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, v := range old {
		var e event.Event
		if err := json.Unmarshal([]byte(v.body), &e); err != nil {
			return err
		}
		ref, err := permissionExecutionFor(tx, v.sid, &e)
		if err != nil {
			return err
		}
		if ref.ToolUseID == "" {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(v.payload), &payload); err != nil {
			return err
		}
		payload["execution"] = ref
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(`UPDATE approvals SET payload=? WHERE id=?`, string(encoded), v.id); err != nil {
			return err
		}
		if err := reconcileDeliveredPermission(tx, v.id, now); err != nil {
			return err
		}
	}
	return nil
}
