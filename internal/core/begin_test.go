package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
)

func TestBeginCreatesAndReusesItemWithBrief(t *testing.T) {
	c := newCore(t, nil)
	now := time.Now().UTC().Add(-time.Hour)
	begin := func(sid string, at time.Time) string {
		e := ev(sid, event.KindBegin, at)
		e.WorkTitle = "修复简报可靠性"
		e.Brief = map[string]string{"goal": "旧消息不覆盖新进展", "progress": "已开始定位"}
		r, err := c.Ingest(context.Background(), e)
		if err != nil {
			t.Fatal(err)
		}
		return r.WorkItemID
	}
	first := begin("s1", now)
	if first == "" {
		t.Fatal("missing item")
	}
	if again := begin("s1", now.Add(time.Second)); again != first {
		t.Fatalf("重复 begin 创建了不同工作项: %s", again)
	}
	if second := begin("s2", now.Add(2*time.Second)); second != first {
		t.Fatalf("同项目同标题未复用: %s", second)
	}
	snap, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.WorkItems) != 1 || len(snap.Runs) != 2 {
		t.Fatalf("items=%d runs=%d", len(snap.WorkItems), len(snap.Runs))
	}
	if snap.WorkItems[0].Brief.Fields["progress"].Text != "已开始定位" {
		t.Fatal("首份简报未写入")
	}
}

func TestBeginPreservesExistingDifferentBinding(t *testing.T) {
	c, t0 := claimed(t, "PIN-1")
	e := ev("s1", event.KindBegin, t0.Add(time.Minute))
	e.WorkTitle = "不同任务"
	if _, err := c.Ingest(context.Background(), e); err == nil {
		t.Fatal("begin 不得改绑已有任务")
	}
	snap, _ := c.Snapshot(context.Background())
	if len(snap.WorkItems) != 1 || snap.Sessions[0].WorkItemID != "PIN-1" {
		t.Fatal("原归属被更改")
	}
}

func TestBeginRequiresExplicitProjectOutsideRepo(t *testing.T) {
	c := newCore(t, fakeLoc{gitx.Location{IsGit: false, CommonDir: "dir:/workspace", Worktree: "/workspace", RepoName: "Workspace"}})
	e := ev("s1", event.KindBegin, time.Now().UTC())
	e.WorkTitle = "某个任务"
	if _, err := c.Ingest(context.Background(), e); err == nil {
		t.Fatal("集合目录不能自动当作工作项目")
	}
	snap, _ := c.Snapshot(context.Background())
	if len(snap.WorkItems) != 0 {
		t.Fatal("失败留下空任务")
	}
}
