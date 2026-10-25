package core

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

func routineNotifierFixture(t *testing.T) (*Core, *Notifier, *time.Time) {
	t.Helper()
	c := newCore(t, nil)
	c.AutomaticMemoryProjects = []string{"/repo/.git"}
	now := time.Date(2026, 10, 24, 0, 0, 0, 0, time.UTC)
	c.St.Now = func() time.Time { return now }
	ctx := context.Background()
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "MEM-1", Title: "整合代理记忆", RepoPath: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	claim := ev("routine-boundary", event.KindClaim, now)
	claim.WorkTag = "MEM-1"
	mustIngest(t, c, claim)
	return c, &Notifier{C: c, since: c.St.NowTS(), BaseURL: "http://127.0.0.1:1"}, &now
}

func assertNoPending(t *testing.T, n *Notifier) {
	t.Helper()
	alerts, err := n.Pending(context.Background())
	if err != nil || len(alerts) != 0 {
		t.Fatalf("same incident notified again: %+v %v", alerts, err)
	}
}

func TestRoutineBlockedNotificationIgnoresMetadata(t *testing.T) {
	for _, change := range []string{"touch", "agent-report", "brief-edit", "item-edit", "same-status"} {
		t.Run(change, func(t *testing.T) {
			c, n, now := routineNotifierFixture(t)
			ctx := context.Background()
			*now = now.Add(time.Minute)
			blocked := "blocked"
			if err := c.UpdateWorkItem(ctx, "MEM-1", WorkItemPatch{Status: &blocked}); err != nil {
				t.Fatal(err)
			}
			alerts, err := n.Pending(ctx)
			if err != nil || len(alerts) != 1 {
				t.Fatal(alerts, err)
			}
			if err := n.Check(ctx); err != nil {
				t.Fatal(err)
			}
			*now = now.Add(time.Minute)
			switch change {
			case "touch":
				err = c.St.Tx(ctx, func(tx *sql.Tx) error { return store.Touch(tx, c.St.NowTS(), "work_item", "MEM-1") })
			case "agent-report":
				_, err = c.Ingest(ctx, report("routine-boundary", *now, map[string]string{"progress": "Synthetic follow-up"}))
			case "brief-edit":
				_, err = c.EditBrief(ctx, "MEM-1", BriefEdit{Field: "goal", Action: "set", Text: "Synthetic clarified goal"})
			case "item-edit":
				acceptance := "Synthetic acceptance wording"
				err = c.UpdateWorkItem(ctx, "MEM-1", WorkItemPatch{Acceptance: &acceptance})
			case "same-status":
				err = c.UpdateWorkItem(ctx, "MEM-1", WorkItemPatch{Status: &blocked})
			}
			if err != nil {
				t.Fatal(err)
			}
			assertNoPending(t, n)
			// A new blocked episode must still notify, even without a Check between transitions.
			*now = now.Add(time.Minute)
			running := "in_progress"
			if err = c.UpdateWorkItem(ctx, "MEM-1", WorkItemPatch{Status: &running}); err != nil {
				t.Fatal(err)
			}
			*now = now.Add(time.Minute)
			if err = c.UpdateWorkItem(ctx, "MEM-1", WorkItemPatch{Status: &blocked}); err != nil {
				t.Fatal(err)
			}
			alerts, err = n.Pending(ctx)
			if err != nil || len(alerts) != 1 {
				t.Fatalf("new blocked episode lost: %+v %v", alerts, err)
			}
		})
	}
}

func TestRoutineDependencyNotificationIgnoresBriefEdit(t *testing.T) {
	c, n, now := routineNotifierFixture(t)
	ctx := context.Background()
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "UP-1", Title: "Synthetic upstream"}); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Minute)
	if err := c.AddDep(ctx, "UP-1", "MEM-1", "accepted"); err != nil {
		t.Fatal(err)
	}
	alerts, err := n.Pending(ctx)
	if err != nil || len(alerts) != 1 {
		t.Fatalf("new unmet dependency needs one alert: %+v %v", alerts, err)
	}
	if err = n.Check(ctx); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Minute)
	if _, err = c.EditBrief(ctx, "MEM-1", BriefEdit{Field: "goal", Action: "set", Text: "Synthetic clarified goal"}); err != nil {
		t.Fatal(err)
	}
	assertNoPending(t, n)
	*now = now.Add(time.Minute)
	if err = c.AddDep(ctx, "UP-1", "MEM-1", "accepted"); err != nil {
		t.Fatal(err)
	}
	assertNoPending(t, n) // reapplying the same edge is not a new dependency incident
	*now = now.Add(time.Minute)
	done := "done"
	if err = c.UpdateWorkItem(ctx, "UP-1", WorkItemPatch{Status: &done}); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Minute)
	running := "in_progress"
	if err = c.UpdateWorkItem(ctx, "UP-1", WorkItemPatch{Status: &running}); err != nil {
		t.Fatal(err)
	}
	alerts, err = n.Pending(ctx)
	if err != nil || len(alerts) != 1 {
		t.Fatalf("new upstream blocking episode lost: %+v %v", alerts, err)
	}
}

