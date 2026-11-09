package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

func TestProjectActivityTiersFollowWorkAndRecency(t *testing.T) {
	c := newCore(t, cwdLocator{})
	ctx := context.Background()
	start := time.Now().UTC()
	clock := start
	c.St.Now = func() time.Time { return clock }
	touch := func(sid, cwd string) {
		t.Helper()
		e := ev(sid, event.KindSessionStart, clock)
		e.Cwd = cwd
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	tiers := func() map[string]string {
		t.Helper()
		snap, err := c.Snapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]string{}
		for _, r := range snap.Repos {
			out[r.Name] = r.Activity
		}
		projects, err := c.Projects(ctx)
		if err != nil {
			t.Fatal(err)
		}
		for _, p := range projects {
			if out[p.Name] != p.Activity {
				t.Fatalf("project list and snapshot disagree for %s: %s vs %s", p.Name, p.Activity, out[p.Name])
			}
		}
		return out
	}
	touch("idle", "/synthetic-idle")
	touch("busy", "/synthetic-busy")
	var busy int64
	if err := c.St.R().QueryRow(`SELECT repo_id FROM sessions WHERE provider_session_id='busy'`).Scan(&busy); err != nil {
		t.Fatal(err)
	}
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "SYN-1", RepoID: busy, Title: "synthetic open work"}); err != nil {
		t.Fatal(err)
	}
	if got := tiers(); got["/synthetic-idle"] != ActivityActive || got["/synthetic-busy"] != ActivityActive {
		t.Fatalf("recent projects should be active: %v", got)
	}
	clock = start.Add(10 * 24 * time.Hour)
	if got := tiers(); got["/synthetic-idle"] != ActivityQuiet || got["/synthetic-busy"] != ActivityActive {
		t.Fatalf("open work keeps a project active, idle one goes quiet: %v", got)
	}
	// Pausing reminders is the user's choice; it no longer keeps the project on the map.
	if err := c.UpdateWorkItem(ctx, "SYN-1", WorkItemPatch{Management: &WorkManagement{State: "paused"}}); err != nil {
		t.Fatal(err)
	}
	if got := tiers(); got["/synthetic-busy"] != ActivityQuiet {
		t.Fatalf("paused work should not keep the project active: %v", got)
	}
	clock = start.Add(40 * 24 * time.Hour)
	if got := tiers(); got["/synthetic-idle"] != ActivityDormant || got["/synthetic-busy"] != ActivityDormant {
		t.Fatalf("month-old projects should be dormant: %v", got)
	}
	touch("idle", "/synthetic-idle")
	if got := tiers(); got["/synthetic-idle"] != ActivityActive {
		t.Fatalf("new activity should bring a project back: %v", got)
	}
}

func TestProjectActivitySurvivesSessionMovingBetweenToolDirectories(t *testing.T) {
	c := newCore(t, mixedLocator{})
	ctx := context.Background()
	start := time.Date(2026, 10, 30, 8, 0, 0, 0, time.UTC)
	clock := start
	c.St.Now = func() time.Time { return clock }
	send := func(kind event.Kind, cwd string, elapsed time.Duration) {
		t.Helper()
		clock = start.Add(elapsed)
		e := ev("synthetic-moving", kind, clock)
		e.Source.Provider, e.Cwd = "codex", cwd
		mustIngest(t, c, e)
	}
	send(event.KindSessionStart, "/repo-a", 0)
	send(event.KindToolPre, "/repo-b", time.Second)
	send(event.KindToolPost, "/repo-a", 2*time.Second)
	send(event.KindToolPre, "/repo-b", 3*time.Second)

	check := func(wantTier string) {
		t.Helper()
		snap, err := c.Snapshot(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(snap.Repos) != 2 || len(snap.Sessions) != 1 || snap.Sessions[0].Cwd != "/repo-b" {
			t.Fatal("expected one session now in the second repository")
		}
		for _, r := range snap.Repos {
			wantAt := start.Add(2 * time.Second)
			if r.Name == "repo-b" {
				wantAt = start.Add(3 * time.Second)
			}
			if r.Activity != wantTier || r.LastActivityAt != store.TS(wantAt) {
				t.Errorf("%s: got %s at %q; want %s at %s", r.Name, r.Activity, r.LastActivityAt, wantTier, wantAt)
			}
		}
	}
	check(ActivityActive)
	clock = start.Add(8 * 24 * time.Hour)
	check(ActivityQuiet)
}
