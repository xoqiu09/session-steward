package core

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/store"
)

type fakeLoc struct{ loc gitx.Location }

func (f fakeLoc) Locate(context.Context, string) gitx.Location { return f.loc }

var idSeq atomic.Int64

func newCore(t *testing.T, loc Locator) *Core {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "t.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	if loc == nil {
		loc = fakeLoc{gitx.Location{IsGit: true, CommonDir: "/repo/.git", Worktree: "/repo", Branch: "main", RepoName: "repo"}}
	}
	return New(st, loc)
}

func ev(sid string, k event.Kind, at time.Time) *event.Event {
	return &event.Event{
		EventID: fmt.Sprintf("e%d", idSeq.Add(1)), SchemaVersion: 1, OccurredAt: at,
		Source: event.Source{Provider: "claude", HostID: "h", Client: "cli"}, Kind: k, SessionID: sid, Cwd: "/repo",
	}
}

func sessionState(t *testing.T, c *Core, sid string) (state string, src string) {
	t.Helper()
	err := c.St.R().QueryRow(`SELECT state, data_source FROM sessions WHERE provider_session_id=?`, sid).Scan(&state, &src)
	if err != nil {
		t.Fatal(err)
	}
	return
}

func TestDedupAndOutOfOrder(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	t0 := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	stop := ev("s1", event.KindStop, t0.Add(2*time.Second))
	if _, err := c.Ingest(ctx, stop); err != nil {
		t.Fatal(err)
	}
	// 重复投递
	r, err := c.Ingest(ctx, stop)
	if err != nil || !r.Duplicate {
		t.Fatalf("应识别为重复: %v %v", r, err)
	}
	// 更早的事件晚到，不能把状态回退为 running
	if _, err := c.Ingest(ctx, ev("s1", event.KindToolPre, t0.Add(1*time.Second))); err != nil {
		t.Fatal(err)
	}
	if st, _ := sessionState(t, c, "s1"); st != "idle" {
		t.Fatalf("乱序事件覆盖了较新状态: %s", st)
	}
	var n int
	c.St.R().QueryRow(`SELECT COUNT(1) FROM events`).Scan(&n)
	if n != 2 {
		t.Fatalf("事件数应为 2，实际 %d", n)
	}
}

func TestStateMapping(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	t0 := time.Now().UTC()
	cases := []struct {
		k    event.Kind
		want string
	}{
		{event.KindPrompt, "running"},
		{event.KindNotifyIdle, "idle"},
		{event.KindInterrupt, "interrupted"},
		{event.KindStopFailure, "error"},
		{event.KindSessionEnd, "ended"},
	}
	for i, cs := range cases {
		c.Ingest(ctx, ev("s2", cs.k, t0.Add(time.Duration(i)*time.Second)))
		if st, _ := sessionState(t, c, "s2"); st != cs.want {
			t.Fatalf("%s → %s，期望 %s", cs.k, st, cs.want)
		}
	}
	// idle_prompt 不进入决策队列
	var n int
	c.St.R().QueryRow(`SELECT COUNT(1) FROM approvals WHERE kind='decision'`).Scan(&n)
	if n != 0 {
		t.Fatal("idle_prompt 不应生成决策")
	}
}

func TestStopDoesNotCompleteWorkItem(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	c.CreateWorkItem(ctx, WorkItemInput{ID: "QM-1", Title: "x"})
	p := ev("s3", event.KindPrompt, time.Now())
	p.WorkTag = "QM-1"
	c.Ingest(ctx, p)
	c.Ingest(ctx, ev("s3", event.KindStop, time.Now().Add(time.Second)))
	c.Ingest(ctx, ev("s3", event.KindSessionEnd, time.Now().Add(2*time.Second)))
	var st string
	c.St.R().QueryRow(`SELECT status FROM work_items WHERE id='QM-1'`).Scan(&st)
	if st != "in_progress" {
		t.Fatalf("会话结束不应改变工作项为完成，实际 %s", st)
	}
	var outcome, ended string
	c.St.R().QueryRow(`SELECT outcome, ended_at FROM runs WHERE work_item_id='QM-1'`).Scan(&outcome, &ended)
	if ended == "" || outcome != "" {
		t.Fatalf("run 应结束且结果待定: ended=%q outcome=%q", ended, outcome)
	}
}

