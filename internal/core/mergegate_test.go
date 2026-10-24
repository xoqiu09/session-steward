package core

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
)

// gateRepo 建一个合成仓库：main 检出在 dir，feat/GT-1-x 领先一个提交，工作项已待验收并批准合并。
func gateRepo(t *testing.T, checks [][]string) (c *Core, dir, approval string) {
	t.Helper()
	for k, v := range map[string]string{"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"} {
		t.Setenv(k, v)
	}
	dir = t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	commit(t, dir, "a")
	git(t, dir, "checkout", "-qb", "feat/GT-1-x")
	commit(t, dir, "b")
	git(t, dir, "checkout", "-q", "main")
	commit(t, dir, "c") // 目标分支也前进，需要真正的合并提交
	c = newCore(t, gitx.NewLocator())
	ctx := context.Background()
	e := ev("g1", event.KindSessionStart, time.Now())
	e.Cwd = dir
	c.Ingest(ctx, e)
	var repo int64
	var name string
	c.St.R().QueryRow(`SELECT id,name FROM repos`).Scan(&repo, &name)
	c.Checks = map[string][][]string{name: checks}
	c.CreateWorkItem(ctx, WorkItemInput{ID: "GT-1", Title: "合成", RepoID: repo, Branch: "feat/GT-1-x"})
	review := "review"
	c.UpdateWorkItem(ctx, "GT-1", WorkItemPatch{Status: &review})
	c.ScanMerges(ctx)
	snap, _ := c.Snapshot(ctx)
	for _, a := range snap.Approvals {
		if a.Kind == "merge" && a.Status == "pending" {
			var b MergeBinding
			jsonUnmarshal(a.Payload, &b)
			if err := c.ApproveMerge(ctx, a.ID, b.SourceHeadSHA, b.TargetBaseSHA); err != nil {
				t.Fatal(err)
			}
			return c, dir, a.ID
		}
	}
	t.Fatal("没有合并审批")
	return
}

func runGate(t *testing.T, c *Core, approval string) *MergeJob {
	t.Helper()
	j, err := c.StartMergeGate(context.Background(), approval)
	if err != nil {
		t.Fatal(err)
	}
	c.WaitJobs()
	j, _ = c.MergeJob(context.Background(), j.ID)
	return j
}

func TestCheckedMergePassesAndGitConfirms(t *testing.T) {
	c, dir, a := gateRepo(t, [][]string{{"sh", "-c", "test -f b && test -f c && echo ok-from-check"}})
	before := strings.TrimSpace(git(t, dir, "rev-parse", "main"))
	j := runGate(t, c, a)
	if j.State != "merged" || len(j.Checks) != 1 || j.Checks[0].ExitCode != 0 || !strings.Contains(j.Checks[0].Tail, "ok-from-check") {
		t.Fatalf("%+v", j)
	}
	after := strings.TrimSpace(git(t, dir, "rev-parse", "main"))
	if after == before || after != j.MergeSHA {
		t.Fatalf("main 应前进到合并提交: %s -> %s (%s)", before, after, j.MergeSHA)
	}
	if _, err := os.Stat(filepath.Join(dir, "b")); err != nil {
		t.Fatal("检出的 main 工作目录应同步")
	}
	var ms string
	c.St.R().QueryRow(`SELECT merge_state FROM work_items WHERE id='GT-1'`).Scan(&ms)
	if ms != "merged" {
		t.Fatalf("已合并应由 Git 扫描确认: %s", ms)
	}
	if out := git(t, dir, "worktree", "list"); strings.Contains(out, "steward-merge-") {
		t.Fatal("集成 worktree 应清理")
	}
}

