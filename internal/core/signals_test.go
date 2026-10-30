package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

func signalSnapshot(t *testing.T, c *Core) *Snapshot {
	t.Helper()
	s, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestRecentSignalsPreferOccurrenceTimeAndSourcePriority(t *testing.T) {
	c, t0 := claimed(t, "SIG-1")
	for _, input := range []struct {
		minutes int
		channel string
	}{{5, "process"}, {5, "transcript"}, {5, "hook"}, {5, "process"}, {4, "hook"}, {6, "transcript"}, {3, "process"}} {
		e := ev("s1", event.KindUnknown, t0.Add(time.Duration(input.minutes)*time.Minute))
		e.Source.Channel = input.channel
		mustIngest(t, c, e)
	}
	snap := signalSnapshot(t, c)
	for _, signal := range []*Signal{snap.Sessions[0].Signal, snap.WorkItems[0].Signal} {
		if signal == nil || signal.Channel != "transcript" || signal.At != store.TS(t0.Add(6*time.Minute)) {
			t.Fatalf("wrong recent observation: %+v", signal)
		}
	}
	if snap.WorkItems[0].Status != "in_progress" {
		t.Fatal("signals changed work state")
	}
	var body string
	c.St.R().QueryRow(`SELECT body FROM events ORDER BY seq DESC LIMIT 1`).Scan(&body)
	if !strings.Contains(body, `"ref":"e`) {
		t.Fatal("hook's stable event reference was not retained")
	}
}

func TestSignalOrderingUsesInstantsAndNanoseconds(t *testing.T) {
	for _, test := range []struct {
		next, old string
		want      bool
	}{
		{"2026-10-30T10:00:00+08:00", "2026-10-30T02:00:00.000000001Z", false},
		{"2026-10-30T02:00:00.000000002Z", "2026-10-30T02:00:00.000000001Z", true},
		{"2026-10-30T02:00:00Z", "2026-10-30T10:00:00+08:00", false},
	} {
		if got := newerSignal(&Signal{Channel: "process", At: test.next}, &Signal{Channel: "hook", At: test.old}); got != test.want {
			t.Fatalf("%s vs %s: %v", test.next, test.old, got)
		}
	}
	if got := publicSignal(&Signal{Channel: "hook", At: "2026-10-30T10:00:00+08:00"}); got == nil || got.At != "2026-10-30T02:00:00.000000000Z" {
		t.Fatalf("not normalized: %+v", got)
	}
}

func TestSignalBindingDoesNotRefreshPreviousWork(t *testing.T) {
	c, t0 := claimed(t, "SIG-1")
	c.CreateWorkItem(context.Background(), WorkItemInput{ID: "SIG-2", Title: "second"})
	mustIngest(t, c, ev("s1", event.KindToolPost, t0.Add(time.Minute)))
	cl := ev("s1", event.KindClaim, t0.Add(2*time.Minute))
	cl.WorkTag = "SIG-2"
	mustIngest(t, c, cl)
	mustIngest(t, c, ev("s1", event.KindToolPost, t0.Add(3*time.Minute)))
	snap := signalSnapshot(t, c)
	byID := map[string]*Signal{}
	for _, w := range snap.WorkItems {
		byID[w.ID] = w.Signal
	}
	if byID["SIG-1"] == nil || byID["SIG-1"].At != store.TS(t0.Add(time.Minute)) {
		t.Fatalf("new task signal leaked into old work: %+v", byID)
	}
	if byID["SIG-2"].At != store.TS(t0.Add(3*time.Minute)) {
		t.Fatal(byID["SIG-2"])
	}
}

func TestExplicitCurrentSessionSignalDoesNotRequireRunDTO(t *testing.T) {
	c := newCore(t, nil)
	at := time.Now().UTC()
	mustIngest(t, c, ev("unbound", event.KindSessionStart, at))
	snap := signalSnapshot(t, c)
	snap.Sessions[0].WorkItemID = "SIG-1"
	snap.WorkItems = []WorkItem{{ID: "SIG-1"}}
	if err := c.St.Tx(context.Background(), func(tx *sql.Tx) error { return readSignals(tx, snap) }); err != nil {
		t.Fatal(err)
	}
	if snap.WorkItems[0].Signal == nil || snap.WorkItems[0].Signal.At != store.TS(at) {
		t.Fatal("current explicit session was ignored")
	}
}

func TestSignalSummaryHasOnlyPublicFieldsAndAcceptsOldDevices(t *testing.T) {
	c, t0 := claimed(t, "SIG-1")
	e := ev("s1", event.KindToolPost, t0.Add(time.Minute))
	e.Source.Ref = "/private/synthetic/transcript#99"
	mustIngest(t, c, e)
	snap := signalSnapshot(t, c)
	summary := trimForHub(snap)
	b, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "/private/") || strings.Contains(string(b), `"ref"`) {
		t.Fatal("local reference leaked")
	}
	var raw map[string]any
	json.Unmarshal(b, &raw)
	for _, field := range []string{"sessions", "work_items"} {
		for _, value := range raw[field].([]any) {
			signal := value.(map[string]any)["signal"].(map[string]any)
			if len(signal) != 2 || signal["channel"] != "hook" || signal["at"] == nil {
				t.Fatal(signal)
			}
		}
	}
	old := HubSummary{DeviceID: "old", DeviceName: "old", Snapshot: &Snapshot{Sessions: []Session{{ID: 1}}, WorkItems: []WorkItem{{ID: "OLD-1"}}}}
	if err := c.HubStore(context.Background(), old); err != nil {
		t.Fatal(err)
	}
	merged, err := c.HubMerged(context.Background(), "self", "self")
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range merged.Sessions {
		if s.ID >= hubIDStride && s.Signal != nil {
			t.Fatal("fabricated signal for old device")
		}
	}
}

