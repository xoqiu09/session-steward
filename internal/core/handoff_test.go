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
	h, m, err := c.StartHandoff(ctx, HandoffInput{WorkItemID: src.WorkItemID, ToAgent: "codex", Note: "注意不要改公开接口"})
	if err != nil {
		t.Fatal(err)
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
	if _, _, err := c.StartHandoff(ctx, HandoffInput{WorkItemID: m.WorkItemID, ToAgent: "codex", SourceSHA: preview.SourceSHA}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale preview: %v", err)
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
