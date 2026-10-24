package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func briefOf(t *testing.T, c *Core, item string) *Brief {
	t.Helper()
	snap, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range snap.WorkItems {
		if w.ID == item {
			return w.Brief
		}
	}
	t.Fatalf("没有工作项 %s", item)
	return nil
}

func mustIngest(t *testing.T, c *Core, e *event.Event) {
	t.Helper()
	if _, err := c.Ingest(context.Background(), e); err != nil {
		t.Fatal(err)
	}
}

func report(sid string, at time.Time, fields map[string]string) *event.Event {
	e := ev(sid, event.KindReport, at)
	e.Brief = fields
	return e
}

func claimed(t *testing.T, item string) (*Core, time.Time) {
	t.Helper()
	c := newCore(t, nil)
	if err := c.CreateWorkItem(context.Background(), WorkItemInput{ID: item, Title: "x"}); err != nil {
		t.Fatal(err)
	}
	t0 := time.Now().UTC().Add(-3 * time.Hour)
	mustIngest(t, c, ev("s1", event.KindSessionStart, t0))
	cl := ev("s1", event.KindClaim, t0.Add(time.Second))
	cl.WorkTag = item
	mustIngest(t, c, cl)
	return c, t0
}

func TestReportWritesBriefWithSource(t *testing.T) {
	c, t0 := claimed(t, "QM-1")
	at := t0.Add(time.Minute)
	mustIngest(t, c, report("s1", at, map[string]string{"goal": "断网恢复", "progress": "已修复重连循环", "bogus": "x"}))
	b := briefOf(t, c, "QM-1")
	if b == nil || b.Fields["goal"].Text != "断网恢复" || b.Fields["progress"].Kind != "agent" || b.Fields["progress"].Source != "report" {
		t.Fatalf("简报 = %+v", b)
	}
	if b.Fields["progress"].SessionID == nil {
		t.Fatal("缺少来源会话")
	}
	if got, _ := time.Parse(time.RFC3339Nano, b.Fields["progress"].At); !got.Equal(at) {
		t.Fatalf("时间应为内容产生时间，得到 %s", b.Fields["progress"].At)
	}
	if _, ok := b.Fields["bogus"]; ok {
		t.Fatal("未知字段不应写入")
	}
}

func TestStopAndToolsDoNotChangeBrief(t *testing.T) {
	c, t0 := claimed(t, "QM-1")
	mustIngest(t, c, report("s1", t0.Add(time.Minute), map[string]string{"progress": "开始实现"}))
	s := ev("s1", event.KindStop, t0.Add(2*time.Minute))
	s.Text = "全部完成了"
	mustIngest(t, c, s)
	mustIngest(t, c, ev("s1", event.KindToolPost, t0.Add(3*time.Minute)))
	b := briefOf(t, c, "QM-1")
	if b.Fields["progress"].Text != "开始实现" || len(b.Fields) != 1 {
		t.Fatalf("Stop/工具调用不应改变简报：%+v", b.Fields)
	}
	var status string
	c.St.R().QueryRow(`SELECT status FROM work_items WHERE id='QM-1'`).Scan(&status)
	if status == "done" || status == "review" {
		t.Fatalf("Stop 不应推进工作项状态，得到 %s", status)
	}
}

func TestNoBriefWithoutReport(t *testing.T) {
	c, t0 := claimed(t, "QM-1")
	for i := 0; i < 30; i++ {
		mustIngest(t, c, ev("s1", event.KindToolPost, t0.Add(time.Duration(i+2)*time.Minute)))
	}
	if b := briefOf(t, c, "QM-1"); b != nil {
		t.Fatalf("没有回报时简报应为空，得到 %+v", b)
	}
}

