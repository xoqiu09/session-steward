package core

import (
	"context"
	"github.com/xoqiu09/session-steward/internal/event"
	"testing"
	"time"
)

func TestDelayedReportDoesNotOverwriteNewerProgress(t *testing.T) {
	c, t0 := claimed(t, "AUD-1")
	mustIngest(t, c, report("s1", t0.Add(2*time.Minute), map[string]string{"progress": "new progress"}))
	mustIngest(t, c, report("s1", t0.Add(time.Minute), map[string]string{"progress": "old spooled progress"}))
	got := briefOf(t, c, "AUD-1").Fields["progress"].Text
	if got != "new progress" {
		t.Fatalf("late old report overwrote current progress: %q", got)
	}
}
func TestDelayedReportStaysWithOriginalWorkItem(t *testing.T) {
	c, t0 := claimed(t, "AUD-1")
	if err := c.CreateWorkItem(context.Background(), WorkItemInput{ID: "AUD-2", Title: "second task"}); err != nil {
		t.Fatal(err)
	}
	cl := ev("s1", event.KindClaim, t0.Add(3*time.Minute))
	cl.WorkTag = "AUD-2"
	mustIngest(t, c, cl)
	mustIngest(t, c, report("s1", t0.Add(time.Minute), map[string]string{"progress": "first task progress"}))
	second := briefOf(t, c, "AUD-2")
	if second != nil && second.Fields["progress"] != nil {
		t.Fatalf("old first-task report contaminated second task: %q", second.Fields["progress"].Text)
	}
	first := briefOf(t, c, "AUD-1")
	if first == nil || first.Fields["progress"] == nil {
		t.Fatal("old report lost original work item")
	}
}

func TestDelayedTaggedPromptDoesNotRedirectDelivery(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	for _, id := range []string{"SYN-1", "SYN-2"} {
		if err := c.CreateWorkItem(ctx, WorkItemInput{ID: id, Title: id}); err != nil {
			t.Fatal(err)
		}
	}
	const session = "s1"
	at := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)
	current := ev(session, event.KindPrompt, at.Add(5*time.Minute))
	current.WorkTag = "SYN-2"
	mustIngest(t, c, current)
	late := ev(session, event.KindPrompt, at)
	late.WorkTag = "SYN-1"
	mustIngest(t, c, late)

	var storedTag string
	if err := c.St.R().QueryRow(`SELECT json_extract(body, '$.work_tag') FROM events WHERE event_id=?`, late.EventID).Scan(&storedTag); err != nil {
		t.Fatal(err)
	}
	if storedTag != late.WorkTag {
		t.Errorf("late prompt in history has tag %q, want %q", storedTag, late.WorkTag)
	}
	item, err := c.SessionHasActiveItem(ctx, "h", "claude", session)
	if err != nil {
		t.Fatal(err)
	}
	if item != "SYN-2" {
		t.Errorf("active work item after late prompt = %s, want SYN-2", item)
	}

	mustIngest(t, c, ev(session, event.KindDeliver, at.Add(7*time.Minute)))
	snap, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	status := map[string]string{}
	for _, item := range snap.WorkItems {
		status[item.ID] = item.Status
	}
	if status["SYN-1"] != "todo" || status["SYN-2"] != "review" {
		t.Errorf("after delivery: SYN-1 = %s, SYN-2 = %s; want todo, review", status["SYN-1"], status["SYN-2"])
	}
}

func TestPinnedProgressRemainsStaleWhenNewReportNeedsComparison(t *testing.T) {
	c, t0 := claimed(t, "AUD-1")
	mustIngest(t, c, report("s1", t0.Add(time.Minute), map[string]string{"progress": "old confirmed progress"}))
	p := briefOf(t, c, "AUD-1").Fields["progress"]
	if _, err := c.EditBrief(context.Background(), "AUD-1", BriefEdit{Field: "progress", Action: "confirm", EntryID: p.EntryID}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 22; i++ {
		mustIngest(t, c, ev("s1", event.KindToolPost, t0.Add(time.Duration(i+2)*time.Minute)))
	}
	mustIngest(t, c, report("s1", t0.Add(25*time.Minute), map[string]string{"progress": "new unconfirmed progress"}))
	b := briefOf(t, c, "AUD-1")
	if !b.Stale || b.ToolEventsSince != 22 || b.Fields["progress"].Pending == nil {
		t.Fatalf("置顶进展不应被待对照回报消除过期提示: %+v", b)
	}
}

func TestReportAtRebindBoundaryBelongsToNewRun(t *testing.T) {
	c, t0 := claimed(t, "AUD-1")
	c.CreateWorkItem(context.Background(), WorkItemInput{ID: "AUD-2", Title: "second"})
	at := t0.Add(time.Minute)
	cl := ev("s1", event.KindClaim, at)
	cl.WorkTag = "AUD-2"
	mustIngest(t, c, cl)
	mustIngest(t, c, report("s1", at, map[string]string{"progress": "second progress"}))
	if b := briefOf(t, c, "AUD-1"); b != nil {
		t.Fatal("区间交界处被记给了上一个任务")
	}
	if b := briefOf(t, c, "AUD-2"); b == nil || b.Fields["progress"].Text != "second progress" {
		t.Fatal("新任务没有收到回报")
	}
}
