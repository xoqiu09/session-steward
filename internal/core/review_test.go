package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestAgentReviewCountsOnlyFacts(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	mk := func(sid, provider, item string) {
		e := ev(sid, event.KindClaim, time.Now())
		e.Source.Provider, e.WorkTag = provider, item
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	deliver := func(sid, provider string) {
		e := ev(sid, event.KindDeliver, time.Now())
		e.Source.Provider, e.Text = provider, "合成交付"
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	for _, id := range []string{"RV-1", "RV-2", "RV-3", "RV-4", "RV-5"} {
		c.CreateWorkItem(ctx, WorkItemInput{ID: id, Title: id})
	}
	mk("c1", "claude", "RV-1")
	deliver("c1", "claude")
	mk("c2", "claude", "RV-2")
	deliver("c2", "claude")
	mk("c3", "claude", "RV-3") // 没有交付
	mk("x1", "codex", "RV-4")
	deliver("x1", "codex")
	mk("x2", "codex", "RV-5")
	time.Sleep(2 * time.Millisecond)
	done, reopen, abandon := "done", "in_progress", "abandoned"
	c.UpdateWorkItem(ctx, "RV-1", WorkItemPatch{Status: &done})    // 用户验收
	c.UpdateWorkItem(ctx, "RV-2", WorkItemPatch{Status: &reopen})  // 交付后重开
	c.UpdateWorkItem(ctx, "RV-5", WorkItemPatch{Status: &abandon}) // 放弃
	r, err := c.AgentReview(ctx, 30)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]AgentReview{}
	for _, a := range r.Agents {
		got[a.Provider] = a
	}
	if a := got["claude"]; a.Runs != 3 || a.Delivered != 2 || a.Accepted != 1 || a.Reopened != 1 || a.OpenPending != 0 {
		t.Fatalf("claude %+v", a)
	}
	if a := got["codex"]; a.Runs != 2 || a.Delivered != 1 || a.Accepted != 0 || a.OpenPending != 1 || a.Abandoned != 1 {
		t.Fatalf("codex %+v", a)
	}
}

func TestAgentReviewDoesNotCopyDeliveryAcrossRuns(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "RV-8", Title: "synthetic"}); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for i, kind := range []event.Kind{event.KindClaim, event.KindDeliver, event.KindSessionEnd, event.KindSessionStart, event.KindClaim} {
		e := ev("resume-review", kind, now.Add(time.Duration(i)*time.Millisecond))
		e.WorkTag = "RV-8"
		if kind == event.KindDeliver {
			e.Text = "first run delivered"
		}
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	r, err := c.AgentReview(ctx, 30)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Agents) != 1 || r.Agents[0].Runs != 2 || r.Agents[0].Delivered != 1 {
		t.Fatalf("delivery attributed to wrong run: %+v", r.Agents)
	}
}