func TestCheckedSharedMergeConfirmsAllMembersWithoutAcceptance(t *testing.T) {
	c, _, selected := gateRepo(t, [][]string{{"true"}})
	ctx := context.Background()
	var repo int64
	if err := c.St.R().QueryRow(`SELECT repo_id FROM work_items WHERE id='GT-1'`).Scan(&repo); err != nil {
		t.Fatal(err)
	}
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "GT-2", Title: "共享候选", RepoID: repo, Branch: "feat/GT-1-x"}); err != nil {
		t.Fatal(err)
	}
	review := "review"
	if err := c.UpdateWorkItem(ctx, "GT-2", WorkItemPatch{Status: &review}); err != nil {
		t.Fatal(err)
	}
	if err := c.ScanMerges(ctx); err != nil {
		t.Fatal(err)
	}
	var peer, payload string
	if err := c.St.R().QueryRow(`SELECT id,payload FROM approvals WHERE work_item_id='GT-2' AND status='pending'`).Scan(&peer, &payload); err != nil {
		t.Fatal(err)
	}
	var b MergeBinding
	jsonUnmarshal([]byte(payload), &b)
	if err := c.ApproveMerge(ctx, peer, b.SourceHeadSHA, b.TargetBaseSHA); err != nil {
		t.Fatal(err)
	}
	if j := runGate(t, c, selected); j.State != "merged" {
		t.Fatalf("shared operation did not merge: %+v", j)
	}
	for _, id := range []string{selected, peer} {
		var status, state, itemStatus string
		if err := c.St.R().QueryRow(`SELECT a.status,w.merge_state,w.status FROM approvals a JOIN work_items w ON w.id=a.work_item_id WHERE a.id=?`, id).Scan(&status, &state, &itemStatus); err != nil {
			t.Fatal(err)
		}
		if status != "confirmed" || state != "merged" || itemStatus != "review" {
			t.Fatal("incomplete shared confirmation or automatic acceptance", status, state, itemStatus)
		}
		if err := c.RejectMerge(ctx, id, "withdrawn"); !errors.Is(err, ErrConflict) {
			t.Fatalf("merged operation remained withdrawable: %v", err)
		}
	}
}

func TestCheckedMergeFailingCheckLeavesTargetAlone(t *testing.T) {
	c, dir, a := gateRepo(t, [][]string{{"sh", "-c", "echo first"}, {"sh", "-c", "echo broken token=abc123secret; exit 3"}, {"sh", "-c", "touch never"}})
	before := git(t, dir, "rev-parse", "main")
	j := runGate(t, c, a)
	if j.State != "failed" || len(j.Checks) != 2 || j.Checks[1].ExitCode != 3 {
		t.Fatalf("%+v", j)
	}
	if strings.Contains(j.Checks[1].Tail, "abc123secret") || strings.Contains(strings.Join(j.Checks[1].Argv, " "), "abc123secret") || strings.Contains(j.Error, "abc123secret") {
		t.Fatal("检查输出应脱敏")
	}
	if git(t, dir, "rev-parse", "main") != before {
		t.Fatal("检查失败不能改动目标分支")
	}
	// 失败后可再次运行（新任务）
	if _, err := c.StartMergeGate(context.Background(), a); err != nil {
		t.Fatal(err)
	}
	c.WaitJobs()
}

func TestCheckedMergeRechecksSourceAfterChecks(t *testing.T) {
	c, dir, a := gateRepo(t, [][]string{{"sh", "-c", "git update-ref refs/heads/feat/GT-1-x HEAD"}})
	before := git(t, dir, "rev-parse", "main")
	j := runGate(t, c, a)
	if j.State != "aborted" || git(t, dir, "rev-parse", "main") != before {
		t.Fatalf("branch moved during check must abort: %+v", j)
	}
}

func TestCheckedMergeRejectsCheckModifiedCandidate(t *testing.T) {
	for _, script := range []string{"echo changed > b", "echo changed > b; git commit -qam changed"} {
		t.Run(script, func(t *testing.T) {
			c, dir, a := gateRepo(t, [][]string{{"sh", "-c", script}})
			before := git(t, dir, "rev-parse", "main")
			j := runGate(t, c, a)
			if j.State != "aborted" || git(t, dir, "rev-parse", "main") != before {
				t.Fatalf("mutated candidate must never merge: %+v", j)
			}
		})
	}
}

