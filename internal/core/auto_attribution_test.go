package core

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/scan"
)

func TestAutomaticAttributionRules(t *testing.T) {
	now := time.Now()
	base := autoSession{id: 1, repo: 1, title: "修复行情断线恢复", state: "running", dataSource: "live", lastActivity: now.UTC().Format(time.RFC3339Nano)}
	st := autoState{repos: map[int64]autoRepo{1: {id: 1, name: "market", git: true}, 2: {id: 2, name: "other", git: true}}, items: []autoItem{{id: "QM-014", repo: 1, title: base.title, branch: "feat/QM-014-reconnect", status: "in_progress"}}}
	cases := []struct {
		name         string
		s            autoSession
		items        []autoItem
		automatic    bool
		action, item string
	}{
		{"exact title in repo", base, st.items, true, "link", "QM-014"},
		{"explicit number", func() autoSession { s := base; s.title = "继续 #QM-014"; return s }(), st.items, true, "link", "QM-014"},
		{"exact branch", func() autoSession {
			s := base
			s.title = "另一个描述"
			s.branch = "feat/QM-014-reconnect"
			return s
		}(), st.items, true, "link", "QM-014"},
		{"numeric branch", func() autoSession { s := base; s.title = ""; s.branch = "fix/14-reconnect"; return s }(), []autoItem{{id: "QM-014", repo: 1, title: base.title, status: "todo"}}, true, "link", "QM-014"},
		{"cross project conflict", func() autoSession { s := base; s.repo = 2; s.title = "修复 #QM-014 行情"; return s }(), st.items, false, "link", "QM-014"},
		{"same title other repo", func() autoSession { s := base; s.repo = 2; return s }(), st.items, false, "link", "QM-014"},
		{"fuzzy only", func() autoSession { s := base; s.title = "修复行情断线重连"; return s }(), st.items, false, "link", "QM-014"},
		{"history never automatic", func() autoSession { s := base; s.dataSource = "history"; return s }(), st.items, false, "link", "QM-014"},
		{"ended never automatic", func() autoSession { s := base; s.state = "ended"; return s }(), st.items, false, "link", "QM-014"},
		{"old never automatic", func() autoSession {
			s := base
			s.lastActivity = now.Add(-25 * time.Hour).Format(time.RFC3339Nano)
			return s
		}(), st.items, false, "link", "QM-014"},
		{"duplicate exact titles", base, append(append([]autoItem{}, st.items...), autoItem{id: "QM-015", repo: 1, title: base.title, status: "todo"}), false, "link", "QM-014"},
		{"closed target", base, []autoItem{{id: "QM-014", repo: 1, title: base.title, status: "done"}}, false, "create", ""},
		{"new clear work", base, nil, true, "create", ""},
		{"generic title", func() autoSession { s := base; s.title = "每小时聚合"; return s }(), nil, false, "create", ""},
		{"generic title exact stays uncertain", func() autoSession { s := base; s.title = "Session Steward"; return s }(), []autoItem{{id: "SS-001", repo: 1, title: "Session Steward", status: "todo"}}, false, "link", "SS-001"},
		{"unknown project", func() autoSession { s := base; s.repo = 99; return s }(), nil, false, "create", ""},
		{"title vs branch conflict", func() autoSession {
			s := base
			s.title = "修复 #QM-015 问题"
			s.branch = "feat/QM-014-reconnect"
			return s
		}(), append(append([]autoItem{}, st.items...), autoItem{id: "QM-015", repo: 1, title: "另一项", status: "todo"}), false, "link", "QM-014"},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			state := st
			state.items = tt.items
			p := planAttribution(tt.s, state, now)
			if p == nil || p.Automatic != tt.automatic || p.Action != tt.action || p.WorkItemID != tt.item {
				t.Fatalf("%+v", p)
			}
		})
	}
}
func seedAutoSession(t *testing.T, c *Core, id, title string, historical bool) int64 {
	t.Helper()
	ctx := context.Background()
	at := time.Now()
	e := ev(id, event.KindPrompt, at)
	if historical {
		_, err := c.ImportHistory(ctx, "h", []scan.Found{{Provider: "claude", SessionID: id, Cwd: "/repo", FirstAt: at, LastAt: at}})
		if err != nil {
			t.Fatal(err)
		}
	} else {
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.RefreshTitles(ctx, "h", []scan.Title{{Provider: "claude", SessionID: id, Text: title, Source: "test_index", UpdatedAt: at}}); err != nil {
		t.Fatal(err)
	}
	var sid int64
	if err := c.St.R().QueryRow(`SELECT id FROM sessions WHERE provider_session_id=?`, id).Scan(&sid); err != nil {
		t.Fatal(err)
	}
	return sid
}
func TestAutoCreationDeduplicatesAndDoesNotOverrideManual(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	a := seedAutoSession(t, c, "auto-a", "修复行情断线恢复", false)
	b := seedAutoSession(t, c, "auto-b", "修复行情断线恢复", false)
	manual := seedAutoSession(t, c, "manual", "修复行情断线恢复", false)
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "PIN-001", Title: "手动固定任务", SessionID: &manual}); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := c.ReconcileAttributions(ctx); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	snap, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var first, second, pinned string
	for _, s := range snap.Sessions {
		switch s.ID {
		case a:
			first = s.WorkItemID
		case b:
			second = s.WorkItemID
		case manual:
			pinned = s.WorkItemID
		}
	}
	if first == "" || first != second || pinned != "PIN-001" || len(snap.WorkItems) != 2 {
		t.Fatalf("first=%s second=%s pinned=%s items=%d", first, second, pinned, len(snap.WorkItems))
	}
	cursor := snap.Cursor
	if n, err := c.ReconcileAttributions(ctx); err != nil || n != 0 {
		t.Fatalf("%d %v", n, err)
	}
	stable, _ := c.Snapshot(ctx)
	if stable.Cursor != cursor {
		t.Fatal("not idempotent")
	}
}
func TestAttributionBatchAtomicStaleAndUndo(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	seedAutoSession(t, c, "one", "项目整理", false)
	seedAutoSession(t, c, "two", "内容整理", false)
	if _, err := c.ReconcileAttributions(ctx); err != nil {
		t.Fatal(err)
	}
	snap, _ := c.Snapshot(ctx)
	if len(snap.Attributions) != 2 {
		t.Fatalf("%+v", snap.Attributions)
	}
	a, b := snap.Attributions[0], snap.Attributions[1]
	decisions := []AttributionDecision{{ID: a.ID, Fingerprint: a.Fingerprint, Action: "create", RepoID: 1, Title: "明确的第一项工作"}, {ID: b.ID, Fingerprint: "stale", Action: "create", RepoID: 1, Title: "明确的第二项工作"}}
	if err := c.DecideAttributions(ctx, decisions); !errors.Is(err, ErrConflict) {
		t.Fatalf("%v", err)
	}
	failed, _ := c.Snapshot(ctx)
	if len(failed.WorkItems) != 0 || failed.Attributions[0].Status != "pending" {
		t.Fatal("batch did not roll back")
	}
	decisions[1].Fingerprint = b.Fingerprint
	if err := c.DecideAttributions(ctx, decisions); err != nil {
		t.Fatal(err)
	}
	applied, _ := c.Snapshot(ctx)
	if len(applied.WorkItems) != 2 {
		t.Fatal("not applied")
	}
	record := applied.Attributions[0]
	if err := c.DecideAttributions(ctx, []AttributionDecision{{ID: record.ID, Fingerprint: record.Fingerprint, Action: "undo"}}); err != nil {
		t.Fatal(err)
	}
	if n, err := c.ReconcileAttributions(ctx); err != nil || n != 0 {
		t.Fatalf("undo repeated %d %v", n, err)
	}
	undone, _ := c.Snapshot(ctx)
	for _, s := range undone.Sessions {
		if s.ID == record.SessionID && s.WorkItemID != "" {
			t.Fatal("undo still bound")
		}
	}
}
func TestDismissAndManualBindStayAuthoritative(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	sid := seedAutoSession(t, c, "dismiss", "一个笼统标题", false)
	c.ReconcileAttributions(ctx)
	snap, _ := c.Snapshot(ctx)
	a := snap.Attributions[0]
	if err := c.DecideAttributions(ctx, []AttributionDecision{{ID: a.ID, Fingerprint: a.Fingerprint, Action: "dismiss"}}); err != nil {
		t.Fatal(err)
	}
	if n, err := c.ReconcileAttributions(ctx); err != nil || n != 0 {
		t.Fatalf("%d %v", n, err)
	}
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "PIN-001", Title: "明确任务", SessionID: &sid}); err != nil {
		t.Fatal(err)
	}
	if err := c.DecideAttributions(ctx, []AttributionDecision{{ID: a.ID, Fingerprint: a.Fingerprint, Action: "create", RepoID: 1, Title: "不得覆盖"}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("%v", err)
	}
}
func TestMetadataChangeInvalidatesPendingDecision(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	seedAutoSession(t, c, "stale", "原来的标题", false)
	c.ReconcileAttributions(ctx)
	snap, _ := c.Snapshot(ctx)
	a := snap.Attributions[0]
	c.RefreshTitles(ctx, "h", []scan.Title{{Provider: "claude", SessionID: "stale", Text: "新的标题", Source: "test_index", UpdatedAt: time.Now().Add(time.Second)}})
	if err := c.DecideAttributions(ctx, []AttributionDecision{{ID: a.ID, Fingerprint: a.Fingerprint, Action: "create", RepoID: 1}}); !errors.Is(err, ErrConflict) {
		t.Fatalf("%v", err)
	}
}
func TestHistoricalConfirmationDoesNotClaimActiveExecution(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "SEED-001", Title: "独立参照项", RepoPath: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	seedAutoSession(t, c, "old", "修复行情断线恢复", true)
	c.ReconcileAttributions(ctx)
	snap, _ := c.Snapshot(ctx)
	a := snap.Attributions[0]
	if a.Status != "pending" || !a.Plan.Historical {
		t.Fatalf("%+v", a)
	}
	if err := c.DecideAttributions(ctx, []AttributionDecision{{ID: a.ID, Fingerprint: a.Fingerprint, Action: "create", RepoID: 1}}); err != nil {
		t.Fatal(err)
	}
	after, _ := c.Snapshot(ctx)
	if after.Sessions[0].State != "unknown" || after.Sessions[0].WorkItemID != "" || len(after.Runs) != 1 || after.Runs[0].EndedAt == "" || after.Runs[0].Outcome != "historical" {
		t.Fatalf("%+v", after)
	}
	applied := after.Attributions[0]
	if err := c.DecideAttributions(ctx, []AttributionDecision{{ID: applied.ID, Fingerprint: applied.Fingerprint, Action: "undo"}}); err != nil {
		t.Fatal(err)
	}
}