func TestEmptyRoutineAskCreatesFormalDecisionNotification(t *testing.T) {
	c, n, now := routineNotifierFixture(t)
	*now = now.Add(time.Minute)
	ask := ev("routine-boundary", event.KindAsk, *now)
	if err := ask.Validate(); err != nil {
		t.Fatal("low-level event validation changed", err)
	}
	mustIngest(t, c, ask)
	alerts, err := n.Pending(context.Background())
	if err != nil || len(alerts) != 1 || alerts[0].Title != "需要你：做决定" {
		t.Fatalf("empty low-level ask must retain its formal decision: %+v %v", alerts, err)
	}
	if err = n.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertNoPending(t, n)
}

func TestRoutineMergedDependencyNotificationUsesMergeChange(t *testing.T) {
	c, n, now := routineNotifierFixture(t)
	ctx := context.Background()
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "UP-1", Title: "Synthetic merge upstream"}); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Minute)
	if err := c.AddDep(ctx, "UP-1", "MEM-1", "merged"); err != nil {
		t.Fatal(err)
	}
	alerts, err := n.Pending(ctx)
	if err != nil || len(alerts) != 1 {
		t.Fatal(alerts, err)
	}
	if err = n.Check(ctx); err != nil {
		t.Fatal(err)
	}
	*now = now.Add(time.Minute)
	if _, err = c.EditBrief(ctx, "UP-1", BriefEdit{Field: "goal", Action: "set", Text: "Synthetic metadata only"}); err != nil {
		t.Fatal(err)
	}
	assertNoPending(t, n)
	for _, state := range []string{"merged", "not_ready"} {
		*now = now.Add(time.Minute)
		if err = c.St.Tx(ctx, func(tx *sql.Tx) error {
			_, err := tx.Exec(`UPDATE work_items SET merge_state=?,updated_at=? WHERE id='UP-1'`, state, c.St.NowTS())
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	alerts, err = n.Pending(ctx)
	if err != nil || len(alerts) != 1 {
		t.Fatalf("merge dependency became blocked again without alert: %+v %v", alerts, err)
	}
}

func TestRoutineDependencyEpisodeNotifications(t *testing.T) {
	for _, tc := range []struct {
		name, cond string
		unmet      [][2]string
		recovered  [2]string
		reblocked  [2]string
	}{
		{"accepted-progress", "accepted", [][2]string{{"todo", "none"}, {"in_progress", "none"}, {"review", "none"}}, [2]string{"done", "none"}, [2]string{"in_progress", "none"}},
		{"merge-progress", "merged", [][2]string{{"review", "not_ready"}, {"review", "awaiting"}, {"review", "approved"}}, [2]string{"review", "merged"}, [2]string{"review", "not_ready"}},
		{"merge-without-merge", "merged", [][2]string{{"todo", "none"}}, [2]string{"done", "none"}, [2]string{"in_progress", "none"}},
		{"merged-then-abandoned", "merged", [][2]string{{"review", "not_ready"}}, [2]string{"review", "merged"}, [2]string{"abandoned", "merged"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, n, now := routineNotifierFixture(t)
			ctx := context.Background()
			if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "UP-1", Title: "Synthetic upstream"}); err != nil {
				t.Fatal(err)
			}
			setState := func(state [2]string) {
				t.Helper()
				*now = now.Add(time.Minute)
				// Exercise the same atomic status/merge writes used by acceptance and merge handling.
				if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
					_, err := tx.Exec(`UPDATE work_items SET status=?,merge_state=?,updated_at=? WHERE id='UP-1'`, state[0], state[1], c.St.NowTS())
					return err
				}); err != nil {
					t.Fatal(err)
				}
			}
			setState(tc.unmet[0])
			*now = now.Add(time.Minute)
			if err := c.AddDep(ctx, "UP-1", "MEM-1", tc.cond); err != nil {
				t.Fatal(err)
			}
			alerts, err := n.Pending(ctx)
			if err != nil || len(alerts) != 1 {
				t.Fatalf("first unmet episode: %+v %v", alerts, err)
			}
			if err = n.Check(ctx); err != nil {
				t.Fatal(err)
			}
			for _, state := range tc.unmet[1:] {
				setState(state)
				assertNoPending(t, n)
				if err = n.Check(ctx); err != nil {
					t.Fatal(err)
				}
			}
			for round := 0; round < 2; round++ {
				// Do not poll in between: actual recovery must still start a new episode.
				// The second round also covers merged -> abandoned with no merge clock change.
				setState(tc.recovered)
				setState(tc.reblocked)
				alerts, err = n.Pending(ctx)
				if err != nil || len(alerts) != 1 {
					t.Fatalf("recovered then unmet round %d needs one new alert: %+v %v", round, alerts, err)
				}
				if err = n.Check(ctx); err != nil {
					t.Fatal(err)
				}
				assertNoPending(t, n)
			}
		})
	}
}

