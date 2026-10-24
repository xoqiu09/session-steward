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
			decision := ev("routine", event.KindReport, at.Add(5*time.Second))
			decision.Brief = map[string]string{"next_owner": "user", "next": "Synthetic explicit decision", "stage": "implementing"}
			if _, err := c.Ingest(ctx, decision); err != nil {
				t.Fatal(err)
			}
			alerts, err = n.Pending(ctx)
			if err != nil || len(alerts) != 1 || alerts[0].Title != "自动任务需要你回应" {
				t.Fatal("explicit decision must not become routine acceptance", alerts, err)
			}
		})
	}
}

func TestRoutineHistoryKeepsExceptionsAndRequiresDelivery(t *testing.T) {
	for _, test := range []string{"success", "stop-only", "active", "error", "stalled", "formal", "validation", "unresolved-blocker", "new-work", "other-repo", "business-task"} {
		t.Run(test, func(t *testing.T) {
			c := newCore(t, nil)
			c.AutomaticMemoryProjects = []string{"/approved/.git"}
			id := int64(1)
			at := "2026-10-24T00:00:00.000000000Z"
			later := "2026-10-24T00:01:00.000000000Z"
			w := WorkItem{ID: "MEM-1", RepoID: &id, Title: "整理本地 Agent 记忆", Status: "review", Ready: true, UpdatedAt: at, Brief: &Brief{LastDeliveredAt: at, Fields: map[string]*BriefField{"progress": {Text: "Synthetic result", At: at, Source: "deliver"}}}}
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
}