func TestAttributionPriority(t *testing.T) {
	c := newCore(t, fakeLoc{gitx.Location{IsGit: true, CommonDir: "/r/.git", Worktree: "/r", Branch: "feat/QM-2-thing", RepoName: "r"}})
	ctx := context.Background()
	c.CreateWorkItem(ctx, WorkItemInput{ID: "QM-1", Title: "a"})
	c.CreateWorkItem(ctx, WorkItemInput{ID: "QM-2", Title: "b"})
	c.CreateWorkItem(ctx, WorkItemInput{ID: "QM-3", Title: "c"})
	now := time.Now()
	r, _ := c.Ingest(ctx, ev("s4", event.KindSessionStart, now))
	// 分支推断只给建议
	var sugg string
	c.St.R().QueryRow(`SELECT suggested_work_item FROM sessions WHERE id=?`, r.SessionID).Scan(&sugg)
	if sugg != "QM-2" {
		t.Fatalf("应建议 QM-2，实际 %q", sugg)
	}
	var runs int
	c.St.R().QueryRow(`SELECT COUNT(1) FROM runs`).Scan(&runs)
	if runs != 0 {
		t.Fatal("分支推断不应直接绑定")
	}
	// 人工绑定 QM-1
	if err := c.BindManual(ctx, r.SessionID, "QM-1"); err != nil {
		t.Fatal(err)
	}
	// prompt 标签不能覆盖人工绑定
	p := ev("s4", event.KindPrompt, now.Add(time.Second))
	p.WorkTag = "QM-3"
	c.Ingest(ctx, p)
	var item string
	c.St.R().QueryRow(`SELECT work_item_id FROM runs WHERE ended_at=''`).Scan(&item)
	if item != "QM-1" {
		t.Fatalf("低优先级绑定覆盖了人工绑定: %s", item)
	}
	// 人工切换任务：旧 run 结束为转交，新 run 开始
	c.BindManual(ctx, r.SessionID, "QM-3")
	var oldOutcome string
	c.St.R().QueryRow(`SELECT outcome FROM runs WHERE work_item_id='QM-1'`).Scan(&oldOutcome)
	if oldOutcome != "handed_off" {
		t.Fatalf("旧 run 应标记转交: %s", oldOutcome)
	}
}

func TestDepsCycleAndConditions(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	for _, id := range []string{"A-1", "A-2", "A-3"} {
		c.CreateWorkItem(ctx, WorkItemInput{ID: id, Title: id})
	}
	if err := c.AddDep(ctx, "A-1", "A-2", "accepted"); err != nil {
		t.Fatal(err)
	}
	if err := c.AddDep(ctx, "A-2", "A-3", "merged"); err != nil {
		t.Fatal(err)
	}
	if err := c.AddDep(ctx, "A-3", "A-1", ""); !errors.Is(err, ErrCycle) {
		t.Fatalf("应拒绝环: %v", err)
	}
	snap, _ := c.Snapshot(ctx)
	ready := map[string]bool{}
	for _, w := range snap.WorkItems {
		ready[w.ID] = w.Ready
	}
	if !ready["A-1"] || ready["A-2"] || ready["A-3"] {
		t.Fatalf("就绪计算错误: %v", ready)
	}
	done := "done"
	c.UpdateWorkItem(ctx, "A-2", WorkItemPatch{Status: &done})
	snap, _ = c.Snapshot(ctx)
	for _, w := range snap.WorkItems {
		if w.ID == "A-3" && w.Ready {
			t.Fatal("merged 条件下，已完成但未合并的上游不满足")
		}
	}
	if DepSatisfied("accepted", "abandoned", "none") {
		t.Fatal("已放弃的上游不应满足依赖")
	}
}

func permEvent(sid string) *event.Event {
	e := ev(sid, event.KindPermission, time.Now())
	e.ToolName = "Bash"
	e.Fingerprint = "fp-" + sid
	e.Preview = "Bash: rm -rf build"
	return e
}

