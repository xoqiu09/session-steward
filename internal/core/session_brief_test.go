package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestParallelBriefsKeepEachReportersBlockerOwnerAndFreshness(t *testing.T) {
	c, at := claimed(t, "MULTI-1")
	mustIngest(t, c, report("s1", at.Add(time.Minute), map[string]string{"stage": "validating", "summary": "API check failed", "progress": "API check failed", "blocker": "Fix failed check", "next_owner": "agent", "next": "Repair API"}))
	first := *briefOf(t, c, "MULTI-1").Fields["progress"].SessionID
	start := ev("s2", event.KindSessionStart, at.Add(2*time.Minute))
	start.Source.Provider = "codex"
	mustIngest(t, c, start)
	claim := ev("s2", event.KindClaim, at.Add(2*time.Minute+time.Second))
	claim.Source.Provider, claim.WorkTag = "codex", "MULTI-1"
	mustIngest(t, c, claim)
	secondReport := report("s2", at.Add(3*time.Minute), map[string]string{"stage": "implementing", "summary": "UI prepared", "progress": "UI prepared", "blocker": "", "next_owner": "external", "next": "Wait for API"})
	secondReport.Source.Provider = "codex"
	mustIngest(t, c, secondReport)
	b := briefOf(t, c, "MULTI-1")
	second := *b.Fields["progress"].SessionID
	if len(b.BySession) != 2 || b.BySession[first].Fields["blocker"].Text != "Fix failed check" || b.BySession[second].Fields["blocker"] != nil {
		t.Fatalf("one reporter cleared the other's blocker: %+v", b.BySession)
	}
	if b.BySession[first].Fields["next_owner"].Text != "agent" || b.BySession[second].Fields["next_owner"].Text != "external" {
		t.Fatal("responsibility crossed reporter boundaries")
	}
	mustIngest(t, c, report("s1", at.Add(30*time.Second), map[string]string{"stage": "planning", "progress": "Late older report"}))
	for i := 0; i < 20; i++ {
		e := ev("s2", event.KindToolPost, at.Add(time.Duration(4+i)*time.Minute))
		e.Source.Provider = "codex"
		mustIngest(t, c, e)
	}
	b = briefOf(t, c, "MULTI-1")
	if b.BySession[first].Fields["stage"].Text != "validating" || b.BySession[first].Stale || b.BySession[first].ToolEventsSince != 0 {
		t.Fatal("peer events or old report changed first reporter's brief")
	}
	if !b.BySession[second].Stale || b.BySession[second].ToolEventsSince != 20 {
		t.Fatal("second reporter's stale count missing")
	}
	if err := c.CreateWorkItem(context.Background(), WorkItemInput{ID: "MULTI-2", Title: "Separate task"}); err != nil {
		t.Fatal(err)
	}
	transfer := ev("s2", event.KindClaim, at.Add(25*time.Minute))
	transfer.Source.Provider, transfer.WorkTag = "codex", "MULTI-2"
	mustIngest(t, c, transfer)
	other := report("s2", at.Add(26*time.Minute), map[string]string{"progress": "Different task"})
	other.Source.Provider = "codex"
	mustIngest(t, c, other)
	if briefOf(t, c, "MULTI-1").BySession[second].Fields["progress"].Text != "UI prepared" || briefOf(t, c, "MULTI-2").BySession[second].Fields["progress"].Text != "Different task" {
		t.Fatal("new task leaked back into the previous task")
	}
}

func TestStructuredDeliveryKeepsTextAndEnforcesUserHandoff(t *testing.T) {
	c, at := claimed(t, "MULTI-1")
	mustIngest(t, c, report("s1", at.Add(time.Minute), map[string]string{"blocker": "Old blocker"}))
	d := ev("s1", event.KindDeliver, at.Add(2*time.Minute))
	d.Text = "Delivery explanation"
	d.Brief = map[string]string{"summary": "Candidate ready", "progress": "Checks passed; live use not tested", "blocker": "", "next": "Review candidate and decide release", "stage": "validating", "next_owner": "agent"}
	mustIngest(t, c, d)
	b := briefOf(t, c, "MULTI-1")
	if b.Fields["summary"].Text != "Candidate ready" || b.Fields["progress"].Text != "Checks passed; live use not tested" || b.Fields["blocker"] != nil || b.Fields["next"].Text != "Review candidate and decide release" {
		t.Fatalf("delivery fields lost: %+v", b.Fields)
	}
	if b.Fields["stage"].Text != "review" || b.Fields["next_owner"].Text != "user" {
		t.Fatal("delivery must hand off to user without accepting")
	}
	if b.LastDeliveredAt != b.Fields["stage"].At {
		t.Fatal("delivery boundary missing")
	}
	mustIngest(t, c, report("s1", at.Add(150*time.Second), map[string]string{"stage": "validating", "next_owner": "agent"}))
	if briefOf(t, c, "MULTI-1").LastDeliveredAt != b.LastDeliveredAt {
		t.Fatal("later activity must preserve the whole-task delivery boundary")
	}
	bad := ev("s1", event.KindDeliver, at.Add(3*time.Minute))
	bad.Brief = map[string]string{"stage": "accepted", "summary": "Invalid acceptance"}
	if _, err := c.Ingest(context.Background(), bad); err == nil {
		t.Fatal("structured delivery must not accept its own work")
	}
}
