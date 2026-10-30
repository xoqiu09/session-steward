package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
)

func TestClaudeObservationsNeverDeliverOrChangeSessionState(t *testing.T) {
	for _, initial := range []event.Kind{event.KindToolPre, event.KindStop, event.KindStopFailure, event.KindNotifyPerm} {
		for _, kind := range []event.Kind{event.KindPermissionDenied, event.KindCwdChanged, event.KindCompact, event.KindTaskCompleted, event.KindNotifyOther} {
			t.Run(string(initial)+"/"+string(kind), func(t *testing.T) {
				c := newCore(t, nil)
				ctx := context.Background()
				at := time.Now().UTC()
				if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "SYN-1", Title: "Synthetic"}); err != nil {
					t.Fatal(err)
				}
				start, err := c.Ingest(ctx, ev("synthetic", initial, at))
				if err != nil {
					t.Fatal(err)
				}
				if err := c.BindManual(ctx, start.SessionID, "SYN-1"); err != nil {
					t.Fatal(err)
				}
				before, _ := sessionState(t, c, "synthetic")
				var approvalsBefore int
				c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals`).Scan(&approvalsBefore)
				observation := ev("synthetic", kind, at.Add(time.Second))
				observation.Reason = "agent_completed"
				mustIngest(t, c, observation)
				if got, _ := sessionState(t, c, "synthetic"); got != before {
					t.Fatalf("Observation changed %s to %s", before, got)
				}
				var status, ended, outcome string
				var approvalsAfter int
				c.St.R().QueryRow(`SELECT status FROM work_items WHERE id='SYN-1'`).Scan(&status)
				c.St.R().QueryRow(`SELECT ended_at,outcome FROM runs WHERE work_item_id='SYN-1'`).Scan(&ended, &outcome)
				c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals`).Scan(&approvalsAfter)
				if status != "in_progress" || ended != "" || outcome != "" || approvalsAfter != approvalsBefore {
					t.Fatalf("Observation wrote a completion or decision: %s %s %s %d/%d", status, ended, outcome, approvalsBefore, approvalsAfter)
				}
			})
		}
	}
}

func TestQuotaSignalsOnlyApplyConfirmedMeaningAndRespectOrder(t *testing.T) {
	c := newCore(t, nil)
	at := time.Now().UTC()
	mustIngest(t, c, ev("quota", event.KindStop, at))
	stale := ev("quota", event.KindQuotaAwaitInput, at.Add(2*time.Second))
	stale.Reason = "quota_auto_resume_stale"
	mustIngest(t, c, stale)
	if state, _ := sessionState(t, c, "quota"); state != "idle" {
		t.Fatal(state)
	}
	fired := ev("quota", event.KindQuotaResumed, at.Add(3*time.Second))
	fired.Reason = "quota_auto_resume_fired"
	mustIngest(t, c, fired)
	if state, _ := sessionState(t, c, "quota"); state != "running" {
		t.Fatal(state)
	}
	mustIngest(t, c, ev("quota", event.KindQuotaAwaitInput, at.Add(time.Second)))
	if state, _ := sessionState(t, c, "quota"); state != "running" {
		t.Fatal("Late quota signal reversed running")
	}
	for _, reason := range []string{"quota_auto_resume_disabled", "quota_auto_resume_unknown"} {
		e := ev("quota", event.KindNotifyOther, at.Add(4*time.Second))
		e.Reason = reason
		mustIngest(t, c, e)
		if state, _ := sessionState(t, c, "quota"); state != "running" {
			t.Fatal("Uncertain quota signal changed state")
		}
	}
	var approvals, items int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals`).Scan(&approvals)
	c.St.R().QueryRow(`SELECT COUNT(*) FROM work_items`).Scan(&items)
	if approvals != 0 || items != 0 {
		t.Fatal("Quota signals invented work or approval")
	}
}

type cwdLocator struct{}

func (cwdLocator) Locate(_ context.Context, cwd string) gitx.Location {
	return gitx.Location{IsGit: true, CommonDir: cwd + "/.git", Worktree: cwd, Branch: "main", RepoName: cwd}
}

func TestCwdChangedMovesUnboundSessionButKeepsManualWork(t *testing.T) {
	for _, bound := range []bool{false, true} {
		t.Run(map[bool]string{false: "unbound", true: "manual"}[bound], func(t *testing.T) {
			c := newCore(t, cwdLocator{})
			ctx := context.Background()
			at := time.Now().UTC()
			start := ev("moving", event.KindSessionStart, at)
			start.Cwd = "/repo-a"
			r, err := c.Ingest(ctx, start)
			if err != nil {
				t.Fatal(err)
			}
			var repoA int64
			c.St.R().QueryRow(`SELECT repo_id FROM sessions WHERE id=?`, r.SessionID).Scan(&repoA)
			if bound {
				if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "SYN-1", Title: "Synthetic A", RepoID: repoA}); err != nil {
					t.Fatal(err)
				}
				if err := c.BindManual(ctx, r.SessionID, "SYN-1"); err != nil {
					t.Fatal(err)
				}
			}
			move := ev("moving", event.KindCwdChanged, at.Add(2*time.Second))
			move.Cwd = "/repo-b"
			mustIngest(t, c, move)
			var cwd, worktree string
			var repoB int64
			c.St.R().QueryRow(`SELECT cwd,worktree,repo_id FROM sessions WHERE id=?`, r.SessionID).Scan(&cwd, &worktree, &repoB)
			if cwd != "/repo-b" || worktree != "/repo-b" || repoA == repoB {
				t.Fatalf("Location not moved: %s %s %d/%d", cwd, worktree, repoA, repoB)
			}
			late := ev("moving", event.KindCwdChanged, at.Add(time.Second))
			late.Cwd = "/repo-a"
			mustIngest(t, c, late)
			c.St.R().QueryRow(`SELECT cwd FROM sessions WHERE id=?`, r.SessionID).Scan(&cwd)
			if cwd != "/repo-b" {
				t.Fatal("Late event reversed location")
			}
			var count int
			c.St.R().QueryRow(`SELECT COUNT(*) FROM runs`).Scan(&count)
			if !bound && count != 0 {
				t.Fatal("Directory change automatically created work binding")
			}
			if bound {
				var item, binding string
				c.St.R().QueryRow(`SELECT work_item_id,binding FROM runs WHERE session_id=? AND ended_at=''`, r.SessionID).Scan(&item, &binding)
				if item != "SYN-1" || binding != "manual" {
					t.Fatal("Explicit work binding changed")
				}
			}
		})
	}
}
