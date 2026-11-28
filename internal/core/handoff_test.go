package core

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
)

func TestHandoffClaudeToCodex(t *testing.T) {
	for k, v := range map[string]string{"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"} {
		t.Setenv(k, v)
	}
	c, ft, repo := managedCore(t)
	c.Agents["codex"] = AgentSpec{Argv: []string{"codex"}, Provider: "codex", Hooks: true, PromptArg: true}
	ctx := context.Background()
	src, err := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: "claude", Title: "合成交接任务"})
	if err != nil {
		t.Fatal(err)
	}
	// Claude 在自己的 worktree 提交一次，并留下一条未提交改动
	os.WriteFile(filepath.Join(src.Worktree, "done.txt"), []byte("x"), 0o644)
	for _, a := range [][]string{{"add", "done.txt"}, {"commit", "-qm", "synthetic progress"}} {
		if out, err := exec.Command("git", append([]string{"-C", src.Worktree}, a...)...).CombinedOutput(); err != nil {
			t.Fatal(string(out))
		}
	}
	os.WriteFile(filepath.Join(src.Worktree, "wip.txt"), []byte("未提交"), 0o644)
	e := ev("claude-1", event.KindSessionStart, time.Now())
	e.Cwd = src.Worktree
	c.Ingest(ctx, e)
	r := ev("claude-1", event.KindReport, time.Now())
	r.Cwd = src.Worktree
	r.Brief = map[string]string{"progress": "完成第一步 token=supersecret123", "next": "补测试", "next_owner": "codex"}
	if _, err := c.Ingest(ctx, r); err != nil {
		t.Fatal(err)
	}

	if _, _, err := c.StartHandoff(ctx, HandoffInput{WorkItemID: src.WorkItemID, ToAgent: "sh"}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("未配置的 Agent 应拒绝: %v", err)
	}
	in := HandoffInput{WorkItemID: src.WorkItemID, ToAgent: "codex", Note: "注意不要改公开接口"}
	pkg, preview, err := c.BuildHandoff(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	in.SourceSHA, in.PackageSHA = preview.SourceSHA, preview.PackageSHA
	h, m, err := c.StartHandoff(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if h.Package != pkg {
		t.Fatal("发出的交接包必须与确认的预览一致")
	}
	if m.WorkItemID != src.WorkItemID || m.Worktree == src.Worktree || m.Branch == src.Branch || h.FromProvider != "claude" || h.SourceBranch != src.Branch {
		t.Fatalf("h=%+v m=%+v", h, m)
	}
	// 接手 worktree 有上一位的提交，没有未提交改动
	if _, err := os.Stat(filepath.Join(m.Worktree, "done.txt")); err != nil {
		t.Fatal("应包含已提交改动")
	}
	if _, err := os.Stat(filepath.Join(m.Worktree, "wip.txt")); err == nil {
		t.Fatal("不应带入未提交改动")
	}
	for _, want := range []string{"完成第一步", "补测试", "注意不要改公开接口", "synthetic progress", "Agent 自述", src.WorkItemID} {
		if !strings.Contains(h.Package, want) {
			t.Fatalf("交接包缺少 %q:\n%s", want, h.Package)
		}
	}
	if strings.Contains(h.Package, "supersecret123") {
		t.Fatal("交接包应脱敏")
	}
	gd, _ := exec.Command("git", "-C", m.Worktree, "rev-parse", "--absolute-git-dir").Output()
	if b, err := os.ReadFile(filepath.Join(strings.TrimSpace(string(gd)), HandoffFile)); err != nil || string(b) != h.Package {
		t.Fatal("交接包应写入私有 git 目录")
	}
	if st, _ := exec.Command("git", "-C", m.Worktree, "status", "--porcelain").Output(); len(st) != 0 {
		t.Fatalf("交接包不应出现在工作区: %s", st)
	}
	argv := ft.argv[m.TmuxName]
	if len(argv) != 2 || argv[0] != "codex" || !strings.Contains(argv[1], h.Package) {
		t.Fatalf("交接包应作为首条提示传入: %v", argv)
	}
	// 来源会话保持运行，工作项状态不变
	if s, _ := c.managed(ctx, src.ID); s.State != "running" {
		t.Fatal(s.State)
	}
	snap, _ := c.Snapshot(ctx)
	if len(snap.Handoffs) != 1 || snap.Handoffs[0].ManagedID != m.ID {
		t.Fatalf("%+v", snap.Handoffs)
	}
	// 接手 Agent 的 hooks 会话自动关联同一工作项
	e2 := ev("codex-1", event.KindSessionStart, time.Now())
	e2.Source.Provider, e2.Cwd = "codex", m.Worktree
	c.Ingest(ctx, e2)
	snap, _ = c.Snapshot(ctx)
	for _, s := range snap.Sessions {
		if s.ProviderSessionID == "codex-1" && s.WorkItemID != src.WorkItemID {
			t.Fatalf("接手会话应关联 %s, got %q", src.WorkItemID, s.WorkItemID)
		}
	}
}

func TestHandoffRequiresBranch(t *testing.T) {
	c, _, _ := managedCore(t)
	c.CreateWorkItem(context.Background(), WorkItemInput{ID: "HO-1", Title: "无分支"})
	if _, _, err := c.StartHandoff(context.Background(), HandoffInput{WorkItemID: "HO-1", ToAgent: "codex"}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("%v", err)
	}
	if _, _, err := c.StartHandoff(context.Background(), HandoffInput{WorkItemID: "NOPE-1", ToAgent: "codex"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("%v", err)
	}
}

func TestHandoffUsesItemBranchAfterSessionSwitchesWork(t *testing.T) {
	dir := gitInit(t)
	loc := gitx.NewLocator()
	loc.TTL = 0
	c := newCore(t, loc)
	ctx := context.Background()
	at := time.Now()
	var sessionID int64
	for i, item := range []WorkItemInput{
		{ID: "HO-1", Title: "任务甲", Branch: "fix/a", RepoPath: dir},
		{ID: "HO-2", Title: "任务乙", Branch: "fix/b", RepoPath: dir},
	} {
		git(t, dir, "switch", "-q", "-c", item.Branch, "main")
		git(t, dir, "commit", "--allow-empty", "-qm", item.Title)
		if err := c.CreateWorkItem(ctx, item); err != nil {
			t.Fatal(err)
		}
		claim := ev("switching-session", event.KindClaim, at.Add(time.Duration(i)*time.Second))
		claim.Cwd, claim.WorkTag = dir, item.ID
		result, err := c.Ingest(ctx, claim)
		if err != nil {
			t.Fatal(err)
		}
		sessionID = result.SessionID
		var active string
		if err := c.St.R().QueryRow(`SELECT work_item_id FROM runs WHERE session_id=? AND ended_at=''`, sessionID).Scan(&active); err != nil || active != item.ID {
			t.Fatalf("认领 %s 后当前任务是 %q，错误 %v", item.ID, active, err)
		}
	}
	wantSHA, err := gitx.Run(ctx, dir, "rev-parse", "fix/a")
	if err != nil {
		t.Fatal(err)
	}
	for _, from := range []int64{0, sessionID} {
		_, preview, err := c.BuildHandoff(ctx, HandoffInput{WorkItemID: "HO-1", FromSession: from})
		if err != nil {
			t.Fatal(err)
		}
		if preview.SourceBranch != "fix/a" || preview.SourceSHA != wantSHA {
			t.Errorf("来源会话 %d：交接甲得到 %s (%s)，应为 fix/a (%s)", from, preview.SourceBranch, preview.SourceSHA, wantSHA)
		}
		if preview.FromSessionID == nil || *preview.FromSessionID != sessionID {
			t.Errorf("交接未保留实际来源会话 %d", sessionID)
		}
	}
}

func TestHandoffUsesRunBranchAfterSessionEnds(t *testing.T) {
	dir := gitInit(t)
	loc := gitx.NewLocator()
	loc.TTL = 0
	c := newCore(t, loc)
	ctx := context.Background()
	at := time.Now()

	git(t, dir, "switch", "-qc", "fix/a", "main")
	git(t, dir, "commit", "--allow-empty", "-qm", "合成任务甲")
	wantSHA, err := gitx.Run(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "HO-1", Title: "任务甲", RepoPath: dir}); err != nil {
		t.Fatal(err)
	}
	claim := ev("ending-session", event.KindClaim, at)
	claim.Cwd, claim.WorkTag = dir, "HO-1"
	result, err := c.Ingest(ctx, claim)
	if err != nil {
		t.Fatal(err)
	}
	sessionID := result.SessionID
	end := ev("ending-session", event.KindSessionEnd, at.Add(time.Second))
	end.Cwd = ""
	mustIngest(t, c, end)

	check := func(t *testing.T) {
		for _, from := range []int64{0, sessionID} {
			_, preview, err := c.BuildHandoff(ctx, HandoffInput{WorkItemID: "HO-1", FromSession: from})
			if err != nil {
				t.Fatalf("来源会话 %d：自然结束后应能预览交接：%v", from, err)
			}
			if preview.SourceBranch != "fix/a" || preview.SourceSHA != wantSHA {
				t.Errorf("来源会话 %d：交接甲得到 %s (%s)，应为 fix/a (%s)", from, preview.SourceBranch, preview.SourceSHA, wantSHA)
			}
		}
	}
	t.Run("自然结束", check)

	git(t, dir, "switch", "-qc", "fix/b", "main")
	resume := ev("ending-session", event.KindSessionStart, end.OccurredAt)
	resume.Cwd = dir
	mustIngest(t, c, resume)
	var sessionBranch string
	if err := c.St.R().QueryRow(`SELECT branch FROM sessions WHERE id=?`, sessionID).Scan(&sessionBranch); err != nil || sessionBranch != "fix/b" {
		t.Fatalf("恢复后的会话分支是 %q，应为 fix/b，错误 %v", sessionBranch, err)
	}
	t.Run("恢复后会话分支已变化", check)
}

func TestHandoffRejectsChangedPreview(t *testing.T) {
	c, _, repo := managedCore(t)
	ctx := context.Background()
	m, err := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: "claude", Title: "synthetic"})
	if err != nil {
		t.Fatal(err)
	}
	_, preview, err := c.BuildHandoff(ctx, HandoffInput{WorkItemID: m.WorkItemID})
	if err != nil {
		t.Fatal(err)
	}
	git(t, m.Worktree, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-qm", "changed after preview")
	if _, _, err := c.StartHandoff(ctx, HandoffInput{WorkItemID: m.WorkItemID, ToAgent: "codex", SourceSHA: preview.SourceSHA, PackageSHA: preview.PackageSHA}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale preview: %v", err)
	}
}

