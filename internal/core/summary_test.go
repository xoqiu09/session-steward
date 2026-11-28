package core

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestSummaryOptInLabelsAndStaleness(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	e := ev("s1", event.KindBegin, time.Now())
	e.Cwd, e.WorkTitle = "/repo", "合成摘要任务"
	e.Brief = map[string]string{"progress": "完成一半 token=abcsecret99", "next": "补测试"}
	res, err := c.Ingest(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	item := res.WorkItemID
	var stdin string
	c.SummaryRun = func(_ context.Context, argv []string, in string) (string, error) {
		stdin = in
		return "  已完成一半，下一步补测试。password=hunter2  ", nil
	}
	if _, err := c.GenerateSummary(ctx, item); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("未开启时应拒绝: %v", err)
	}
	c.SummaryCmd = []string{"synthetic-llm"}
	if _, err := c.GenerateSummary(ctx, item); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("仓库未列入 summary_repos 应拒绝: %v", err)
	}
	c.SummaryRepos = []string{"repo"}
	s, err := c.GenerateSummary(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stdin, "abcsecret99") || !strings.Contains(stdin, "完成一半") || !strings.Contains(stdin, "不要补充或猜测") {
		t.Fatalf("输入材料: %s", stdin)
	}
	if strings.Contains(s.Text, "hunter2") || !s.Current {
		t.Fatalf("%+v", s)
	}
	// 简报不被摘要覆盖
	snap, _ := c.Snapshot(ctx)
	for _, w := range snap.WorkItems {
		if w.ID == item && w.Brief.Fields["progress"].Kind != "agent" {
			t.Fatal("摘要不能改简报")
		}
	}
	if len(snap.SummaryRepos) != 1 {
		t.Fatal(snap.SummaryRepos)
	}
	// 材料变化后标记过期
	r := ev("s1", event.KindReport, time.Now().Add(time.Second))
	r.Cwd, r.Brief = "/repo", map[string]string{"progress": "全部完成"}
	c.Ingest(ctx, r)
	got, _ := c.LatestSummary(ctx, item)
	if got == nil || got.Current {
		t.Fatalf("材料变化后应标记可能过期: %+v", got)
	}
	c.SummaryRun = func(context.Context, []string, string) (string, error) { return "", errors.New("boom") }
	if _, err := c.GenerateSummary(ctx, item); err == nil {
		t.Fatal("命令失败应报错")
	}
}

func TestBranchedSummaryBecomesStaleWhenOwnerHandlesDelivery(t *testing.T) {
	dir := gitInit(t)
	const branch = "fix/synthetic"
	git(t, dir, "branch", branch)
	c := newCore(t, gitLocator{})
	ctx := context.Background()
	const item = "SYN-1"
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: item, Title: "合成摘要任务", Branch: branch, RepoPath: dir}); err != nil {
		t.Fatal(err)
	}
	at := time.Now().Add(-time.Minute)
	claim := ev("s1", event.KindClaim, at)
	claim.Cwd, claim.WorkTag = dir, item
	mustIngest(t, c, claim)
	deliver := ev("s1", event.KindDeliver, at.Add(time.Second))
	deliver.Cwd, deliver.Text = dir, "合成交付"
	mustIngest(t, c, deliver)

	c.SummaryCmd = []string{"synthetic-llm"}
	c.SummaryRepos = []string{"synthetic"}
	var input string
	c.SummaryRun = func(_ context.Context, _ []string, in string) (string, error) {
		input = in
		return "等待用户验收", nil
	}
	first, err := c.GenerateSummary(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	if !first.Current || !strings.Contains(input, "`"+branch+"`") {
		t.Fatalf("初次摘要应使用当前分支的交接材料，得到 %+v", first)
	}
	snap, err := c.Snapshot(ctx)
	if err != nil || len(snap.WorkItems) != 1 || snap.WorkItems[0].Status != "review" || snap.WorkItems[0].ReviewRevision == "" {
		t.Fatalf("应有一条待处理交付，得到 %+v，错误 %v", snap, err)
	}
	done := "done"
	if err := c.UpdatePanelWorkItem(ctx, item, WorkItemPatch{Status: &done, ExpectedReviewRevision: &snap.WorkItems[0].ReviewRevision}); err != nil {
		t.Fatal(err)
	}
	latest, err := c.LatestSummary(ctx, item)
	if err != nil || latest == nil || latest.Current || latest.Text != "等待用户验收" {
		t.Errorf("用户处理交付后，原摘要应标为过期，得到 %+v，错误 %v", latest, err)
	}
	_, err = c.GenerateSummary(ctx, item)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(input, "工作项当前状态：已处理") {
		t.Error("重新生成摘要时，输入材料缺少工作项当前状态：已处理")
	}
	if !strings.Contains(input, "Agent 的自述") || !strings.Contains(input, "不代表用户已验收") {
		t.Error("重新生成摘要时，交接材料应说明 Agent 自述与用户验收的区别")
	}
}

