package core

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestAutomaticMemoryDeliveryHistoryAndNotifications(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		t.Run(map[bool]string{false: "manual", true: "automatic"}[automatic], func(t *testing.T) {
			c := newCore(t, nil)
			if automatic {
				c.AutomaticMemoryProjects = []string{"/repo/.git"}
			}
			ctx := context.Background()
			if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "MEM-1", Title: "整合代理记忆", RepoPath: t.TempDir()}); err != nil {
				t.Fatal(err)
			}
			at := time.Now().UTC()
			claim := ev("routine", event.KindClaim, at)
			claim.WorkTag = "MEM-1"
			if _, err := c.Ingest(ctx, claim); err != nil {
				t.Fatal(err)
			}
			deliver := ev("routine", event.KindDeliver, at.Add(time.Second))
			deliver.Text = "Synthetic checks completed"
			if _, err := c.Ingest(ctx, deliver); err != nil {
				t.Fatal(err)
			}
			if _, err := c.Ingest(ctx, ev("routine", event.KindStop, at.Add(2*time.Second))); err != nil {
				t.Fatal(err)
			}
			snap, err := c.Snapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			w := snap.WorkItems[0]
			if w.Status != "review" || w.AutomaticHistory != automatic {
				t.Fatalf("completion must not become user acceptance: %+v", w)
			}
			n := &Notifier{C: c, since: "2000-01-01T00:00:00Z", BaseURL: "http://127.0.0.1:1"}
			alerts, err := n.Pending(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if automatic && len(alerts) != 0 || !automatic && len(alerts) != 1 {
				t.Fatalf("wrong successful-delivery notification: %+v", alerts)
			}
			if !automatic {
				return
			}
			blocked := ev("routine", event.KindReport, at.Add(3*time.Second))
			blocked.Brief = map[string]string{"blocker": "Synthetic unresolved issue", "next_owner": "user", "stage": "implementing"}
			if _, err := c.Ingest(ctx, blocked); err != nil {
				t.Fatal(err)
			}
			snap, err = c.Snapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if snap.WorkItems[0].AutomaticHistory || snap.WorkItems[0].AutomaticIssue == "" {
				t.Fatal("unresolved issue was hidden")
			}
			alerts, err = n.Pending(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if len(alerts) != 1 || !strings.HasPrefix(alerts[0].Key, "routine:") || strings.Contains(alerts[0].Body, "Synthetic") {
				t.Fatalf("expected one private-content-free exception alert: %+v", alerts)
			}
			if err := n.Check(ctx); err != nil {
				t.Fatal(err)
			}
			alerts, err = n.Pending(ctx)
			if err != nil || len(alerts) != 0 {
				t.Fatal("same exception should not notify repeatedly", alerts, err)
			}
			recovered := ev("routine", event.KindDeliver, at.Add(4*time.Second))
			recovered.Brief = map[string]string{"blocker": "", "progress": "Synthetic recovery checked"}
			if _, err := c.Ingest(ctx, recovered); err != nil {
				t.Fatal(err)
			}
			snap, err = c.Snapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if !snap.WorkItems[0].AutomaticHistory {
				t.Fatal("successful recovery did not return to history")
			}
			alerts, err = n.Pending(ctx)
			if err != nil || len(alerts) != 0 {
				t.Fatalf("success notified after recovery: %+v %v", alerts, err)
			}
			decision := ev("routine", event.KindAsk, at.Add(5*time.Second))
			decision.Text = "Synthetic explicit decision"
			if _, err := c.Ingest(ctx, decision); err != nil {
				t.Fatal(err)
			}
			alerts, err = n.Pending(ctx)
			if err != nil || len(alerts) != 1 || alerts[0].Title != "需要你：做决定" {
				t.Fatal("explicit decision must not become routine acceptance", alerts, err)
			}
		})
	}
}