func TestHandoffRejectsChangedPackageAtSameCommit(t *testing.T) {
	c, term, repo := managedCore(t)
	ctx := context.Background()
	m, err := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: "claude", Title: "synthetic"})
	if err != nil {
		t.Fatal(err)
	}
	editNext := func(next string) {
		t.Helper()
		if _, err := c.EditBrief(ctx, m.WorkItemID, BriefEdit{Field: "next", Action: "set", Text: next}); err != nil {
			t.Fatal(err)
		}
	}
	in := HandoffInput{WorkItemID: m.WorkItemID, ToAgent: "codex"}
	editNext("只检查导入")
	pkg, preview, err := c.BuildHandoff(ctx, in)
	if err != nil || !strings.Contains(pkg, "只检查导入") {
		t.Fatalf("initial preview: %q, %v", pkg, err)
	}
	in.SourceSHA = preview.SourceSHA
	starts := len(term.starts)
	if _, _, err := c.StartHandoff(ctx, in); !errors.Is(err, ErrConflict) || len(term.starts) != starts {
		t.Errorf("missing package fingerprint: want conflict and 0 new starts; got %v and %d new starts", err, len(term.starts)-starts)
	}
	in.PackageSHA = preview.PackageSHA
	editNext("开始修改导出")
	starts = len(term.starts)
	if _, _, err := c.StartHandoff(ctx, in); !errors.Is(err, ErrConflict) || len(term.starts) != starts {
		t.Fatalf("stale package: want conflict and 0 new starts; got %v and %d new starts", err, len(term.starts)-starts)
	}
}