func TestPanelSignalsAreAtomicScopedAndDoNotRefreshActivity(t *testing.T) {
	c, _ := claimed(t, "SIG-1")
	snap := signalSnapshot(t, c)
	sid := snap.Sessions[0].ID
	beforeActivity := snap.Sessions[0].LastActivityAt
	ctx := PanelSignalContext(context.Background(), "POST /api/sessions/{id}/unbind", fmt.Sprint(sid))
	if err := c.Unbind(ctx, sid, ""); err != nil {
		t.Fatal(err)
	}
	snap = signalSnapshot(t, c)
	if snap.Sessions[0].Signal.Channel != "user" || snap.Sessions[0].LastActivityAt != beforeActivity {
		t.Fatal("user action changed agent activity")
	}
	var count int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM events WHERE kind='user_action'`).Scan(&count)
	if count != 1 {
		t.Fatal(count)
	}
	if err := c.Unbind(ctx, sid, ""); err != nil {
		t.Fatal(err)
	}
	c.St.R().QueryRow(`SELECT COUNT(*) FROM events WHERE kind='user_action'`).Scan(&count)
	if count != 1 {
		t.Fatal("idempotent no-op audited")
	}
	ctx = PanelSignalContext(context.Background(), "PATCH /api/work-items/{id}", "SIG-1")
	title := "user edit"
	if err := c.UpdateWorkItem(ctx, "SIG-1", WorkItemPatch{Title: &title}); err != nil {
		t.Fatal(err)
	}
	var missing int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM events WHERE kind='user_action' AND session_id IS NULL`).Scan(&missing)
	if missing != 1 {
		t.Fatal("unowned edit borrowed a session")
	}
	if got := signalSnapshot(t, c).Sessions[0].Signal.Channel; got != "user" {
		t.Fatal(got)
	}
	// Force audit failure; both the business write and signal must roll back.
	c.St.Tx(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.Exec(`CREATE TRIGGER reject_user_signal BEFORE INSERT ON events WHEN NEW.kind='user_action' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END`)
		return err
	})
	title = "should roll back"
	if err := c.UpdateWorkItem(ctx, "SIG-1", WorkItemPatch{Title: &title}); err == nil {
		t.Fatal("audit failure not returned")
	}
	if got := signalSnapshot(t, c).WorkItems[0].Title; got != "user edit" {
		t.Fatal("business write escaped failed audit")
	}
}

