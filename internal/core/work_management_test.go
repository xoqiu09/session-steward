package core

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func managedItem(t *testing.T, c *Core, id string) WorkItem {
	t.Helper()
	s, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range s.WorkItems {
		if w.ID == id {
			return w
		}
	}
	t.Fatal("missing item", id)
	return WorkItem{}
}

func TestWorkManagementPreservesExecutionAndFormalRequests(t *testing.T) {
	for _, state := range []string{"paused", "delegated"} {
		t.Run(state, func(t *testing.T) {
			c, at := claimed(t, "MG-1")
			ctx := context.Background()
			mustIngest(t, c, report("s1", at.Add(time.Minute), map[string]string{"blocker": "old problem", "next_owner": "user", "next": "review externally"}))
			if err := c.UpdateWorkItem(ctx, "MG-1", WorkItemPatch{Management: &WorkManagement{State: state, Owner: "fixture-owner", Note: "handled elsewhere", At: "fake-time"}}); err != nil {
				t.Fatal(err)
			}
			w := managedItem(t, c, "MG-1")
			if w.Management == nil || w.Management.State != state || w.Management.At == "fake-time" || w.Status == "done" || w.MergeState == "merged" {
				t.Fatalf("unexpected state %+v", w)
			}
			var active int
			c.St.R().QueryRow(`SELECT COUNT(*) FROM runs WHERE work_item_id='MG-1' AND ended_at=''`).Scan(&active)
			if active != 1 {
				t.Fatal("management stopped execution", active)
			}
			// A later Agent report updates its own brief, but cannot undo the user's disposition.
			fresh := time.Now().UTC().Add(time.Second)
			mustIngest(t, c, report("s1", fresh, map[string]string{"progress": "new agent report", "blocker": "new report", "next_owner": "user", "next": "external action"}))
			w = managedItem(t, c, "MG-1")
			if w.Management.State != state || w.Brief.Fields["progress"].Text != "new agent report" {
				t.Fatal("report lost or overwrote user disposition", w)
			}
			// Soft reminders are quiet; an explicit formal decision remains visible and notifies.
			n := &Notifier{C: c, since: "2000-01-01T00:00:00Z", BaseURL: "http://127.0.0.1:1"}
			alerts, err := n.Pending(ctx)
			if err != nil || len(alerts) != 0 {
				t.Fatal("managed soft reminder leaked", alerts, err)
			}
			ask := ev("s1", event.KindAsk, fresh.Add(time.Second))
			ask.Text = "explicit decision"
			mustIngest(t, c, ask)
			alerts, err = n.Pending(ctx)
			if err != nil || len(alerts) != 1 || !strings.HasPrefix(alerts[0].Key, "approval:") {
				t.Fatal("formal decision hidden", alerts, err)
			}
			hub, err := c.HubLocalSummary(ctx, "fixture", "Test Mac", false)
			if err != nil || hub.Snapshot.WorkItems[0].Management == nil || hub.Snapshot.WorkItems[0].Management.State != state || hub.Snapshot.WorkItems[0].Management.Owner != "" || hub.Snapshot.WorkItems[0].Management.Note != "" {
				t.Fatal("hub projection", hub, err)
			}
		})
	}
}

func TestContinueWorkClearsOldBlockerButKeepsHistoryAndNewReports(t *testing.T) {
	c, at := claimed(t, "MG-1")
	ctx := context.Background()
	mustIngest(t, c, report("s1", at.Add(time.Minute), map[string]string{"blocker": "old problem", "next_owner": "user", "next": "old next"}))
	for _, m := range []WorkManagement{{State: "delegated", Owner: "fixture"}, {State: "active", Note: "now verify the new result"}} {
		if err := c.UpdateWorkItem(ctx, "MG-1", WorkItemPatch{Management: &m}); err != nil {
			t.Fatal(err)
		}
	}
	w := managedItem(t, c, "MG-1")
	if w.Management != nil || w.Status != "in_progress" || w.Brief.Fields["blocker"] != nil || w.Brief.Fields["next_owner"].Text != "agent" || w.Brief.Fields["next"].Text != "now verify the new result" {
		t.Fatal("resume did not clear old handoff", w)
	}
	for _, own := range w.Brief.BySession {
		if own.Fields["blocker"] != nil || own.Fields["next_owner"] != nil {
			t.Fatal("old session handoff still active", own)
		}
	}
	history, err := c.BriefHistory(ctx, "MG-1")
	if err != nil {
		t.Fatal(err)
	}
	old, audit := false, 0
	for _, row := range history {
		if row["text"] == "old problem" {
			old = true
		}
		if row["field"] == "management" {
			audit++
		}
	}
	if !old || audit != 2 {
		t.Fatal("history lost", history)
	}
	mustIngest(t, c, report("s1", time.Now().Add(time.Second), map[string]string{"blocker": "fresh failure", "progress": "fresh report"}))
	w = managedItem(t, c, "MG-1")
	if w.Brief.Fields["blocker"].Text != "fresh failure" || w.Brief.Fields["progress"].Text != "fresh report" {
		t.Fatal("user management pinned Agent report", w.Brief)
	}
}

func TestUserAcceptanceClosesRunWithoutFakingMerge(t *testing.T) {
	c, dir, approval := gateRepo(t, nil)
	ctx := context.Background()
	before := managedItem(t, c, "GT-1")
	if err := c.UpdateWorkItem(ctx, "GT-1", WorkItemPatch{Management: &WorkManagement{State: "accepted", Note: "checked outside"}}); err != nil {
		t.Fatal(err)
	}
	w := managedItem(t, c, "GT-1")
	if w.Status != "done" || w.Management == nil || w.Management.State != "accepted" || w.MergeState != before.MergeState || w.MergeEvidence != nil {
		t.Fatal(w)
	}
	var active int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM runs WHERE work_item_id='GT-1' AND ended_at=''`).Scan(&active)
	if active != 0 {
		t.Fatal("run not closed")
	}
	var status string
	c.St.R().QueryRow(`SELECT status FROM approvals WHERE id=?`, approval).Scan(&status)
	if status != "decided" {
		t.Fatal("merge request rewritten", status)
	}
	_ = dir
	v := "in_progress"
	if err := c.UpdateWorkItem(ctx, "GT-1", WorkItemPatch{Status: &v}); err != nil {
		t.Fatal(err)
	}
	if managedItem(t, c, "GT-1").Management != nil {
		t.Fatal("explicit reopen retained old acceptance disposition")
	}
}

func TestWorkManagementValidationIsAtomic(t *testing.T) {
	c, _ := claimed(t, "MG-1")
	ctx := context.Background()
	v := "done"
	cases := []WorkItemPatch{
		{Title: &v, Management: &WorkManagement{State: "invalid"}},
		{Management: &WorkManagement{State: "delegated", Owner: "  "}},
		{Management: &WorkManagement{State: "paused", Note: strings.Repeat("字", 501)}},
		{Management: &WorkManagement{State: "delegated", Owner: strings.Repeat("字", 81)}},
		{Management: &WorkManagement{State: "paused"}, Status: &v},
	}
	for _, p := range cases {
		if err := c.UpdateWorkItem(ctx, "MG-1", p); !errors.Is(err, ErrBadRequest) {
			t.Fatal(err)
		}
	}
	w := managedItem(t, c, "MG-1")
	if w.Title != "x" || w.Management != nil || w.Status == "done" {
		t.Fatal("invalid patch partially wrote", w)
	}
	if err := c.UpdateWorkItem(ctx, "MG-404", WorkItemPatch{Management: &WorkManagement{State: "paused"}}); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
}