func TestHandoffRejectsMovedItemAtSameCommit(t *testing.T) {
	c, term, repo := managedCore(t)
	ctx := context.Background()
	var common string
	if err := c.St.R().QueryRow(`SELECT common_dir FROM repos WHERE id=?`, repo).Scan(&common); err != nil {
		t.Fatal(err)
	}
	original := filepath.Dir(common)
	const branch = "feat/handoff"
	git(t, original, "checkout", "-qb", branch)
	destination := filepath.Join(t.TempDir(), "clone")
	git(t, original, "clone", "-q", original, destination)
	e := ev("handoff-destination", event.KindSessionStart, c.St.Now())
	e.Cwd = destination
	mustIngest(t, c, e)
	var destID int64
	if err := c.St.R().QueryRow(`SELECT id FROM repos WHERE id<>?`, repo).Scan(&destID); err != nil {
		t.Fatal(err)
	}
	const itemID = "HO-1"
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: itemID, RepoID: repo, Title: "synthetic handoff", Branch: branch}); err != nil {
		t.Fatal(err)
	}
	in := HandoffInput{WorkItemID: itemID, ToAgent: "codex"}
	pkg, preview, err := c.BuildHandoff(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.UpdatePanelWorkItem(ctx, itemID, WorkItemPatch{RepoID: &destID}); err != nil {
		t.Fatal(err)
	}
	movedPkg, movedPreview, err := c.BuildHandoff(ctx, in)
	if err != nil || pkg != movedPkg || preview.SourceSHA != movedPreview.SourceSHA {
		t.Fatalf("move must leave the preview text and commit unchanged: %v", err)
	}
	in.SourceSHA, in.PackageSHA = preview.SourceSHA, preview.PackageSHA
	if _, _, err := c.StartHandoff(ctx, in); !errors.Is(err, ErrConflict) || len(term.starts) != 0 {
		t.Fatalf("preview from another project: want conflict and 0 starts; got %v and %d starts", err, len(term.starts))
	}
}

func TestHandoffKeepsPeerBlockers(t *testing.T) {
	c, _, repo := managedCore(t)
	ctx := context.Background()
	m, err := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: "claude", Title: "synthetic"})
	if err != nil {
		t.Fatal(err)
	}
	for i, sid := range []string{"peer-a", "peer-b"} {
		e := ev(sid, event.KindSessionStart, time.Now())
		e.Cwd = m.Worktree
		c.Ingest(ctx, e)
		r := ev(sid, event.KindReport, time.Now())
		r.Cwd = m.Worktree
		r.Brief = map[string]string{"blocker": []string{"peer-a-blocked", "peer-b-blocked"}[i], "next": "continue separately"}
		if _, err := c.Ingest(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	pkg, _, err := c.BuildHandoff(ctx, HandoffInput{WorkItemID: m.WorkItemID})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pkg, "peer-a-blocked") || !strings.Contains(pkg, "peer-b-blocked") {
		t.Fatal("peer reports were flattened")
	}
}
