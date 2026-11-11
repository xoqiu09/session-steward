package core

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

func testUnbindTarget(t *testing.T, c *Core, sid int64) UnbindTarget {
	t.Helper()
	var target UnbindTarget
	if err := c.St.R().QueryRow(`SELECT id,work_item_id FROM runs WHERE session_id=? AND ended_at=''`, sid).Scan(&target.RunID, &target.WorkItemID); err != nil {
		t.Fatal(err)
	}
	return target
}

func TestUnbindRequiresExactObservedRun(t *testing.T) {
	ctx := context.Background()
	for _, test := range []struct {
		name   string
		change func(UnbindTarget) UnbindTarget
	}{
		{"missing identity", func(UnbindTarget) UnbindTarget { return UnbindTarget{} }},
		{"missing run", func(v UnbindTarget) UnbindTarget { v.RunID = 0; return v }},
		{"missing item", func(v UnbindTarget) UnbindTarget { v.WorkItemID = ""; return v }},
		{"wrong run", func(v UnbindTarget) UnbindTarget { v.RunID++; return v }},
		{"wrong item", func(v UnbindTarget) UnbindTarget { v.WorkItemID = "OTHER-1"; return v }},
	} {
		t.Run(test.name, func(t *testing.T) {
			c, _ := claimed(t, "SYN-1")
			sid := signalSnapshot(t, c).Sessions[0].ID
			target := testUnbindTarget(t, c, sid)
			if err := c.Unbind(ctx, sid, "delivered", test.change(target)); !errors.Is(err, ErrConflict) {
				t.Fatalf("expected identity conflict, got %v", err)
			}
			if got := testUnbindTarget(t, c, sid); got != target {
				t.Fatalf("identity mismatch changed current run: %+v", got)
			}
		})
	}
}

func TestUnbindCannotUseAnotherSessionTarget(t *testing.T) {
	c, _ := claimed(t, "SYN-1")
	sid := signalSnapshot(t, c).Sessions[0].ID
	target := testUnbindTarget(t, c, sid)
	if err := c.Unbind(context.Background(), sid+1, "delivered", target); !errors.Is(err, ErrConflict) {
		t.Fatalf("another session must not accept this run identity: %v", err)
	}
	if got := testUnbindTarget(t, c, sid); got != target {
		t.Fatal("another session request changed the original run")
	}
}

func TestUnbindDoesNotEndNewAttemptOfSameItem(t *testing.T) {
	c, _ := claimed(t, "SYN-1")
	ctx := context.Background()
	sid := signalSnapshot(t, c).Sessions[0].ID
	old := testUnbindTarget(t, c, sid)
	if err := c.Unbind(ctx, sid, "failed", old); err != nil {
		t.Fatal(err)
	}
	// An acknowledged duplicate is a no-op and leaves the original outcome intact.
	before, _ := c.St.LatestSeq(ctx)
	if err := c.Unbind(ctx, sid, "failed", old); err != nil {
		t.Fatal(err)
	}
	if after, _ := c.St.LatestSeq(ctx); after != before {
		t.Fatal("idempotent unbind produced a change")
	}
	if err := c.BindManual(ctx, sid, "SYN-1"); err != nil {
		t.Fatal(err)
	}
	current := testUnbindTarget(t, c, sid)
	if current.RunID == old.RunID {
		t.Fatal("synthetic fixture did not start a new run")
	}
	if err := c.Unbind(ctx, sid, "delivered", old); !errors.Is(err, ErrConflict) {
		t.Fatalf("old attempt must not end new attempt: %v", err)
	}
	if got := testUnbindTarget(t, c, sid); got != current {
		t.Fatal("new attempt was changed")
	}
	if err := c.Unbind(ctx, sid, "abandoned", current); err != nil {
		t.Fatal(err)
	}
	if err := c.Unbind(ctx, sid, "delivered", old); !errors.Is(err, ErrConflict) {
		t.Fatalf("an old run is not an idempotent target after a newer run ended: %v", err)
	}
}

func TestUnbindRejectsAmbiguousCurrentRuns(t *testing.T) {
	c, _ := claimed(t, "SYN-1")
	ctx := context.Background()
	sid := signalSnapshot(t, c).Sessions[0].ID
	target := testUnbindTarget(t, c, sid)
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO runs(work_item_id,session_id,attempt,binding,started_at) VALUES(?,?,2,'manual',?)`, target.WorkItemID, sid, c.St.NowTS())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.Unbind(ctx, sid, "delivered", target); !errors.Is(err, ErrConflict) {
		t.Fatalf("ambiguous current runs must be rejected: %v", err)
	}
	var count int
	if err := c.St.R().QueryRow(`SELECT COUNT(*) FROM runs WHERE session_id=? AND ended_at=''`, sid).Scan(&count); err != nil || count != 2 {
		t.Fatalf("ambiguous runs changed: count=%d error=%v", count, err)
	}
}
