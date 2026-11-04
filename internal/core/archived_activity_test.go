package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestArchivedProjectWithNewActivityIsSurfacedUntilKept(t *testing.T) {
	c := newCore(t, cwdLocator{})
	ctx := context.Background()
	clock := time.Now().UTC()
	c.St.Now = func() time.Time { return clock }
	touch := func(sid string) {
		t.Helper()
		e := ev(sid, event.KindPrompt, clock)
		e.Cwd = "/synthetic-archived"
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	surfaced := func() int {
		t.Helper()
		snap, err := c.Snapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return len(snap.ArchivedActivity)
	}
	touch("before")
	var repo int64
	if err := c.St.R().QueryRow(`SELECT repo_id FROM sessions WHERE provider_session_id='before'`).Scan(&repo); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(time.Minute)
	if err := c.ArchiveProjects(ctx, []int64{repo}, true); err != nil {
		t.Fatal(err)
	}
	if n := surfaced(); n != 0 {
		t.Fatal("activity from before archiving should not be surfaced", n)
	}
	clock = clock.Add(time.Hour)
	touch("after")
	if n := surfaced(); n != 1 {
		t.Fatal("new activity in an archived project not surfaced", n)
	}
	clock = clock.Add(time.Minute)
	if err := c.KeepArchived(ctx, []int64{repo}); err != nil {
		t.Fatal(err)
	}
	if n := surfaced(); n != 0 {
		t.Fatal("kept-archived project still surfaced", n)
	}
	clock = clock.Add(time.Hour)
	touch("later")
	if n := surfaced(); n != 1 {
		t.Fatal("later activity after keeping archived not surfaced", n)
	}
	if err := c.TrashProjects(ctx, []int64{repo}, true); err != nil {
		t.Fatal(err)
	}
	if n := surfaced(); n != 0 {
		t.Fatal("trashed projects must not be surfaced", n)
	}
}
