package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func codexHook(t *testing.T, name, turn, call, command string) *event.Event {
	t.Helper()
	input := map[string]any{"command": command, "timeout_ms": 10000}
	if name == "PermissionRequest" {
		input = map[string]any{"command": command, "description": "harmless integration check"}
	}
	raw, _ := json.Marshal(map[string]any{
		"session_id": "codex-correlation", "cwd": "/repo", "hook_event_name": name,
		"turn_id": turn, "tool_use_id": call, "tool_name": "Bash", "tool_input": input,
	})
	e, _, err := event.Normalize(raw, event.Options{
		Provider: "codex", HostID: "h", Env: func(string) string { return "" },
		NewID: func() string { return fmt.Sprintf("correlation-%d", idSeq.Add(1)) },
	})
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func requestCodexPermission(t *testing.T, c *Core, e *event.Event) (string, string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { c.RequestPermission(ctx, e, 5*time.Second) }()
	return waitPending(t, c)
}

func approvalStatus(t *testing.T, c *Core, id string) string {
	t.Helper()
	var status string
	if err := c.St.R().QueryRow(`SELECT status FROM approvals WHERE id=?`, id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func TestObservedPermissionClosesOnlyForItsToolCall(t *testing.T) {
	for _, call := range []string{"unknown-call", "write-call"} {
		t.Run(call, func(t *testing.T) {
			c := newCore(t, nil)
			ctx := context.Background()
			at := time.Now()
			read := ev("synthetic-parallel", event.KindToolPre, at)
			read.ToolName, read.ToolUseID = "Read", "read-call"
			mustIngest(t, c, read)
			notice := ev("synthetic-parallel", event.KindNotifyPerm, at.Add(time.Second))
			notice.Preview, notice.Reason = "等待允许写文件", "permission_prompt"
			if call == "write-call" {
				notice.ToolName, notice.ToolUseID = "Write", call
			}
			mustIngest(t, c, notice)
			approval := func() Approval {
				t.Helper()
				snap, err := c.Snapshot(ctx)
				if err != nil || len(snap.Approvals) != 1 {
					t.Fatalf("expected one permission notice in snapshot: %v", err)
				}
				return snap.Approvals[0]
			}
			before := approval()
			if before.Kind != "permission" || before.Handleable || before.Status != "pending" {
				t.Fatalf("expected an observation-only permission notice, got %+v", before)
			}

			done := ev("synthetic-parallel", event.KindToolPost, at.Add(2*time.Second))
			done.ToolName, done.ToolUseID = read.ToolName, read.ToolUseID
			mustIngest(t, c, done)
			if after := approval(); after.Status != "pending" || after.CloseReason != "" {
				t.Fatalf("unrelated Read completion: status = %q, close_reason = %q, want pending and no receipt", after.Status, after.CloseReason)
			}
			otherWrite := ev("synthetic-parallel", event.KindToolFail, at.Add(3*time.Second))
			otherWrite.ToolName, otherWrite.ToolUseID = "Write", "another-write-call"
			mustIngest(t, c, otherWrite)
			if after := approval(); after.Status != "pending" || after.CloseReason != "" {
				t.Fatalf("different Write call failed: status = %q, close_reason = %q, want pending and no receipt", after.Status, after.CloseReason)
			}

			write := ev("synthetic-parallel", event.KindToolPost, at.Add(4*time.Second))
			write.ToolName, write.ToolUseID = "Write", "write-call"
			mustIngest(t, c, write)
			if after := approval(); call == "write-call" {
				if after.Status != "cancelled" || after.CloseReason != "resolved_elsewhere" {
					t.Fatalf("matching Write completion: status = %q, close_reason = %q", after.Status, after.CloseReason)
				}
			} else {
				if after.Status != "pending" || after.CloseReason != "" {
					t.Fatalf("unidentified notice: status = %q, close_reason = %q, want pending and no receipt", after.Status, after.CloseReason)
				}
				if err := c.Dismiss(ctx, before.ID, "dismissed", ""); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestObservedParallelPermissionsKeepDistinctCalls(t *testing.T) {
	c := newCore(t, nil)
	at := time.Now()
	for i, call := range []struct{ tool, id string }{
		{"Read", "read-call"},
		{"Read", "read-call"}, // A second notice for the same call is a duplicate.
		{"Write", "write-call"},
	} {
		notice := ev("synthetic-parallel-notices", event.KindNotifyPerm, at.Add(time.Duration(i)*time.Second))
		notice.ToolName, notice.ToolUseID, notice.TurnID = call.tool, call.id, "turn-1"
		mustIngest(t, c, notice)
	}
	done := ev("synthetic-parallel-notices", event.KindToolPost, at.Add(3*time.Second))
	done.ToolName, done.ToolUseID, done.TurnID = "Read", "read-call", "turn-1"
	mustIngest(t, c, done)
	snap, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Approvals) != 2 {
		t.Fatalf("after Read completed: got %d reminders, want one for Read and one for Write", len(snap.Approvals))
	}
	got := make(map[string]string)
	for _, a := range snap.Approvals {
		got[a.ToolName] = a.Status
	}
	if got["Read"] != "cancelled" || got["Write"] != "pending" {
		t.Fatalf("after Read completed: got %v, want Read cancelled and Write pending", got)
	}
}

func TestObservedPermissionUsesCallIDWhenToolNameIsMissing(t *testing.T) {
	for _, tc := range []struct{ name, noticeTool, doneTool, want string }{
		{"notice-name-missing", "", "Write", "cancelled"},
		{"completion-name-missing", "Write", "", "cancelled"},
		{"different-known-names", "Write", "Read", "pending"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newCore(t, nil)
			at := time.Now()
			notice := ev("synthetic-notice-tool-name", event.KindNotifyPerm, at)
			notice.ToolName, notice.ToolUseID, notice.TurnID = tc.noticeTool, "write-call", "turn-1"
			mustIngest(t, c, notice)
			done := ev("synthetic-notice-tool-name", event.KindToolPost, at.Add(time.Second))
			done.ToolName, done.ToolUseID, done.TurnID = tc.doneTool, notice.ToolUseID, notice.TurnID
			mustIngest(t, c, done)
			var status string
			if err := c.St.R().QueryRow(`SELECT status FROM approvals WHERE kind='permission' AND handleable=0`).Scan(&status); err != nil {
				t.Fatal(err)
			}
			if status != tc.want {
				t.Fatalf("after matching call completed: got %q, want %q", status, tc.want)
			}
		})
	}
}

func TestCodexPermissionConfirmsMatchingCallDespiteDifferentPayloads(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	pre := codexHook(t, "PreToolUse", "turn-1", "call-1", "printf OK")
	if _, err := c.Ingest(ctx, pre); err != nil {
		t.Fatal(err)
	}
	perm := codexHook(t, "PermissionRequest", "turn-1", "", "printf OK")
	id, fp := requestCodexPermission(t, c, perm)
	if fp == pre.Fingerprint {
		t.Fatal("fixture must reproduce different request/execution fingerprints")
	}
	// 相同执行签名不能替代完整的审批内容指纹。
	if err := c.Decide(ctx, id, pre.ExecutionFingerprint, Decision{Behavior: "allow"}); !errors.Is(err, ErrMismatch) {
		t.Fatalf("authorization identity was weakened: %v", err)
	}
	if err := c.Decide(ctx, id, fp, Decision{Behavior: "allow"}); err != nil {
		t.Fatal(err)
	}
	if err := c.AckDelivered(ctx, id); err != nil {
		t.Fatal(err)
	}
	for _, unrelated := range []*event.Event{
		codexHook(t, "PostToolUse", "turn-1", "another-call", "printf OK"),
		codexHook(t, "PostToolUse", "another-turn", "call-1", "printf OK"),
	} {
		if _, err := c.Ingest(ctx, unrelated); err != nil {
			t.Fatal(err)
		}
		if got := approvalStatus(t, c, id); got != "delivered" {
			t.Fatalf("unrelated completion confirmed request: %s", got)
		}
	}
	if _, err := c.Ingest(ctx, codexHook(t, "PostToolUse", "turn-1", "call-1", "printf OK")); err != nil {
		t.Fatal(err)
	}
	if got := approvalStatus(t, c, id); got != "confirmed" {
		t.Fatalf("matching completion: %s", got)
	}
}

func TestCodexCompletionBeforeDeliveredAck(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	c.Ingest(ctx, codexHook(t, "PreToolUse", "turn-1", "call-1", "printf OK"))
	id, fp := requestCodexPermission(t, c, codexHook(t, "PermissionRequest", "turn-1", "", "printf OK"))
	if err := c.Decide(ctx, id, fp, Decision{Behavior: "allow"}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Ingest(ctx, codexHook(t, "PostToolUse", "turn-1", "call-1", "printf OK")); err != nil {
		t.Fatal(err)
	}
	if got := approvalStatus(t, c, id); got != "decided" {
		t.Fatalf("completion cannot pretend adapter delivered: %s", got)
	}
	if err := c.AckDelivered(ctx, id); err != nil {
		t.Fatal(err)
	}
	if got := approvalStatus(t, c, id); got != "confirmed" {
		t.Fatalf("late delivery ack did not reconcile: %s", got)
	}
}

func TestCodexAmbiguousConcurrentCallsRemainUnconfirmed(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	c.Ingest(ctx, codexHook(t, "PreToolUse", "turn-1", "call-1", "printf OK"))
	c.Ingest(ctx, codexHook(t, "PreToolUse", "turn-1", "call-2", "printf OK"))
	id, fp := requestCodexPermission(t, c, codexHook(t, "PermissionRequest", "turn-1", "", "printf OK"))
	if err := c.Decide(ctx, id, fp, Decision{Behavior: "allow"}); err != nil {
		t.Fatal(err)
	}
	if err := c.AckDelivered(ctx, id); err != nil {
		t.Fatal(err)
	}
	for _, call := range []string{"call-1", "call-2"} {
		if _, err := c.Ingest(ctx, codexHook(t, "PostToolUse", "turn-1", call, "printf OK")); err != nil {
			t.Fatal(err)
		}
	}
	if got := approvalStatus(t, c, id); got != "delivered" {
		t.Fatalf("ambiguous calls were guessed: %s", got)
	}
}

func TestCodexCompletedAndOtherTurnCallsDoNotBind(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	c.Ingest(ctx, codexHook(t, "PreToolUse", "turn-1", "old-call", "printf OK"))
	c.Ingest(ctx, codexHook(t, "PostToolUse", "turn-1", "old-call", "printf OK"))
	c.Ingest(ctx, codexHook(t, "PreToolUse", "old-turn", "other-call", "printf OK"))
	id, fp := requestCodexPermission(t, c, codexHook(t, "PermissionRequest", "turn-1", "", "printf OK"))
	c.Decide(ctx, id, fp, Decision{Behavior: "allow"})
	c.AckDelivered(ctx, id)
	c.Ingest(ctx, codexHook(t, "PostToolUse", "turn-1", "old-call", "printf OK"))
	if got := approvalStatus(t, c, id); got != "delivered" {
		t.Fatalf("old evidence confirmed new request: %s", got)
	}
}

func TestCodexNativeCompletionClosesMatchingPendingRequest(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	c.Ingest(ctx, codexHook(t, "PreToolUse", "turn-1", "call-1", "printf OK"))
	id, _ := requestCodexPermission(t, c, codexHook(t, "PermissionRequest", "turn-1", "", "printf OK"))
	c.Ingest(ctx, codexHook(t, "PostToolUse", "turn-1", "call-1", "printf OK"))
	if got := approvalStatus(t, c, id); got != "cancelled" {
		t.Fatalf("pending approval not closed: %s", got)
	}
}

func TestSnapshotCanonicalizesPreviouslyStoredCodexClients(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	e := codexHook(t, "PreToolUse", "turn-1", "call-1", "printf OK")
	c.Ingest(ctx, e)
	for old, want := range map[string]string{"Codex Desktop": "desktop", "codex-tui": "cli"} {
		if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
			_, err := tx.Exec(`UPDATE sessions SET client=?`, old)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		snap, err := c.Snapshot(ctx)
		if err != nil || len(snap.Sessions) != 1 || snap.Sessions[0].Client != want {
			t.Fatalf("old=%s snap=%+v err=%v", old, snap, err)
		}
	}
}
