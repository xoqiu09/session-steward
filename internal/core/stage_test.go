package core

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestStageAndOwnerFollowContentOrder(t *testing.T) {
	c, at := claimed(t, "PH-1")
	mustIngest(t, c, report("s1", at.Add(2*time.Minute), map[string]string{"stage": "validating", "next_owner": "external", "summary": "Checks running", "progress": "New evidence"}))
	mustIngest(t, c, report("s1", at.Add(time.Minute), map[string]string{"stage": "planning", "next_owner": "user", "summary": "Old spooled report"}))
	b := briefOf(t, c, "PH-1")
	if b.Fields["stage"].Text != "validating" || b.Fields["next_owner"].Text != "external" || b.Fields["summary"].Text != "Checks running" {
		t.Fatalf("older report replaced current phase: %+v", b)
	}
	if b.Fields["stage"].Kind != "agent" || b.Fields["stage"].SessionID == nil {
		t.Fatal("phase must preserve provenance")
	}
}

func TestStageCannotSelfAcceptOrSkipDelivery(t *testing.T) {
	c, at := claimed(t, "PH-1")
	for _, fields := range []map[string]string{{"stage": "accepted"}, {"stage": "review"}, {"stage": "70%"}, {"next_owner": "someone"}} {
		fields["summary"] = "Must not leak through failed validation"
		if _, err := c.Ingest(context.Background(), report("s1", at.Add(time.Minute), fields)); err == nil {
			t.Fatalf("invalid phase accepted: %v", fields)
		}
	}
	if b := briefOf(t, c, "PH-1"); b != nil {
		t.Fatalf("invalid report was partially written: %+v", b)
	}
}

func TestStageDeliveryAndReopenStartFreshCycle(t *testing.T) {
	c, at := claimed(t, "PH-1")
	ctx := context.Background()
	mustIngest(t, c, report("s1", at.Add(time.Minute), map[string]string{"goal": "Stable goal", "stage": "validating", "next_owner": "agent", "summary": "First cycle complete", "progress": "Old result", "next": "Review old result"}))
	d := ev("s1", event.KindDeliver, at.Add(2*time.Minute))
	d.Text = "Ready for owner review"
	mustIngest(t, c, d)
	b := briefOf(t, c, "PH-1")
	if b.Fields["stage"].Text != "review" || b.Fields["next_owner"].Text != "user" || b.Fields["next"].Source != "deliver" {
		t.Fatal("delivery must hand off to user")
	}
	if _, err := c.EditBrief(ctx, "PH-1", BriefEdit{Field: "progress", Action: "confirm", EntryID: b.Fields["progress"].EntryID}); err != nil {
		t.Fatal(err)
	}
	done := "done"
	if err := c.UpdateWorkItem(ctx, "PH-1", WorkItemPatch{Status: &done}); err != nil {
		t.Fatal(err)
	}
	active := "in_progress"
	if err := c.UpdateWorkItem(ctx, "PH-1", WorkItemPatch{Status: &active}); err != nil {
		t.Fatal(err)
	}
	b = briefOf(t, c, "PH-1")
	if b.Fields["stage"].Text != "unknown" || b.Fields["next_owner"].Text != "unknown" || b.Fields["summary"] != nil || b.Fields["progress"] != nil || b.Fields["next"] != nil {
		t.Fatalf("old accepted content leaked into new cycle: %+v", b)
	}
	if b.Fields["goal"].Text != "Stable goal" {
		t.Fatal("goal should remain available")
	}
	for _, source := range b.BySession {
		if source.Fields["stage"] != nil || source.Fields["progress"] != nil {
			t.Fatal("reopening leaked a previous cycle's per-session progress")
		}
	}
	mustIngest(t, c, report("s1", at.Add(3*time.Minute), map[string]string{"stage": "planning", "summary": "Late old cycle"}))
	if briefOf(t, c, "PH-1").Fields["stage"].Text != "unknown" {
		t.Fatal("late old phase crossed reopen boundary")
	}
	late := ev("s1", event.KindDeliver, at.Add(4*time.Minute))
	late.Text = "Late old delivery"
	mustIngest(t, c, late)
	snap, _ := c.Snapshot(ctx)
	if snap.WorkItems[0].Status != "in_progress" {
		t.Fatal("late delivery moved reopened work back to review")
	}
	now := time.Now().UTC()
	claim := ev("s1", event.KindClaim, now.Add(time.Second))
	claim.WorkTag = "PH-1"
	mustIngest(t, c, claim)
	mustIngest(t, c, report("s1", now.Add(2*time.Second), map[string]string{"stage": "implementing", "next_owner": "agent", "summary": "Fresh cycle", "progress": "Fresh result"}))
	b = briefOf(t, c, "PH-1")
	if b.Fields["stage"].Text != "implementing" || b.Fields["progress"].Text != "Fresh result" {
		t.Fatal("new cycle was pinned by old user confirmation")
	}
}

func TestExistingV1SessionGetsStructuredHintOnce(t *testing.T) {
	c, _ := claimed(t, "PH-1")
	ctx := context.Background()
	snap, _ := c.Snapshot(ctx)
	s := snap.Sessions[0]
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO reporting_hints_sent(session_id,sent_at) VALUES(?,?)`, s.ID, c.St.NowTS())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	_, show, err := c.ReportingHint(ctx, s.HostID, s.Provider, s.ProviderSessionID, false)
	if err != nil || !show {
		t.Fatal("old sessions must get the new structured-report hint")
	}
	_, show, err = c.ReportingHint(ctx, s.HostID, s.Provider, s.ProviderSessionID, false)
	if err != nil || show {
		t.Fatal("must not repeat on every prompt")
	}
}
