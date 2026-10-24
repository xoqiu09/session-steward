package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

// 重开之后迟到的上一轮交付不改状态，也不能推送“需要你”；边界之后的新交付和别的工作项照常推送。
func TestNotifierSkipsHandoffsBeforeReopenBoundary(t *testing.T) {
	c, at := claimed(t, "RO-1")
	ctx := context.Background()
	d := ev("s1", event.KindDeliver, at.Add(time.Minute))
	d.Text = "First cycle delivery"
	mustIngest(t, c, d)
	for _, s := range []string{"done", "in_progress"} {
		if err := c.UpdateWorkItem(ctx, "RO-1", WorkItemPatch{Status: &s}); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "RO-2", Title: "other"}); err != nil {
		t.Fatal(err)
	}
	mustIngest(t, c, ev("s2", event.KindSessionStart, at))
	cl := ev("s2", event.KindClaim, at.Add(time.Second))
	cl.WorkTag = "RO-2"
	mustIngest(t, c, cl)

	n := &Notifier{C: c, since: c.St.NowTS(), BaseURL: "http://127.0.0.1:1"}
	late := ev("s1", event.KindDeliver, at.Add(2*time.Minute))
	late.Text = "Late old delivery"
	mustIngest(t, c, late)
	mustIngest(t, c, report("s2", at.Add(2*time.Minute), map[string]string{"next_owner": "user", "next": "synthetic"}))
	if b := briefOf(t, c, "RO-1"); b.Fields["next_owner"].Text != "unknown" {
		t.Fatalf("panel should hide pre-reopen handoff: %+v", b.Fields["next_owner"])
	}
	alerts, err := n.Pending(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(alerts) != 1 || alerts[0].Link != "http://127.0.0.1:1/#item=RO-2" {
		t.Fatalf("late pre-reopen delivery notified or other item filtered: %+v", alerts)
	}

	now := time.Now().UTC()
	claim := ev("s1", event.KindClaim, now.Add(time.Second))
	claim.WorkTag = "RO-1"
	mustIngest(t, c, claim)
	fresh := ev("s1", event.KindDeliver, now.Add(2*time.Second))
	fresh.Text = "Fresh delivery"
	mustIngest(t, c, fresh)
	alerts, err = n.Pending(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	freshFound := false
	for _, a := range alerts {
		got = append(got, a.Title+"@"+a.Link)
		if a.Title == "交付待你验收" && a.Link == "http://127.0.0.1:1/#item=RO-1" {
			freshFound = true
		}
	}
	if len(alerts) != 2 || !freshFound {
		t.Fatalf("post-reopen delivery must notify: %v", got)
	}
}
