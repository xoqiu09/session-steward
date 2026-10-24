package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

func nativeEvent(sid string, kind event.Kind, call string, at time.Time) *event.Event {
	e := ev(sid, kind, at)
	e.ToolName, e.ToolUseID = "AskUserQuestion", call
	e.Fingerprint, e.ExecutionFingerprint = "question-input", "question-input"
	e.Preview = "选择一种合成导出格式？"
	return e
}

func TestNativeInputReturnsToAgentAndClosesOnlyMatchingAnswer(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	at := time.Now().Add(time.Second)
	pre := nativeEvent("native", event.KindToolPre, "call-1", at)
	mustIngest(t, c, pre)
	request := nativeEvent("native", event.KindPermission, "", at.Add(time.Second))
	if _, _, ok, err := c.RequestPermission(ctx, request, time.Minute); err != nil || ok {
		t.Fatalf("native question must not wait or return allow: ok=%v err=%v", ok, err)
	}
	var n int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE kind='permission'`).Scan(&n)
	if n != 0 {
		t.Fatal("question incorrectly created a tool permission")
	}
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE kind='decision' AND status='pending'`).Scan(&n)
	if n != 1 {
		t.Fatalf("PreToolUse/PermissionRequest must coalesce: %d", n)
	}
	// A second, independent native question and unrelated activity stay open.
	mustIngest(t, c, nativeEvent("native", event.KindToolPre, "call-2", at.Add(2*time.Second)))
	post := nativeEvent("native", event.KindToolPost, "different-call", at.Add(3*time.Second))
	mustIngest(t, c, post)
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE kind='decision' AND status='pending'`).Scan(&n)
	if n != 2 {
		t.Fatal("unrelated call closed a question")
	}
	post = nativeEvent("native", event.KindToolPost, "call-1", at.Add(4*time.Second))
	post.Fingerprint, post.ExecutionFingerprint = "input-now-contains-answers", "input-now-contains-answers"
	mustIngest(t, c, post)
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE kind='decision' AND status='pending'`).Scan(&n)
	if n != 1 {
		t.Fatal("matching answer did not close exactly one question")
	}
	var status string
	c.St.R().QueryRow(`SELECT status FROM approvals WHERE json_extract(payload,'$.execution.tool_use_id')='call-1'`).Scan(&status)
	if status != "cancelled" {
		t.Fatalf("unexpected status %s", status)
	}
}