func TestReportWithoutClaimIgnored(t *testing.T) {
	c := newCore(t, nil)
	c.CreateWorkItem(context.Background(), WorkItemInput{ID: "QM-1", Title: "x"})
	t0 := time.Now().UTC().Add(-time.Hour)
	mustIngest(t, c, ev("s1", event.KindSessionStart, t0))
	mustIngest(t, c, report("s1", t0.Add(time.Minute), map[string]string{"progress": "p"}))
	if b := briefOf(t, c, "QM-1"); b != nil {
		t.Fatal("未关联工作项的会话回报不应写入任何工作项")
	}
	if item, _ := c.SessionHasActiveItem(context.Background(), "h", "claude", "s1"); item != "" {
		t.Fatalf("应无关联，得到 %s", item)
	}
}

func TestAskAndDeliverFillBrief(t *testing.T) {
	c, t0 := claimed(t, "QM-1")
	a := ev("s1", event.KindAsk, t0.Add(time.Minute))
	a.Text = "离线时是否保留最后一次行情？"
	mustIngest(t, c, a)
	d := ev("s1", event.KindDeliver, t0.Add(2*time.Minute))
	d.Text = "已交付，附 3 个测试"
	mustIngest(t, c, d)
	b := briefOf(t, c, "QM-1")
	if b.Fields["blocker"].Source != "ask" || b.Fields["progress"].Source != "deliver" {
		t.Fatalf("%+v", b.Fields)
	}
}

func TestUserEditNotOverwrittenByAgent(t *testing.T) {
	c, t0 := claimed(t, "QM-1")
	ctx := context.Background()
	mustIngest(t, c, report("s1", t0.Add(time.Minute), map[string]string{"goal": "agent 目标"}))
	id, err := c.EditBrief(ctx, "QM-1", BriefEdit{Field: "goal", Action: "set", Text: "我的目标"})
	if err != nil {
		t.Fatal(err)
	}
	mustIngest(t, c, report("s1", time.Now().UTC().Add(time.Minute), map[string]string{"goal": "新 agent 目标"}))
	g := briefOf(t, c, "QM-1").Fields["goal"]
	if g.Text != "我的目标" || g.Kind != "user" {
		t.Fatalf("用户条目应优先：%+v", g)
	}
	if g.Pending == nil || g.Pending.Text != "新 agent 目标" {
		t.Fatalf("新回报应作为待对照：%+v", g.Pending)
	}
	// 撤销用户编辑后回到最新的 agent 回报
	if _, err := c.EditBrief(ctx, "QM-1", BriefEdit{Field: "goal", Action: "undo", EntryID: id}); err != nil {
		t.Fatal(err)
	}
	g = briefOf(t, c, "QM-1").Fields["goal"]
	if g.Text != "新 agent 目标" || g.Kind != "agent" || g.Pending != nil {
		t.Fatalf("撤销后：%+v", g)
	}
}

func TestConfirmKeepsContentTime(t *testing.T) {
	c, t0 := claimed(t, "QM-1")
	at := t0.Add(time.Minute)
	mustIngest(t, c, report("s1", at, map[string]string{"progress": "p1"}))
	p := briefOf(t, c, "QM-1").Fields["progress"]
	if _, err := c.EditBrief(context.Background(), "QM-1", BriefEdit{Field: "progress", Action: "confirm", EntryID: p.EntryID}); err != nil {
		t.Fatal(err)
	}
	p2 := briefOf(t, c, "QM-1").Fields["progress"]
	if p2.Kind != "user" || p2.Source != "confirm" || p2.At != p.At || p2.Pending != nil {
		t.Fatalf("%+v", p2)
	}
	if _, err := c.EditBrief(context.Background(), "QM-1", BriefEdit{Field: "progress", Action: "confirm", EntryID: p2.EntryID}); err == nil {
		t.Fatal("不应能确认用户条目")
	}
}

