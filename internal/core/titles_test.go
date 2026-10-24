package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/scan"
)

func TestTitleRefreshPreservesLifecycleAndAttribution(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	at := time.Now().Add(-time.Hour)
	if _, err := c.Ingest(ctx, ev("one", event.KindStop, at)); err != nil {
		t.Fatal(err)
	}
	before, _ := c.Snapshot(ctx)
	title := scan.Title{Provider: "claude", SessionID: "one", Text: "修复订单列表", Source: "claude_title_index", UpdatedAt: time.Now()}
	if err := c.RefreshTitles(ctx, "h", []scan.Title{title, {Provider: "codex", SessionID: "absent", Text: "不得创建会话"}}); err != nil {
		t.Fatal(err)
	}
	after, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s := after.Sessions[0]
	if len(after.Sessions) != 1 || s.Title != title.Text || s.State != before.Sessions[0].State || s.LastActivityAt != before.Sessions[0].LastActivityAt || s.WorkItemID != "" {
		t.Fatalf("%+v", s)
	}
	cursor := after.Cursor
	if err := c.RefreshTitles(ctx, "h", []scan.Title{title}); err != nil {
		t.Fatal(err)
	}
	stable, _ := c.Snapshot(ctx)
	if stable.Cursor != cursor {
		t.Fatal("unchanged title generated an SSE change")
	}
	title.Text = "过期的标题"
	title.UpdatedAt = at
	if err := c.RefreshTitles(ctx, "h", []scan.Title{title}); err != nil {
		t.Fatal(err)
	}
	stable, _ = c.Snapshot(ctx)
	if stable.Sessions[0].Title == title.Text {
		t.Fatal("old metadata replaced latest title")
	}
}

func TestCreateAndBindIsAtomic(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	missing := int64(999)
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "WI-001", Title: "不得留下孤立工作项", SessionID: &missing}); err == nil {
		t.Fatal("expected missing session failure")
	}
	if c.WorkItemExists(ctx, "WI-001") {
		t.Fatal("failed binding did not roll back creation")
	}
	result, err := c.Ingest(ctx, ev("one", event.KindPrompt, time.Now()))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "WI-002", Title: "注册并关联", SessionID: &result.SessionID}); err != nil {
		t.Fatal(err)
	}
	snap, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Sessions[0].WorkItemID != "WI-002" || snap.Sessions[0].Binding != "manual" || snap.WorkItems[0].Status != "in_progress" {
		t.Fatalf("%+v", snap)
	}
}

func TestSnapshotExposesLastToolAsObservation(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	e := ev("one", event.KindToolPre, time.Now())
	e.Preview = "Bash: run checks"
	if _, err := c.Ingest(ctx, e); err != nil {
		t.Fatal(err)
	}
	snap, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Sessions[0].LastToolPreview != e.Preview || snap.Sessions[0].LastToolAt == "" {
		t.Fatalf("%+v", snap.Sessions[0])
	}
}

func TestCreateWorkItemRegistersExplicitProjectDirectory(t *testing.T) {
	c := newCore(t, nil)
	if err := c.CreateWorkItem(context.Background(), WorkItemInput{ID: "WI-003", Title: "选择真实项目", RepoPath: t.TempDir()}); err != nil {
		t.Fatal(err)
	}
	snap, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snap.WorkItems[0].RepoID == nil || len(snap.Repos) != 1 {
		t.Fatalf("%+v", snap)
	}
	if err := c.CreateWorkItem(context.Background(), WorkItemInput{ID: "WI-004", Title: "无效目录", RepoPath: "/missing-steward-test-directory"}); err == nil {
		t.Fatal("accepted missing directory")
	}
}