func waitPending(t *testing.T, c *Core) (id, fp string) {
	t.Helper()
	for i := 0; i < 200; i++ {
		err := c.St.R().QueryRow(`SELECT id, fingerprint FROM approvals WHERE kind='permission' AND status='pending' AND handleable=1`).Scan(&id, &fp)
		if err == nil {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("没有出现待处理的权限请求")
	return
}

func TestPermissionLifecycle(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	type res struct {
		id string
		d  Decision
		ok bool
	}
	ch := make(chan res, 1)
	go func() {
		id, d, ok, _ := c.RequestPermission(ctx, permEvent("p1"), 5*time.Second)
		ch <- res{id, d, ok}
	}()
	id, fp := waitPending(t, c)
	if err := c.Decide(ctx, id, "wrong", Decision{Behavior: "allow"}); !errors.Is(err, ErrMismatch) {
		t.Fatalf("指纹不符应拒绝: %v", err)
	}
	if err := c.Decide(ctx, id, fp, Decision{Behavior: "allow"}); err != nil {
		t.Fatal(err)
	}
	r := <-ch
	if !r.ok || r.d.Behavior != "allow" {
		t.Fatalf("应收到 allow: %+v", r)
	}
	// 重复决定无效
	if err := c.Decide(ctx, id, fp, Decision{Behavior: "deny"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("重复决定应冲突: %v", err)
	}
	c.AckDelivered(ctx, id)
	post := ev("p1", event.KindToolPost, time.Now().Add(time.Second))
	post.ToolName = "Bash"
	post.Fingerprint = fp
	c.Ingest(ctx, post)
	var st string
	c.St.R().QueryRow(`SELECT status FROM approvals WHERE id=?`, id).Scan(&st)
	if st != "confirmed" {
		t.Fatalf("应为 confirmed，实际 %s", st)
	}
}

func TestPermissionTimeoutAndLateDecision(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	_, _, ok, err := c.RequestPermission(ctx, permEvent("p2"), 50*time.Millisecond)
	if err != nil || ok {
		t.Fatalf("超时应不作决定: ok=%v err=%v", ok, err)
	}
	var id, fp, st string
	c.St.R().QueryRow(`SELECT id, fingerprint, status FROM approvals WHERE kind='permission'`).Scan(&id, &fp, &st)
	if st != "expired" {
		t.Fatalf("应为 expired: %s", st)
	}
	// 迟到的批准不生效
	if err := c.Decide(ctx, id, fp, Decision{Behavior: "allow"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("迟到决定应被拒绝: %v", err)
	}
	// 下一次相似请求（同指纹）是新审批，不继承旧决定
	done := make(chan bool, 1)
	go func() {
		_, _, ok, _ := c.RequestPermission(ctx, permEvent("p2"), 80*time.Millisecond)
		done <- ok
	}()
	if <-done {
		t.Fatal("新请求不应自动得到旧决定")
	}
}

func TestPermissionCancelledBySessionInterrupt(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	done := make(chan bool, 1)
	go func() {
		_, _, ok, _ := c.RequestPermission(ctx, permEvent("p3"), 5*time.Second)
		done <- ok
	}()
	id, fp := waitPending(t, c)
	c.Ingest(ctx, ev("p3", event.KindInterrupt, time.Now().Add(time.Second)))
	select {
	case ok := <-done:
		if ok {
			t.Fatal("中断后不应返回决定")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("中断后适配器应被唤醒")
	}
	if err := c.Decide(ctx, id, fp, Decision{Behavior: "allow"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("已取消的请求不应接受决定: %v", err)
	}
}

func TestPermissionRestartExpires(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	// 模拟上一个进程留下的待处理请求
	c.St.Tx(ctx, func(tx *sqlTx) error {
		return insertApproval(tx, approvalRow{kind: "permission", handleable: true, fp: "x"}, c.St.NowTS())
	})
	c.Startup(ctx)
	var st, reason string
	c.St.R().QueryRow(`SELECT status, close_reason FROM approvals`).Scan(&st, &reason)
	if st != "expired" || reason != "server_restart" {
		t.Fatalf("重启后应失效: %s %s", st, reason)
	}
}

func TestAttentionDedupAndClose(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	now := time.Now()
	for i := 0; i < 3; i++ {
		s := ev("q1", event.KindStop, now.Add(time.Duration(i)*time.Second))
		s.EndsWithAsk = true
		s.Text = "要继续吗？"
		c.Ingest(ctx, s)
	}
	var n int
	c.St.R().QueryRow(`SELECT COUNT(1) FROM approvals WHERE kind='attention' AND status='pending'`).Scan(&n)
	if n != 1 {
		t.Fatalf("重复提醒应合并为 1 条，实际 %d", n)
	}
	c.Ingest(ctx, ev("q1", event.KindPrompt, now.Add(10*time.Second)))
	c.St.R().QueryRow(`SELECT COUNT(1) FROM approvals WHERE kind='attention' AND status='pending'`).Scan(&n)
	if n != 0 {
		t.Fatal("用户回复后提醒应关闭")
	}
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return string(out)
}

func commit(t *testing.T, dir, file string) {
	os.WriteFile(filepath.Join(dir, file), []byte(file+time.Now().String()), 0o644)
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-qm", file)
}

func TestMergeBindingAndVerification(t *testing.T) {
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	commit(t, dir, "a")
	git(t, dir, "checkout", "-qb", "feat/QM-9-x")
	commit(t, dir, "b")
	git(t, dir, "checkout", "-q", "main")

	c := newCore(t, gitx.NewLocator())
	ctx := context.Background()
	e := ev("m1", event.KindSessionStart, time.Now())
	e.Cwd = dir
	c.Ingest(ctx, e)
	var repoID int64
	c.St.R().QueryRow(`SELECT id FROM repos`).Scan(&repoID)
	c.CreateWorkItem(ctx, WorkItemInput{ID: "QM-9", Title: "x", RepoID: repoID, Branch: "feat/QM-9-x"})

	// 未进入待验收：不生成合并审批
	c.ScanMerges(ctx)
	var n int
	c.St.R().QueryRow(`SELECT COUNT(1) FROM approvals WHERE kind='merge'`).Scan(&n)
	if n != 0 {
		t.Fatal("执行中的工作项不应进入合并队列")
	}
	review := "review"
	c.UpdateWorkItem(ctx, "QM-9", WorkItemPatch{Status: &review})
	c.ScanMerges(ctx)
	snap, _ := c.Snapshot(ctx)
	var a *Approval
	for i := range snap.Approvals {
		if snap.Approvals[i].Kind == "merge" && snap.Approvals[i].Status == "pending" {
			a = &snap.Approvals[i]
		}
	}
	if a == nil {
		t.Fatal("应生成合并审批")
	}
	var b MergeBinding
	jsonUnmarshal(a.Payload, &b)
	if b.SourceHeadSHA == "" || b.TargetBaseSHA == "" || b.Ahead != 1 {
		t.Fatalf("绑定信息不完整: %+v", b)
	}
	// 用旧 SHA 批准被拒绝
	if err := c.ApproveMerge(ctx, a.ID, "deadbeef", b.TargetBaseSHA); !errors.Is(err, ErrMismatch) {
		t.Fatalf("SHA 不一致应拒绝: %v", err)
	}
	if err := c.ApproveMerge(ctx, a.ID, b.SourceHeadSHA, b.TargetBaseSHA); err != nil {
		t.Fatal(err)
	}
	// 批准后源分支新增提交 → 旧批准作废，生成新的待审批
	git(t, dir, "checkout", "-q", "feat/QM-9-x")
	commit(t, dir, "c")
	git(t, dir, "checkout", "-q", "main")
	c.ScanMerges(ctx)
	var st, reason string
	c.St.R().QueryRow(`SELECT status, close_reason FROM approvals WHERE id=?`, a.ID).Scan(&st, &reason)
	if st != "expired" || reason != "source_moved" {
		t.Fatalf("源分支移动后旧批准应作废: %s %s", st, reason)
	}
	var ms0 string
	c.St.R().QueryRow(`SELECT merge_state FROM work_items WHERE id='QM-9'`).Scan(&ms0)
	if ms0 != "awaiting" {
		t.Fatalf("旧批准作废后应回到待合并审批，实际 %s", ms0)
	}
	// 目标分支前进 → 标记需重建候选
	commit(t, dir, "d")
	c.ScanMerges(ctx)
	snap, _ = c.Snapshot(ctx)
	for _, ap := range snap.Approvals {
		if ap.Kind == "merge" && ap.Status == "pending" {
			var nb MergeBinding
			jsonUnmarshal(ap.Payload, &nb)
			if nb.Stale != "target_moved" {
				t.Fatalf("目标前进应标记 target_moved: %+v", nb)
			}
			if err := c.ApproveMerge(ctx, ap.ID, nb.SourceHeadSHA, nb.TargetBaseSHA); !errors.Is(err, ErrConflict) {
				t.Fatalf("需重建候选时不应允许批准: %v", err)
			}
		}
	}
	// 实际合并后，由 Git 验证为已合并
	git(t, dir, "merge", "-q", "--no-edit", "feat/QM-9-x")
	c.ScanMerges(ctx)
	var ms string
	c.St.R().QueryRow(`SELECT merge_state FROM work_items WHERE id='QM-9'`).Scan(&ms)
	if ms != "merged" {
		t.Fatalf("合并后应为 merged: %s", ms)
	}
}

func TestWorktreeConflict(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	now := time.Now()
	c.Ingest(ctx, ev("w1", event.KindPrompt, now))
	e := ev("w2", event.KindPrompt, now)
	e.Source.Provider = "codex"
	c.Ingest(ctx, e)
	snap, _ := c.Snapshot(ctx)
	for _, s := range snap.Sessions {
		if !s.WorktreeConflict {
			t.Fatalf("同一 worktree 两个活跃会话应提示冲突: %+v", s)
		}
	}
}

func TestWorktreeConflictOnlyIncludesFreshActiveSessions(t *testing.T) {
	for _, observers := range []bool{true, false} {
		t.Run(fmt.Sprintf("observers_only_%t", observers), func(t *testing.T) {
			c := newCore(t, nil)
			ctx := context.Background()
			now := time.Now()
			cases := []struct {
				sid  string
				kind event.Kind
				at   time.Time
			}{
				{"idle", event.KindStop, now},
				{"interrupted", event.KindInterrupt, now},
				{"error", event.KindStopFailure, now},
				{"ended", event.KindSessionEnd, now},
				{"stale", event.KindPrompt, now.Add(-time.Hour)},
				{"active", event.KindPrompt, now},
			}
			if !observers {
				cases = append(cases, struct {
					sid  string
					kind event.Kind
					at   time.Time
				}{"waiting", event.KindNotifyPerm, now})
			}
			for _, tc := range cases {
				if _, err := c.Ingest(ctx, ev(tc.sid, tc.kind, tc.at)); err != nil {
					t.Fatal(err)
				}
			}
			snap, err := c.Snapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			for _, s := range snap.Sessions {
				want := !observers && (s.ProviderSessionID == "active" || s.ProviderSessionID == "waiting")
				if s.WorktreeConflict != want {
					t.Fatalf("%s state=%s freshness=%s conflict=%t want=%t", s.ProviderSessionID, s.State, s.Freshness, s.WorktreeConflict, want)
				}
			}
		})
	}
}

func TestStaleFreshness(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	c.Ingest(ctx, ev("z1", event.KindPrompt, time.Now().Add(-time.Hour)))
	snap, _ := c.Snapshot(ctx)
	if snap.Sessions[0].Freshness != "stale" || snap.Sessions[0].State != "running" {
		t.Fatalf("长时间无事件应显示 stale，状态保持: %+v", snap.Sessions[0])
	}
	c.Ingest(ctx, ev("z1", event.KindToolPre, time.Now()))
	snap, _ = c.Snapshot(ctx)
	if snap.Sessions[0].Freshness != "live" {
		t.Fatal("收到新事件后应恢复 live")
	}
}

// 迟到的旧事件（Stop、Interrupt）不能取消之后才创建的权限请求；Stop 本身不是失效条件。
func TestLateEventDoesNotCancelNewerPermission(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	done := make(chan bool, 1)
	go func() {
		_, _, ok, _ := c.RequestPermission(ctx, permEvent("p9"), 300*time.Millisecond)
		done <- ok
	}()
	waitPending(t, c)
	c.Ingest(ctx, ev("p9", event.KindStop, time.Now()))
	c.Ingest(ctx, ev("p9", event.KindInterrupt, time.Now().Add(-time.Minute)))
	var st string
	c.St.R().QueryRow(`SELECT status FROM approvals WHERE kind='permission'`).Scan(&st)
	if st != "pending" {
		t.Fatalf("迟到的 Stop/Interrupt 不应取消更新的请求，实际 %s", st)
	}
	<-done
}

// 在 Agent 原生界面批准后（工具已执行），面板上的待处理请求应失效，适配器被唤醒且不输出决定。
func TestNativeApprovalClosesPanelRequest(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	done := make(chan bool, 1)
	go func() {
		_, _, ok, _ := c.RequestPermission(ctx, permEvent("n1"), 5*time.Second)
		done <- ok
	}()
	id, fp := waitPending(t, c)
	post := ev("n1", event.KindToolPost, time.Now().Add(time.Second))
	post.ToolName = "Bash"
	post.Fingerprint = fp
	c.Ingest(ctx, post)
	select {
	case ok := <-done:
		if ok {
			t.Fatal("原生批准后适配器不应收到面板决定")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("适配器应被唤醒")
	}
	var st, reason string
	c.St.R().QueryRow(`SELECT status, close_reason FROM approvals WHERE id=?`, id).Scan(&st, &reason)
	if st != "cancelled" || reason != "resolved_elsewhere" {
		t.Fatalf("应关闭为 resolved_elsewhere: %s %s", st, reason)
	}
	if err := c.Decide(ctx, id, fp, Decision{Behavior: "allow"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("失效后不应接受决定: %v", err)
	}
}