func TestManualNewTaskDoesNotReuseAnExistingSameTitle(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	seedAutoSession(t, c, "separate", "Session Steward", false)
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "OLD-001", Title: "Session Steward", RepoID: 1}); err != nil {
		t.Fatal(err)
	}
	c.ReconcileAttributions(ctx)
	snap, _ := c.Snapshot(ctx)
	a := snap.Attributions[0]
	if err := c.DecideAttributions(ctx, []AttributionDecision{{ID: a.ID, Fingerprint: a.Fingerprint, Action: "create", RepoID: 1}}); err != nil {
		t.Fatal(err)
	}
	after, _ := c.Snapshot(ctx)
	if len(after.WorkItems) != 2 || after.Sessions[0].WorkItemID == "OLD-001" {
		t.Fatal("explicit creation silently reused existing work")
	}
}

func TestDismissDoesNotReappearWhenSessionEnds(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	seedAutoSession(t, c, "dismiss-end", "一个笼统标题", false)
	c.ReconcileAttributions(ctx)
	snap, _ := c.Snapshot(ctx)
	a := snap.Attributions[0]
	if err := c.DecideAttributions(ctx, []AttributionDecision{{ID: a.ID, Fingerprint: a.Fingerprint, Action: "dismiss"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Ingest(ctx, ev("dismiss-end", event.KindSessionEnd, time.Now())); err != nil {
		t.Fatal(err)
	}
	if n, err := c.ReconcileAttributions(ctx); err != nil || n != 0 {
		t.Fatalf("%d %v", n, err)
	}
}

func TestSessionEndingBeforeConfirmationBecomesHistorical(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	seedAutoSession(t, c, "ends-before-confirm", "一个笼统标题", false)
	c.ReconcileAttributions(ctx)
	snap, _ := c.Snapshot(ctx)
	a := snap.Attributions[0]
	if _, err := c.Ingest(ctx, ev("ends-before-confirm", event.KindSessionEnd, time.Now())); err != nil {
		t.Fatal(err)
	}
	if err := c.DecideAttributions(ctx, []AttributionDecision{{ID: a.ID, Fingerprint: a.Fingerprint, Action: "create", RepoID: 1}}); err != nil {
		t.Fatal(err)
	}
	after, _ := c.Snapshot(ctx)
	if after.Sessions[0].WorkItemID != "" || after.Runs[0].Outcome != "historical" || !after.Attributions[0].Plan.Historical {
		t.Fatalf("%+v", after)
	}
}

func TestUndoAllAutomaticRunnersArchivesOnlyGeneratedTask(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	seedAutoSession(t, c, "shared-a", "新增审批任务显示", false)
	seedAutoSession(t, c, "shared-b", "新增审批任务显示", false)
	c.ReconcileAttributions(ctx)
	snap, _ := c.Snapshot(ctx)
	for _, a := range snap.Attributions {
		if err := c.DecideAttributions(ctx, []AttributionDecision{{ID: a.ID, Fingerprint: a.Fingerprint, Action: "undo"}}); err != nil {
			t.Fatal(err)
		}
	}
	after, _ := c.Snapshot(ctx)
	if after.WorkItems[0].Status != "abandoned" {
		t.Fatalf("%+v", after.WorkItems)
	}
	if n, err := c.ReconcileAttributions(ctx); err != nil || n != 0 {
		t.Fatalf("%d %v", n, err)
	}
}
