package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func itemOf(t *testing.T, c *Core, id string) WorkItem {
	t.Helper()
	snap, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range snap.WorkItems {
		if w.ID == id {
			return w
		}
	}
	t.Fatalf("没有工作项 %s", id)
	return WorkItem{}
}

func TestPromptAfterDeliveryRecordsReturnOnly(t *testing.T) {
	c, t0 := claimed(t, "RT-1")
	prompt := func(sid string, at time.Time) {
		e := ev(sid, event.KindPrompt, at)
		e.Text = "合成的下一步"
		mustIngest(t, c, e)
	}
	// 交付前发消息不算“回来过”。
	prompt("s1", t0.Add(time.Minute))
	d := ev("s1", event.KindDeliver, t0.Add(2*time.Minute))
	d.Text = "合成交付"
	mustIngest(t, c, d)
	if w := itemOf(t, c, "RT-1"); w.Status != "review" || w.ReturnedAt != "" {
		t.Fatalf("交付后、回来之前：%s %q", w.Status, w.ReturnedAt)
	}

	back := t0.Add(5 * time.Minute)
	prompt("s1", back)
	w := itemOf(t, c, "RT-1")
	if w.Status != "review" {
		t.Fatalf("回到会话不能改变状态，更不能算验收：%s", w.Status)
	}
	if w.ReturnedAt == "" || w.ReturnedAt <= w.Brief.LastDeliveredAt {
		t.Fatalf("应记下交付后回来的时间：returned=%q delivered=%q", w.ReturnedAt, w.Brief.LastDeliveredAt)
	}

	// 乱序到达的旧消息不把时间往回改；别的会话发消息不算。
	first := w.ReturnedAt
	prompt("s1", t0.Add(3*time.Minute))
	mustIngest(t, c, ev("s2", event.KindSessionStart, t0.Add(6*time.Minute)))
	prompt("s2", t0.Add(7*time.Minute))
	if got := itemOf(t, c, "RT-1").ReturnedAt; got != first {
		t.Fatalf("旧事件或其他会话改了时间：%q -> %q", first, got)
	}
}

func TestPromptDoesNotMarkItemsOutsideReview(t *testing.T) {
	c, t0 := claimed(t, "RT-2")
	d := ev("s1", event.KindDeliver, t0.Add(time.Minute))
	d.Text = "合成交付"
	mustIngest(t, c, d)
	st := "done"
	if err := c.UpdateWorkItem(context.Background(), "RT-2", WorkItemPatch{Status: &st}); err != nil {
		t.Fatal(err)
	}
	mustIngest(t, c, ev("s1", event.KindPrompt, t0.Add(2*time.Minute)))
	if got := itemOf(t, c, "RT-2").ReturnedAt; got != "" {
		t.Fatalf("已处理的工作项不该再记回来：%q", got)
	}
}
