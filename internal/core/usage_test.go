package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/usage"
)

type fakeUsage map[string]usage.Totals

func (f fakeUsage) Totals(_, sid string) (usage.Totals, bool) {
	t, ok := f[sid]
	return t, ok
}

func TestUsagePerSessionAndItem(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	for _, sid := range []string{"u1", "u2", "u3"} {
		c.Ingest(ctx, ev(sid, event.KindSessionStart, time.Now()))
	}
	c.CreateWorkItem(ctx, WorkItemInput{ID: "US-1", Title: "a"})
	c.CreateWorkItem(ctx, WorkItemInput{ID: "US-2", Title: "b"})
	claim := func(sid, item string) {
		e := ev(sid, event.KindClaim, time.Now())
		e.WorkTag = item
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	claim("u1", "US-1")
	claim("u2", "US-1")
	claim("u3", "US-1")
	time.Sleep(2 * time.Millisecond)
	claim("u3", "US-2") // u3 先后做过两个工作项
	src := fakeUsage{"u1": {Input: 10, Output: 1}, "u2": {Input: 5, Output: 2, CacheRead: 100}, "u3": {Output: 3}}
	n, err := c.RefreshUsage(ctx, src, time.Hour)
	if err != nil || n != 3 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if n, _ := c.RefreshUsage(ctx, src, time.Hour); n != 0 {
		t.Fatal("未变化不应重写")
	}
	snap, _ := c.Snapshot(ctx)
	if len(snap.SessionUsage) != 3 {
		t.Fatal(snap.SessionUsage)
	}
	items := map[string]ItemUsage{}
	for _, u := range snap.ItemUsage {
		items[u.WorkItemID] = u
	}
	if u := items["US-1"]; u.Input != 15 || u.Output != 6 || u.Sessions != 3 || u.Shared != 1 {
		t.Fatalf("US-1 %+v", u)
	}
	if u := items["US-2"]; u.Output != 3 || u.Sessions != 1 || u.Shared != 1 {
		t.Fatalf("US-2 %+v", u)
	}
}
