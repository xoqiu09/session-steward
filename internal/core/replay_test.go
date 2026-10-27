package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestSnapshotAtRewindsItemsRunsAndSessions(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	c.Ingest(ctx, ev("r1", event.KindSessionStart, time.Now()))
	c.Ingest(ctx, ev("r1", event.KindPrompt, time.Now()))
	c.CreateWorkItem(ctx, WorkItemInput{ID: "RP-1", Title: "回放"})
	claim := ev("r1", event.KindClaim, time.Now())
	claim.WorkTag = "RP-1"
	c.Ingest(ctx, claim)
	review := "review"
	if err := c.UpdateWorkItem(ctx, "RP-1", WorkItemPatch{Status: &review}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	t1 := time.Now()
	time.Sleep(5 * time.Millisecond)
	done := "done"
	c.UpdateWorkItem(ctx, "RP-1", WorkItemPatch{Status: &done})
	c.Ingest(ctx, ev("r1", event.KindStop, time.Now()))
	c.CreateWorkItem(ctx, WorkItemInput{ID: "RP-2", Title: "之后才建"})

	past, err := c.SnapshotAt(ctx, t1)
	if err != nil {
		t.Fatal(err)
	}
	if past.ReplayAt == "" || len(past.WorkItems) != 1 || past.WorkItems[0].Status != "review" {
		t.Fatalf("工作项应停在待验收、且不含之后新建的：%+v", past.WorkItems)
	}
	if len(past.Sessions) != 1 || past.Sessions[0].State != "running" || past.Sessions[0].WorkItemID != "RP-1" {
		t.Fatalf("会话在那一刻还在干活：%+v", past.Sessions)
	}
	now, _ := c.SnapshotAt(ctx, time.Now())
	if now.Sessions[0].State != "idle" {
		t.Fatalf("停下之后应为空闲：%+v", now.Sessions[0])
	}
	if _, err := c.SnapshotAt(ctx, time.Now().Add(time.Hour)); err == nil {
		t.Fatal("未来时间应报错")
	}
}