func TestRoutineDependencyIncidentUpgradeAndRestart(t *testing.T) {
	for _, cond := range []string{"accepted", "merged"} {
		t.Run(cond, func(t *testing.T) {
			c, n, now := routineNotifierFixture(t)
			ctx := context.Background()
			needsMerge := false
			if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "UP-1", Title: "Synthetic legacy upstream", NeedsMerge: &needsMerge}); err != nil {
				t.Fatal(err)
			}
			*now = now.Add(time.Minute)
			if err := c.AddDep(ctx, "UP-1", "MEM-1", cond); err != nil {
				t.Fatal(err)
			}
			alerts, err := n.Pending(ctx)
			if err != nil || len(alerts) != 1 {
				t.Fatal(alerts, err)
			}
			oldKey := alerts[0].Key // same timestamp key written by the pre-upgrade notifier
			if err = n.Check(ctx); err != nil {
				t.Fatal(err)
			}
			var path string
			if err = c.St.R().QueryRow(`SELECT file FROM pragma_database_list WHERE name='main'`).Scan(&path); err != nil {
				t.Fatal(err)
			}
			// Retain the actual old clocks and notify_sent, but remove the new schema.
			// A pre-upgrade database carries no schema version, so the full v1 schema runs again on open.
			if err = c.St.Tx(ctx, func(tx *sql.Tx) error {
				_, err := tx.Exec(`DROP TRIGGER work_item_state_change; DROP TABLE work_item_state_changes; PRAGMA user_version = 0`)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			reopen := func() {
				t.Helper()
				if err := c.St.Close(); err != nil {
					t.Fatal(err)
				}
				st, err := store.Open(path)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { st.Close() })
				st.Now = func() time.Time { return *now }
				c.St = st
				*now = now.Add(time.Minute)
				n = &Notifier{C: c, since: c.St.NowTS(), BaseURL: "http://127.0.0.1:1"}
			}
			reopen()
			assertNoPending(t, n)
			setStatus := func(status string) {
				t.Helper()
				*now = now.Add(time.Minute)
				if err := c.UpdateWorkItem(ctx, "UP-1", WorkItemPatch{Status: &status}); err != nil {
					t.Fatal(err)
				}
			}
			setStatus("in_progress") // old unresolved dependency still must not re-alert
			assertNoPending(t, n)
			setStatus("done")
			setStatus("in_progress") // genuine new failure after migration
			alerts, err = n.Pending(ctx)
			if err != nil || len(alerts) != 1 || alerts[0].Key == oldKey {
				t.Fatalf("first new incident after upgrade lost: %+v %v", alerts, err)
			}
			if err = n.Check(ctx); err != nil {
				t.Fatal(err)
			}
			reopen()
			assertNoPending(t, n)
			setStatus("review")
			assertNoPending(t, n) // restart must preserve the same incident clock
			setStatus("done")
			setStatus("in_progress")
			alerts, err = n.Pending(ctx)
			if err != nil || len(alerts) != 1 {
				t.Fatalf("new incident after restart lost: %+v %v", alerts, err)
			}
		})
	}
}