func TestRoutineDeliveredFollowupDoesNotInventDecision(t *testing.T) {
	c, n, now := routineNotifierFixture(t)
	ctx := context.Background()
	*now = now.Add(time.Minute)
	delivery := ev("routine-boundary", event.KindDeliver, *now)
	delivery.Text = "Synthetic summary completed and checked"
	mustIngest(t, c, delivery)
	*now = now.Add(time.Second)
	mustIngest(t, c, ev("routine-boundary", event.KindStop, *now))
	*now = now.Add(time.Second)
	mustIngest(t, c, report("routine-boundary", *now, map[string]string{
		"summary": "Synthetic summary checked", "progress": "Synthetic maintenance complete",
		"stage": "validating", "next_owner": "user", "next": "The summary is available for the next conversation.",
	}))
	snap, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	w := snap.WorkItems[0]
	if !w.AutomaticHistory || w.AutomaticIssue != "" || w.Status != "review" || w.Management != nil {
		t.Fatalf("informational follow-up became a decision or user acceptance: %+v", w)
	}
	assertNoPending(t, n)

	// Real questions still surface once, and answering closes the question
	// without accepting the work or leaving the ask text as a permanent blocker.
	*now = now.Add(time.Second)
	ask := ev("routine-boundary", event.KindAsk, *now)
	ask.Text = "Synthetic suggestion: remember my preferred report format? Reason: future reports can follow it."
	mustIngest(t, c, ask)
	snap, err = c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snap.WorkItems[0].AutomaticHistory || snap.WorkItems[0].AutomaticIssueKind != "formal" {
		t.Fatalf("real memory question lost or duplicated as blocker: %+v", snap.WorkItems[0])
	}
	alerts, err := n.Pending(ctx)
	if err != nil || len(alerts) != 1 || alerts[0].Title != "需要你：做决定" {
		t.Fatalf("real question must notify once: %+v %v", alerts, err)
	}
	*now = now.Add(time.Second)
	mustIngest(t, c, ev("routine-boundary", event.KindPrompt, *now))
	*now = now.Add(time.Second)
	mustIngest(t, c, ev("routine-boundary", event.KindStop, *now))
	snap, err = c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !snap.WorkItems[0].AutomaticHistory || snap.WorkItems[0].AutomaticIssue != "" || snap.WorkItems[0].Status != "review" {
		t.Fatalf("answered memory question did not return to quiet history: %+v", snap.WorkItems[0])
	}
	assertNoPending(t, n)
}

func TestRoutineFollowupCannotHideRealActivityOrFailures(t *testing.T) {
	for _, test := range []string{"active-session", "new-run", "blocker", "error", "new-work", "no-delivery", "validating-without-delivery", "formal"} {
		t.Run(test, func(t *testing.T) {
			c := newCore(t, nil)
			delivered, later := "2026-10-24T00:00:00.000000000Z", "2026-10-24T00:01:00.000000000Z"
			w := WorkItem{ID: "MEM-1", Title: "整理记忆", Status: "review", Ready: true,
				Brief: &Brief{LastDeliveredAt: delivered, Fields: map[string]*BriefField{
					"stage":      {Text: "validating", At: later, Source: "report"},
					"summary":    {Text: "Synthetic checked result", At: later, Source: "report"},
					"next_owner": {Text: "user", At: later, Source: "report"},
				}}}
			snap := Snapshot{Now: later}
			s := Session{ID: 1, WorkItemID: w.ID, DataSource: "live", State: "running", Freshness: "live", LastActivityAt: later}
			switch test {
			case "active-session":
				snap.Sessions = []Session{s}
			case "new-run":
				snap.Runs = []Run{{WorkItemID: w.ID, SessionID: 1, StartedAt: later}}
			case "blocker":
				w.Brief.Fields["blocker"] = &BriefField{Text: "Synthetic failure", At: later, Source: "report"}
			case "error":
				s.State = "error"
				snap.Sessions = []Session{s}
			case "new-work":
				w.Brief.Fields["stage"].Text = "implementing"
			case "no-delivery", "validating-without-delivery":
				w.Brief.LastDeliveredAt = ""
			case "formal":
				snap.Approvals = []Approval{{ID: "real-question", WorkItemID: &w.ID, Kind: "decision", Status: "pending", CreatedAt: later}}
			}
			c.routineState(&snap, &w)
			if w.AutomaticHistory {
				t.Fatalf("active/incomplete/exceptional round hidden: %+v", w)
			}
			if (test == "blocker" || test == "error" || test == "formal") && w.AutomaticIssue == "" {
				t.Fatal("real exception lost")
			}
		})
	}
}

func TestMemoryMaintenanceNamesKeepScopedHistory(t *testing.T) {
	for _, title := range []string{
		"整合代理记忆", "整理本地 Agent 记忆", "整理记忆",
		"Consolidate agent memory", "Consolidate memories",
		"更新跨会话记忆摘要", "整理会话记忆摘要", "整理跨对话记忆摘要",
		"Update cross-session memory summary", "UPDATE CROSS SESSION MEMORY SUMMARY",
	} {
		t.Run(title, func(t *testing.T) {
			for _, scope := range []struct {
				name, common string
				allowed      []string
				wantHistory  bool
			}{
				{"legacy-repo", "/approved/memories/.git", []string{"/approved/memories/.git"}, true},
				{"second-repo", "/approved/memories-v2/.git", []string{"/approved/memories/.git", "/approved/memories-v2/.git"}, true},
				{"not-enabled", "/approved/memories/.git", nil, false},
				{"second-repo-not-approved", "/approved/memories-v2/.git", []string{"/approved/memories/.git"}, false},
				{"different-repo", "/business/.git", []string{"/approved/memories/.git"}, false},
			} {
				t.Run(scope.name, func(t *testing.T) {
					c := newCore(t, nil)
					c.AutomaticMemoryProjects = scope.allowed
					id, at := int64(1), "2026-10-24T00:00:00.000000000Z"
					snap := Snapshot{
						Now: at, Repos: []Repo{{ID: id, CommonDir: scope.common}},
						WorkItems: []WorkItem{{ID: "MEM-1", RepoID: &id, Title: title, Status: "review", Ready: true,
							Brief: &Brief{LastDeliveredAt: at}}},
					}
					c.applyRoutinePolicies(&snap)
					got := snap.WorkItems[0]
					if got.AutomaticHistory != scope.wantHistory {
						t.Fatalf("history=%v want %v: %+v", got.AutomaticHistory, scope.wantHistory, got)
					}
					if got.Status != "review" || got.Management != nil {
						t.Fatal("routine classification changed user acceptance")
					}
				})
			}
		})
	}
}