func TestNativeInputAmbiguityNeverChoosesLatestCall(t *testing.T) {
	c := newCore(t, nil)
	at := time.Now().Add(time.Second)
	mustIngest(t, c, nativeEvent("parallel", event.KindToolPre, "a", at))
	mustIngest(t, c, nativeEvent("parallel", event.KindToolPre, "b", at))
	request := nativeEvent("parallel", event.KindNotifyInput, "", at.Add(time.Second))
	var ref permissionExecution
	if err := c.St.Tx(context.Background(), func(tx *sql.Tx) error {
		var err error
		var sid int64
		tx.QueryRow(`SELECT id FROM sessions WHERE provider_session_id='parallel'`).Scan(&sid)
		ref, err = permissionExecutionFor(tx, sid, request)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if ref.ToolUseID != "" || !ref.Required {
		t.Fatalf("ambiguous calls were guessed: %+v", ref)
	}
}

func TestAnsweredNativeInputDoesNotReappearOnOfflineReplay(t *testing.T) {
	c := newCore(t, nil)
	at := time.Now().Add(time.Second)
	mustIngest(t, c, nativeEvent("offline", event.KindToolPost, "answered", at.Add(time.Second)))
	mustIngest(t, c, nativeEvent("offline", event.KindToolPre, "answered", at))
	var n int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE kind='decision' AND status='pending'`).Scan(&n)
	if n != 0 {
		t.Fatal("old replayed question reappeared after its answer")
	}
}

func TestExplicitAskCannotOverwriteNativeQuestionIdentity(t *testing.T) {
	c := newCore(t, nil)
	at := time.Now().Add(time.Second)
	mustIngest(t, c, nativeEvent("separate", event.KindToolPre, "question", at))
	ask := ev("separate", event.KindAsk, at.Add(time.Second))
	ask.Text = "A separate synthetic decision"
	mustIngest(t, c, ask)
	mustIngest(t, c, nativeEvent("separate", event.KindToolPost, "question", at.Add(2*time.Second)))
	var count int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE kind='decision' AND status='pending' AND json_extract(payload,'$.source')='steward-hook ask'`).Scan(&count)
	if count != 1 {
		t.Fatal("native answer changed a separate explicit decision")
	}
}

func TestStartupRepairsOnlyLegacyNativePermissionWithExactCallEvidence(t *testing.T) {
	c := newCore(t, nil)
	at := time.Now().Add(time.Second)
	mustIngest(t, c, nativeEvent("legacy", event.KindToolPre, "original-call", at))
	request := nativeEvent("legacy", event.KindPermission, "", at.Add(time.Second))
	mustIngest(t, c, request) // original normalized request, before the adapter fix
	var sid int64
	c.St.R().QueryRow(`SELECT id FROM sessions WHERE provider_session_id='legacy'`).Scan(&sid)
	var id string
	if err := c.St.Tx(context.Background(), func(tx *sql.Tx) error {
		var err error
		id, err = insertApprovalID(tx, approvalRow{kind: "permission", sessionID: sid, tool: request.ToolName, fp: request.Fingerprint, handleable: true, payload: map[string]any{"event_id": request.EventID, "execution": permissionExecution{}}}, store.TS(at.Add(time.Second)))
		if err != nil {
			return err
		}
		_, err = tx.Exec(`UPDATE approvals SET status='delivered',decision='allow',delivered_at=? WHERE id=?`, store.TS(at.Add(3*time.Second)), id)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	post := nativeEvent("legacy", event.KindToolPost, "original-call", at.Add(2*time.Second))
	post.Fingerprint, post.ExecutionFingerprint = "answered-input", "answered-input"
	mustIngest(t, c, post)
	if err := c.Startup(context.Background()); err != nil {
		t.Fatal(err)
	}
	var status, payload string
	c.St.R().QueryRow(`SELECT status,payload FROM approvals WHERE id=?`, id).Scan(&status, &payload)
	var p struct {
		Execution permissionExecution `json:"execution"`
	}
	json.Unmarshal([]byte(payload), &p)
	if status != "confirmed" || p.Execution.ToolUseID != "original-call" {
		t.Fatalf("legacy repair failed: %s %s", status, payload)
	}
}

func TestInputResolutionIsSessionScopedAndKeepsBriefContent(t *testing.T) {
	c, at := claimed(t, "INPUT-1")
	mustIngest(t, c, report("s1", at.Add(time.Minute), map[string]string{"next_owner": "user", "next": "Choose a synthetic option"}))
	mustIngest(t, c, ev("peer", event.KindPrompt, at.Add(2*time.Minute)))
	b := briefOf(t, c, "INPUT-1")
	sid := *b.Fields["next_owner"].SessionID
	if b.BySession[sid].InputResolvedAt != "" {
		t.Fatal("peer input cleared another session's handoff")
	}
	mustIngest(t, c, ev("s1", event.KindPrompt, at.Add(3*time.Minute)))
	b = briefOf(t, c, "INPUT-1")
	if b.BySession[sid].InputResolvedAt <= b.BySession[sid].Fields["next_owner"].At || b.Fields["next_owner"].Text != "user" {
		t.Fatal("input watermark missing or historical report rewritten")
	}
	post := nativeEvent("s1", event.KindToolPost, "answered", at.Add(4*time.Minute))
	mustIngest(t, c, post)
	if briefOf(t, c, "INPUT-1").BySession[sid].InputResolvedAt <= b.BySession[sid].InputResolvedAt {
		t.Fatal("native answer did not advance input watermark")
	}
}