func TestSummaryWithoutBranchTracksFeatureChanges(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	e := ev("summary-features", event.KindBegin, time.Now())
	e.Cwd = "/repo"
	e.WorkTitle = "synthetic"
	res, err := c.Ingest(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	c.SummaryCmd = []string{"synthetic"}
	c.SummaryRepos = []string{"repo"}
	var input string
	c.SummaryRun = func(_ context.Context, _ []string, s string) (string, error) {
		input = s
		return "synthetic summary", nil
	}
	block := "feature blocked"
	f := ev("summary-features", event.KindFeatures, time.Now().Add(time.Millisecond))
	f.Cwd = "/repo"
	f.Features = &event.FeatureBatch{ScopeStatus: "documented", ScopeBasis: "synthetic spec", Features: []event.FeatureUpdate{{ID: "summary-capability", Title: "feature-context", Candidate: "c1", Implementation: "implementing", Blocker: &block}}}
	if _, err := c.Ingest(ctx, f); err != nil {
		t.Fatal(err)
	}
	if _, err := c.GenerateSummary(ctx, res.WorkItemID); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(input, "feature-context") || !strings.Contains(input, "feature blocked") {
		t.Fatal("branchless summary lost feature context")
	}
	block = "new feature blocker"
	f2 := ev("summary-features", event.KindFeatures, time.Now().Add(2*time.Millisecond))
	f2.Cwd = "/repo"
	f2.Features = &event.FeatureBatch{Features: []event.FeatureUpdate{{ID: "summary-capability", Candidate: "c1", Implementation: "implementing", Blocker: &block}}}
	if _, err := c.Ingest(ctx, f2); err != nil {
		t.Fatal(err)
	}
	s, err := c.LatestSummary(ctx, res.WorkItemID)
	if err != nil || s == nil || s.Current {
		t.Fatalf("changed feature must invalidate summary: %+v %v", s, err)
	}
}

func TestSummaryNameWhitelistRejectsAmbiguousRepos(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	var item string
	for i, path := range []string{"/one/repo", "/two/repo"} {
		e := ev([]string{"white-1", "white-2"}[i], event.KindBegin, time.Now())
		e.Cwd = path
		e.WorkTitle = "synthetic"
		r, err := c.Ingest(ctx, e)
		if err != nil {
			t.Fatal(err)
		}
		item = r.WorkItemID
	}
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO repos(name,common_dir,is_git,created_at) SELECT name,common_dir||'-other',is_git,created_at FROM repos LIMIT 1`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	c.SummaryCmd = []string{"synthetic"}
	c.SummaryRepos = []string{"repo"}
	c.SummaryRun = func(context.Context, []string, string) (string, error) {
		t.Fatal("ambiguous whitelist must never dispatch material")
		return "", nil
	}
	if _, err := c.GenerateSummary(ctx, item); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("ambiguous name: %v", err)
	}
}

func TestSummaryDetectsUpdateDuringGeneration(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	e := ev("during-summary", event.KindBegin, time.Now())
	e.Cwd = "/repo"
	e.WorkTitle = "synthetic"
	e.Brief = map[string]string{"progress": "original basis"}
	r, err := c.Ingest(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	c.SummaryCmd = []string{"synthetic"}
	c.SummaryRepos = []string{"repo"}
	c.SummaryRun = func(context.Context, []string, string) (string, error) {
		p := ev("during-summary", event.KindReport, time.Now().Add(time.Millisecond))
		p.Cwd = "/repo"
		p.Brief = map[string]string{"progress": "changed while model was running"}
		if _, err := c.Ingest(ctx, p); err != nil {
			t.Fatal(err)
		}
		return "summary of old basis", nil
	}
	s, err := c.GenerateSummary(ctx, r.WorkItemID)
	if err != nil {
		t.Fatal(err)
	}
	if s.Current {
		t.Fatal("generation response must not label old material current")
	}
}

func TestSummaryStopsWithService(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	e := ev("stop-summary", event.KindBegin, time.Now())
	e.Cwd = "/repo"
	e.WorkTitle = "synthetic"
	r, err := c.Ingest(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	service, cancel := context.WithCancel(ctx)
	defer cancel()
	c.JobContext = service
	c.SummaryCmd = []string{"synthetic"}
	c.SummaryRepos = []string{"repo"}
	started := make(chan struct{})
	done := make(chan error, 1)
	c.SummaryRun = func(ctx context.Context, _ []string, _ string) (string, error) {
		close(started)
		<-ctx.Done()
		return "", ctx.Err()
	}
	go func() { _, err := c.GenerateSummary(context.Background(), r.WorkItemID); done <- err }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("summary did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled summary succeeded")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("summary survived service shutdown")
	}
	c.CloseJobs()
}