func TestCheckedMergeRequiresActualCommand(t *testing.T) {
	c, _, a := gateRepo(t, [][]string{{}, {""}})
	if _, err := c.StartMergeGate(context.Background(), a); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("empty commands: %v", err)
	}
}

func TestCheckedMergeStopsWithServiceContext(t *testing.T) {
	c, dir, a := gateRepo(t, [][]string{{"sleep", "60"}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.JobContext = ctx
	before := git(t, dir, "rev-parse", "main")
	j, err := c.StartMergeGate(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		j, _ = c.MergeJob(context.Background(), j.ID)
		if j.State == "running" {
			break
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	done := make(chan struct{})
	go func() { c.WaitJobs(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("service cancellation did not collect job")
	}
	j, _ = c.MergeJob(context.Background(), j.ID)
	if j.State != "aborted" || git(t, dir, "rev-parse", "main") != before {
		t.Fatalf("cancelled job: %+v", j)
	}
}

func TestCheckedMergeAbortsWhenSourceMoved(t *testing.T) {
	c, dir, a := gateRepo(t, [][]string{{"true"}})
	git(t, dir, "checkout", "-q", "feat/GT-1-x")
	commit(t, dir, "late")
	git(t, dir, "checkout", "-q", "main")
	before := git(t, dir, "rev-parse", "main")
	j := runGate(t, c, a)
	if j.State != "aborted" || !strings.Contains(j.Error, "源分支") {
		t.Fatalf("%+v", j)
	}
	if git(t, dir, "rev-parse", "main") != before {
		t.Fatal("中止不能合并")
	}
}

func TestCheckedMergeRefusesDirtyCheckout(t *testing.T) {
	c, dir, a := gateRepo(t, [][]string{{"true"}})
	os.WriteFile(filepath.Join(dir, "a"), []byte("用户未提交的改动"), 0o644)
	before := git(t, dir, "rev-parse", "main")
	j := runGate(t, c, a)
	if j.State != "aborted" || !strings.Contains(j.Error, "未提交改动") {
		t.Fatalf("%+v", j)
	}
	if git(t, dir, "rev-parse", "main") != before {
		t.Fatal("有改动时不能移动检出分支")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a")); string(b) != "用户未提交的改动" {
		t.Fatal("不能覆盖用户改动")
	}
}

func TestCheckedMergeRequiresApprovalAndChecks(t *testing.T) {
	c, _, a := gateRepo(t, nil)
	if _, err := c.StartMergeGate(context.Background(), a); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("未配置检查不能自动合并: %v", err)
	}
	c.Checks = map[string][][]string{"x": {{"true"}}}
	if err := c.RejectMerge(context.Background(), a, "withdrawn"); err != nil {
		t.Fatal(err)
	}
	if _, err := c.StartMergeGate(context.Background(), a); !errors.Is(err, ErrConflict) {
		t.Fatalf("未批准不能运行: %v", err)
	}
}

func TestAutoMergeOnApprovalAndRestartRecovery(t *testing.T) {
	c, dir, _ := gateRepo(t, [][]string{{"true"}})
	_ = dir
	// gateRepo 已批准但 AutoMerge 默认关闭：没有任务
	snap, _ := c.Snapshot(context.Background())
	if len(snap.MergeJobs) != 0 || len(snap.CheckedRepos) != 1 {
		t.Fatalf("jobs=%d checked=%v", len(snap.MergeJobs), snap.CheckedRepos)
	}
	// 重启恢复：未完成的任务记为中止
	now := c.St.NowTS()
	c.St.Tx(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO merge_jobs(id,approval_id,work_item_id,repo_id,source_sha,target_ref,target_sha,state,created_at,updated_at) VALUES('mj_x','a','GT-1',1,'s','main','t','running',?,?)`, now, now)
		return err
	})
	if err := c.RecoverMergeJobs(context.Background()); err != nil {
		t.Fatal(err)
	}
	if j, _ := c.MergeJob(context.Background(), "mj_x"); j.State != "aborted" {
		t.Fatal(j.State)
	}
}

func TestAutoMergeRunsAfterApprove(t *testing.T) {
	for k, v := range map[string]string{"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"} {
		t.Setenv(k, v)
	}
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	commit(t, dir, "a")
	git(t, dir, "checkout", "-qb", "feat/GT-2-x")
	commit(t, dir, "b")
	git(t, dir, "checkout", "-q", "main")
	c := newCore(t, gitx.NewLocator())
	ctx := context.Background()
	e := ev("g2", event.KindSessionStart, time.Now())
	e.Cwd = dir
	c.Ingest(ctx, e)
	var repo int64
	var name string
	c.St.R().QueryRow(`SELECT id,name FROM repos`).Scan(&repo, &name)
	c.Checks, c.AutoMerge = map[string][][]string{name: {{"true"}}}, true
	c.CreateWorkItem(ctx, WorkItemInput{ID: "GT-2", Title: "合成", RepoID: repo, Branch: "feat/GT-2-x"})
	review := "review"
	c.UpdateWorkItem(ctx, "GT-2", WorkItemPatch{Status: &review})
	c.ScanMerges(ctx)
	snap, _ := c.Snapshot(ctx)
	var id string
	var b MergeBinding
	for _, a := range snap.Approvals {
		if a.Kind == "merge" {
			id = a.ID
			jsonUnmarshal(a.Payload, &b)
		}
	}
	if err := c.ApproveMerge(ctx, id, b.SourceHeadSHA, b.TargetBaseSHA); err != nil {
		t.Fatal(err)
	}
	c.WaitJobs()
	snap, _ = c.Snapshot(ctx)
	if len(snap.MergeJobs) != 1 || snap.MergeJobs[0].State != "merged" {
		t.Fatalf("%+v", snap.MergeJobs)
	}
	// 目标已包含源（快进）
	if strings.TrimSpace(git(t, dir, "rev-parse", "main")) != b.SourceHeadSHA {
		t.Fatal("应快进到源提交")
	}
}

func TestCheckedMergeKilledDuringGitMergeIsAborted(t *testing.T) {
	c, dir, a := gateRepo(t, [][]string{{"true"}})
	// 合并提交前的钩子阻塞，模拟服务停止时 git merge 正在运行
	started := filepath.Join(t.TempDir(), "started")
	hook := filepath.Join(dir, ".git", "hooks", "pre-merge-commit")
	// exec 让钩子进程自身就是 sleep，写下 PID 供测试结束时回收
	if err := os.WriteFile(hook, []byte("#!/bin/sh\necho $$ > "+started+"\nexec sleep 60\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if b, err := os.ReadFile(started); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
				if p, err := os.FindProcess(pid); err == nil {
					p.Kill()
				}
			}
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.JobContext = ctx
	before := git(t, dir, "rev-parse", "main")
	j, err := c.StartMergeGate(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		if b, err := os.ReadFile(started); err == nil && len(b) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("git merge did not reach the hook")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	c.WaitJobs()
	j, _ = c.MergeJob(context.Background(), j.ID)
	if j.State != "aborted" || git(t, dir, "rev-parse", "main") != before {
		t.Fatalf("stopped service must abort, not fail: %+v", j)
	}
}

func TestCheckedMergeCancelledRightAfterRunningIsAborted(t *testing.T) {
	c, dir, a := gateRepo(t, [][]string{{"true"}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.JobContext = ctx
	afterMergeJobRunning = cancel
	t.Cleanup(func() { afterMergeJobRunning = nil })
	before := git(t, dir, "rev-parse", "main")
	j, err := c.StartMergeGate(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	c.WaitJobs()
	j, _ = c.MergeJob(context.Background(), j.ID)
	if j.State != "aborted" || git(t, dir, "rev-parse", "main") != before {
		t.Fatalf("job cancelled after running must end aborted: %+v", j)
	}
}