func TestFlagWrongShowsMissingNotOlder(t *testing.T) {
	c, t0 := claimed(t, "QM-1")
	ctx := context.Background()
	mustIngest(t, c, report("s1", t0.Add(time.Minute), map[string]string{"progress": "旧"}))
	mustIngest(t, c, report("s1", t0.Add(2*time.Minute), map[string]string{"progress": "测试全部通过"}))
	p := briefOf(t, c, "QM-1").Fields["progress"]
	if _, err := c.EditBrief(ctx, "QM-1", BriefEdit{Field: "progress", Action: "flag", EntryID: p.EntryID}); err != nil {
		t.Fatal(err)
	}
	f := briefOf(t, c, "QM-1").Fields["progress"]
	if !f.Flagged || f.Text != "" {
		t.Fatalf("标记有误后不应回退到旧回报：%+v", f)
	}
	// 新回报会替换被标记的条目
	mustIngest(t, c, report("s1", t0.Add(3*time.Minute), map[string]string{"progress": "修复 2 个失败用例"}))
	if f := briefOf(t, c, "QM-1").Fields["progress"]; f.Flagged || f.Text != "修复 2 个失败用例" {
		t.Fatalf("%+v", f)
	}
	// 撤销标记
	if _, err := c.EditBrief(ctx, "QM-1", BriefEdit{Field: "progress", Action: "undo", EntryID: p.EntryID}); err != nil {
		t.Fatal(err)
	}
}

func TestEmptyReportClearsField(t *testing.T) {
	c, t0 := claimed(t, "QM-1")
	mustIngest(t, c, report("s1", t0.Add(time.Minute), map[string]string{"blocker": "等决定"}))
	mustIngest(t, c, report("s1", t0.Add(2*time.Minute), map[string]string{"blocker": ""}))
	if b := briefOf(t, c, "QM-1"); b.Fields["blocker"] != nil {
		t.Fatalf("空值应清除卡点：%+v", b.Fields["blocker"])
	}
}

func TestBriefStale(t *testing.T) {
	c, t0 := claimed(t, "QM-1")
	mustIngest(t, c, report("s1", t0.Add(time.Minute), map[string]string{"progress": "p"}))
	for i := 0; i < 5; i++ {
		mustIngest(t, c, ev("s1", event.KindToolPost, t0.Add(time.Duration(2+i)*time.Minute)))
	}
	b := briefOf(t, c, "QM-1")
	if b.Stale || b.ToolEventsSince != 5 {
		t.Fatalf("少量活动不应过期：%+v", b)
	}
	mustIngest(t, c, ev("s1", event.KindToolPost, t0.Add(90*time.Minute)))
	if b := briefOf(t, c, "QM-1"); !b.Stale {
		t.Fatalf("回报后 60 分钟以上仍有活动应提示过期：%+v", b)
	}
	mustIngest(t, c, report("s1", t0.Add(91*time.Minute), map[string]string{"progress": "p2"}))
	if b := briefOf(t, c, "QM-1"); b.Stale || b.ToolEventsSince != 0 {
		t.Fatalf("新回报后应清除过期：%+v", b)
	}
}

func TestEditBriefValidation(t *testing.T) {
	c, _ := claimed(t, "QM-1")
	ctx := context.Background()
	if _, err := c.EditBrief(ctx, "QM-1", BriefEdit{Field: "x", Action: "set"}); err == nil {
		t.Fatal("未知字段应报错")
	}
	if _, err := c.EditBrief(ctx, "QM-9", BriefEdit{Field: "goal", Action: "set", Text: "a"}); err == nil {
		t.Fatal("不存在的工作项应报错")
	}
	if _, err := c.EditBrief(ctx, "QM-1", BriefEdit{Field: "goal", Action: "flag", EntryID: 999}); err == nil {
		t.Fatal("不存在的条目应报错")
	}
	long := make([]rune, 400)
	for i := range long {
		long[i] = '字'
	}
	c.EditBrief(ctx, "QM-1", BriefEdit{Field: "goal", Action: "set", Text: string(long)})
	if n := len([]rune(briefOf(t, c, "QM-1").Fields["goal"].Text)); n != briefMaxText {
		t.Fatalf("应截断到 %d，得到 %d", briefMaxText, n)
	}
}