func TestMemoryMaintenanceNamesDoNotHideBusinessWork(t *testing.T) {
	for _, title := range []string{
		"实现记忆搜索产品", "更新跨会话记忆摘要生成器", "整理会话记忆摘要的验收标准",
		"Implement agent memory search", "Consolidate agent memory search results", "Consolidate company memories",
	} {
		t.Run(title, func(t *testing.T) {
			c := newCore(t, nil)
			c.AutomaticMemoryProjects = []string{"/approved/.git"}
			id := int64(1)
			snap := Snapshot{Repos: []Repo{{ID: id, CommonDir: "/approved/.git"}},
				WorkItems: []WorkItem{{ID: "TASK-1", RepoID: &id, Title: title, Status: "review", Ready: true,
					Brief: &Brief{LastDeliveredAt: "2026-10-24T00:00:00.000000000Z"}}}}
			c.applyRoutinePolicies(&snap)
			if snap.WorkItems[0].AutomaticHistory || snap.WorkItems[0].CompletionPolicy != "" {
				t.Fatal("business delivery was hidden as memory maintenance")
			}
		})
	}
}

func TestRoutineHistoryKeepsExceptionsAndRequiresDelivery(t *testing.T) {
	for _, title := range []string{"整理本地 Agent 记忆", "Consolidate agent memory", "更新跨会话记忆摘要", "整理会话记忆摘要"} {
		t.Run(title, func(t *testing.T) {
			for _, test := range []string{"success", "stop-only", "active", "error", "stalled", "formal", "validation", "unresolved-blocker", "new-work", "other-repo", "business-task"} {
				t.Run(test, func(t *testing.T) {
					c := newCore(t, nil)
					c.AutomaticMemoryProjects = []string{"/approved/.git"}
					id := int64(1)
					at := "2026-10-24T00:00:00.000000000Z"
					later := "2026-10-24T00:01:00.000000000Z"
					w := WorkItem{ID: "MEM-1", RepoID: &id, Title: title, Status: "review", Ready: true, UpdatedAt: at, Brief: &Brief{LastDeliveredAt: at, Fields: map[string]*BriefField{"progress": {Text: "Synthetic result", At: at, Source: "deliver"}}}}
					snap := Snapshot{Now: "2026-10-24T00:30:00.000000000Z", Repos: []Repo{{ID: 1, CommonDir: "/approved/.git"}}, WorkItems: []WorkItem{w}}
					s := Session{ID: 1, WorkItemID: w.ID, DataSource: "live", State: "idle", Freshness: "live", LastActivityAt: later}
					switch test {
					case "stop-only":
						snap.WorkItems[0].Brief.LastDeliveredAt = ""
					case "active":
						s.State = "running"
						snap.Sessions = []Session{s}
					case "error":
						s.State = "error"
						snap.Sessions = []Session{s}
					case "stalled":
						s.State = "running"
						s.Freshness = "stale"
						snap.Sessions = []Session{s}
					case "formal":
						work := w.ID
						snap.Approvals = []Approval{{ID: "formal", Kind: "decision", Status: "pending", WorkItemID: &work, CreatedAt: later}}
					case "validation":
						snap.Features = []ProjectFeature{{Validation: "failed", Contributions: []FeatureContribution{{WorkItemID: w.ID, At: "2026-10-23T00:00:00.000000000Z"}}}}
					case "unresolved-blocker":
						snap.WorkItems[0].Brief.Fields["blocker"] = &BriefField{Text: "Needs repair", At: at, Source: "report"}
					case "new-work":
						snap.WorkItems[0].Brief.Fields["stage"] = &BriefField{Text: "implementing", At: later, Source: "report"}
					case "other-repo":
						snap.Repos[0].CommonDir = "/unapproved/.git"
					case "business-task":
						snap.WorkItems[0].Title = "实现记忆搜索产品"
					}
					c.applyRoutinePolicies(&snap)
					got := snap.WorkItems[0]
					if got.AutomaticHistory != (test == "success") {
						t.Fatalf("incorrect history: %+v", got)
					}
					if (test == "error" || test == "stalled" || test == "formal" || test == "validation" || test == "unresolved-blocker") && got.AutomaticIssue == "" {
						t.Fatal("missing exception")
					}
					if got.Status != "review" {
						t.Fatal("policy rewrote acceptance")
					}
				})
			}
		})
	}
}
