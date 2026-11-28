package core

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
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
	// 升级前归档进去的占位“模型”行（0 token）不应出现在按模型的列表里
	var sid0 int64
	c.St.R().QueryRow(`SELECT id FROM sessions WHERE provider_session_id='h1'`).Scan(&sid0)
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO usage_daily(session_id,day,model) VALUES(?,?,?)`, sid0, time.Now().Format("2006-01-02"), "<synthetic>")
		return err
	}); err != nil {
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
	if _, ok := d.ByModel["<synthetic>"]; ok {
		t.Fatalf("占位模型不应出现：%+v", d.ByModel)
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

func TestHistoryRefreshesWhenOnlyClaudeSubagentUsageChanges(t *testing.T) {
	t.Run("parent_has_usage", func(t *testing.T) {
		testHistoryWithClaudeSubagentUsage(t, 100)
	})
	t.Run("parent_has_no_usage", func(t *testing.T) {
		testHistoryWithClaudeSubagentUsage(t, 0)
	})
}

func testHistoryWithClaudeSubagentUsage(t *testing.T, parentTokens int64) {
	t.Helper()
	c := newCore(t, nil)
	ctx := context.Background()
	now := time.Date(2026, 11, 22, 12, 0, 0, 0, time.Local)
	c.St.Now = func() time.Time { return now }
	const sid = "history-parent"
	ingested, err := c.Ingest(ctx, ev(sid, event.KindSessionStart, now))
	if err != nil {
		t.Fatal(err)
	}

	src := usage.Finder{ClaudeRoot: t.TempDir()}
	c.UsageDetail = src
	projectDir := filepath.Join(src.ClaudeRoot, "project")
	subDir := filepath.Join(projectDir, sid, "subagents")
	if err := os.MkdirAll(subDir, 0o700); err != nil {
		t.Fatal(err)
	}
	line := func(id string, tokens int64) string {
		return fmt.Sprintf(`{"type":"assistant","timestamp":%q,"message":{"id":%q,"model":"claude-test","usage":{"input_tokens":%d}}}`+"\n",
			now.Format(time.RFC3339), id, tokens)
	}
	write := func(path, contents string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(projectDir, sid+".jsonl"), line("parent", parentTokens))
	subFile := filepath.Join(subDir, "agent-child.jsonl")
	subUsage := line("child-1", 20)
	write(subFile, subUsage)

	check := func(step string, wantTokens int64, wantChanged int) {
		t.Helper()
		changed, err := c.RefreshUsage(ctx, src, time.Hour)
		if err != nil {
			t.Fatal(err)
		}
		history, err := c.History(ctx, 1, true)
		if err != nil || len(history.Days) != 1 {
			t.Fatalf("%s：读取历史失败，days=%v err=%v", step, history.Days, err)
		}
		tokens := tokenSum(history.Days[0].Tokens)
		if tokens != wantTokens || changed != wantChanged {
			t.Errorf("%s：历史用量=%d，更新会话数=%d；期望 %d、%d", step, tokens, changed, wantTokens, wantChanged)
			return
		}
		t.Logf("%s：历史用量=%d，更新会话数=%d", step, tokens, changed)
	}
	check("首次刷新", parentTokens+20, 1)
	write(subFile, subUsage+line("child-2", 30))
	detail, err := c.SessionUsage(ctx, ingested.SessionID)
	if err != nil || !detail.Found || len(detail.Subagents) != 1 || tokenSum(detail.Self.Total) != parentTokens || tokenSum(detail.WithSubs) != parentTokens+50 {
		t.Fatalf("会话详情应显示主会话用量 %d、合计 %d：%+v err=%v", parentTokens, parentTokens+50, detail, err)
	}
	check("只增加子助手用量", parentTokens+50, 1)
	check("用量没有变化", parentTokens+50, 0)
	if err := os.Remove(subFile); err != nil {
		t.Fatal(err)
	}
	check("清理子助手日志", parentTokens+50, 0)
}
