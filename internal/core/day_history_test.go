package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/usage"
)

type fakeDetail struct{ fakeUsage }

func (f fakeDetail) Detail(_, sid string, loc *time.Location) (usage.Detail, []usage.Subagent, usage.Detail, bool) {
	t, ok := f.fakeUsage[sid]
	if !ok {
		return usage.Detail{}, nil, usage.Detail{}, false
	}
	day := time.Now().In(loc).Format("2006-01-02")
	d := usage.Detail{ByDay: map[string]map[string]usage.Totals{day: {"m-1": t}}, Models: map[string]usage.Totals{"m-1": t}, Total: t}
	return d, []usage.Subagent{{ID: "a1", Type: "Explore", Finished: true}}, d, true
}

func TestHistoryDaysAndDayDetail(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	now := time.Now()
	c.Ingest(ctx, ev("h1", event.KindSessionStart, now))
	c.Ingest(ctx, ev("h1", event.KindPrompt, now))
	e := ev("h1", event.KindToolPost, now)
	e.ToolName = "Bash"
	c.Ingest(ctx, e)
	c.Ingest(ctx, ev("h1", event.KindSubagentOn, now))
	c.CreateWorkItem(ctx, WorkItemInput{ID: "HI-1", Title: "历史测试"})
	claim := ev("h1", event.KindClaim, now)
	claim.WorkTag = "HI-1"
	c.Ingest(ctx, claim)
	for _, st := range []string{"review", "in_progress", "review", "done"} {
		st := st
		if err := c.UpdateWorkItem(ctx, "HI-1", WorkItemPatch{Status: &st}); err != nil {
			t.Fatal(st, err)
		}
	}
	src := fakeDetail{fakeUsage{"h1": {Input: 10, Output: 5}}}
	if _, err := c.RefreshUsage(ctx, src, time.Hour); err != nil {
		t.Fatal(err)
	}
	h, err := c.History(ctx, 7, true)
	if err != nil || len(h.Days) != 1 {
		t.Fatalf("%v %+v", err, h)
	}
	d := h.Days[0]
	if d.Sessions != 1 || d.Prompts != 1 || d.Tools != 1 || d.Subagents != 1 || d.Delivered != 2 || d.Returned != 1 || d.Accepted != 1 {
		t.Fatalf("当天汇总 %+v", d)
	}
	if d.Tokens.Output != 5 || d.ByProvider["claude"] != 15 || d.ByModel["m-1"] != 15 {
		t.Fatalf("token %+v", d)
	}
	if off, _ := c.History(ctx, 7, false); off.Days[0].Tokens.Output != 0 || off.TokensEnabled {
		t.Fatal("关闭用量统计时不应返回 token")
	}
	dd, err := c.HistoryDay(ctx, d.Day, true)
	if err != nil || len(dd.Items) != 1 || len(dd.Items[0].Changes) < 4 || len(dd.Sessions) != 1 || dd.Sessions[0].Tokens.Output != 5 || dd.Sessions[0].Prompts != 1 {
		t.Fatalf("%v %+v", err, dd)
	}
	if _, err := c.HistoryDay(ctx, "昨天", true); err == nil {
		t.Fatal("日期格式错误应报错")
	}
	c.UsageDetail = src
	var sid int64
	c.St.R().QueryRow(`SELECT id FROM sessions WHERE provider_session_id='h1'`).Scan(&sid)
	su, err := c.SessionUsage(ctx, sid)
	if err != nil || !su.Found || len(su.Subagents) != 1 || su.Self.ByDay != nil {
		t.Fatalf("%v %+v", err, su)
	}
}