func TestPanelErrorsAndReadOnlyContextsDoNotProduceSignals(t *testing.T) {
	c, _ := claimed(t, "SIG-1")
	ctx := PanelSignalContext(context.Background(), "POST /api/sessions/{id}/bind", "999")
	if err := c.BindManual(ctx, 999, "SIG-1"); err == nil {
		t.Fatal("expected unknown session failure")
	}
	ctx = PanelSignalContext(context.Background(), "GET /api/snapshot", "")
	if err := c.panelTx(ctx, func(tx *sql.Tx) error { return nil }); err != nil {
		t.Fatal(err)
	}
	var count int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM events WHERE kind='user_action'`).Scan(&count)
	if count != 0 {
		t.Fatal("failed/read-only operation audited")
	}
}

func TestUserObservationDoesNotChangeReplayOrAgentDayActivity(t *testing.T) {
	for _, kind := range []event.Kind{event.KindSessionEnd, event.KindStop} {
		t.Run(string(kind), func(t *testing.T) {
			c, t0 := claimed(t, "SIG-1")
			ended := t0.Add(time.Minute)
			mustIngest(t, c, ev("s1", kind, ended))
			userAt := ended.Add(25 * time.Hour)
			c.St.Now = func() time.Time { return userAt }
			before := signalSnapshot(t, c)
			sid := before.Sessions[0].ID
			// A session-bound observation request can still be dismissed after the Agent ended.
			if err := c.St.Tx(context.Background(), func(tx *sql.Tx) error {
				_, err := tx.Exec(`INSERT INTO approvals(id,kind,status,session_id,created_at) VALUES('USER-AP','attention','pending',?,?)`, sid, store.TS(userAt))
				return err
			}); err != nil {
				t.Fatal(err)
			}
			ctx := PanelSignalContext(context.Background(), "POST /api/approvals/{id}/dismiss", "USER-AP")
			if err := c.Dismiss(ctx, "USER-AP", "dismissed"); err != nil {
				t.Fatal(err)
			}
			replay, err := c.SnapshotAt(context.Background(), userAt)
			if err != nil {
				t.Fatal(err)
			}
			want := "ended"
			if kind == event.KindStop {
				want = "idle"
			}
			if len(replay.Sessions) != 1 || replay.Sessions[0].State != want || replay.Sessions[0].LastActivityAt != store.TS(ended) {
				t.Fatalf("user operation changed replay: %+v", replay.Sessions)
			}
			day := userAt.In(time.Local).Format("2006-01-02")
			detail, err := c.HistoryDay(context.Background(), day, false)
			if err != nil {
				t.Fatal(err)
			}
			if len(detail.Sessions) != 0 {
				t.Fatal("user-only day became Agent activity")
			}
			oldDay := ended.In(time.Local).Format("2006-01-02")
			detail, err = c.HistoryDay(context.Background(), oldDay, false)
			if err != nil {
				t.Fatal(err)
			}
			if len(detail.Sessions) != 1 || detail.Sessions[0].Last != store.TS(ended) {
				t.Fatalf("agent activity duration changed: %+v", detail.Sessions)
			}
			history, err := c.History(context.Background(), 3, false)
			if err != nil {
				t.Fatal(err)
			}
			for _, stat := range history.Days {
				if stat.Day == day && stat.Sessions != 0 {
					t.Fatal("history calendar counted a user-only session")
				}
			}
		})
	}
}

func TestReservedChannelsCannotEnterTheIngestStateMachine(t *testing.T) {
	c, t0 := claimed(t, "SIG-1")
	before := signalSnapshot(t, c)
	var eventsBefore, eventsAfter int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM events`).Scan(&eventsBefore)
	for _, channel := range []string{"user", "git", "github", "hub", "model", "unknown", "HOOK", " hook"} {
		for _, sid := range []string{"s1", "untrusted-new-session"} {
			e := ev(sid, event.KindDeliver, t0.Add(time.Hour))
			e.Source.Channel = channel
			e.WorkTag = "SIG-1"
			if _, err := c.Ingest(context.Background(), e); !errors.Is(err, ErrBadRequest) || !strings.Contains(err.Error(), "仅允许") {
				t.Fatalf("reserved channel %q accepted or unclear error: %v", channel, err)
			}
		}
	}
	after := signalSnapshot(t, c)
	c.St.R().QueryRow(`SELECT COUNT(*) FROM events`).Scan(&eventsAfter)
	if eventsBefore != eventsAfter || len(before.Sessions) != len(after.Sessions) || before.Cursor != after.Cursor || before.WorkItems[0].Status != after.WorkItems[0].Status || *before.Sessions[0].Signal != *after.Sessions[0].Signal {
		t.Fatal("reserved channel modified facts, state or last signal")
	}
}
