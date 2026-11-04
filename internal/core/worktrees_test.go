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

type gitLocator struct{}

func (gitLocator) Locate(ctx context.Context, cwd string) gitx.Location { return gitx.Locate(ctx, cwd) }

func TestWorktreeRemovalOnlyForMergedCleanIdleWorktrees(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	ctx := context.Background()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	main := filepath.Join(root, "synthetic-main")
	git := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false"}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_NOSYSTEM=1")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	os.MkdirAll(main, 0o755)
	git(main, "init", "-q", "-b", "main")
	os.WriteFile(filepath.Join(main, "README.md"), []byte("synthetic\n"), 0o644)
	git(main, "add", ".")
	git(main, "commit", "-q", "-m", "init")
	wt := func(name string) string {
		p := filepath.Join(root, name)
		git(main, "worktree", "add", "-q", "-b", name, p)
		return p
	}
	merged, unmerged, dirty, busy := wt("merged"), wt("unmerged"), wt("dirty"), wt("busy")
	os.WriteFile(filepath.Join(unmerged, "new.txt"), []byte("x\n"), 0o644)
	git(unmerged, "add", ".")
	git(unmerged, "commit", "-q", "-m", "unmerged work")
	os.WriteFile(filepath.Join(dirty, "scratch.txt"), []byte("x\n"), 0o644)

	c := newCore(t, gitLocator{})
	trash := filepath.Join(root, "trash")
	os.MkdirAll(trash, 0o755)
	c.TrashPath = func(_ context.Context, p string) error { return os.Rename(p, filepath.Join(trash, filepath.Base(p))) }
	start := ev("synthetic-busy", event.KindSessionStart, time.Now().UTC())
	start.Cwd = busy
	if _, err := c.Ingest(ctx, start); err != nil {
		t.Fatal(err)
	}
	var repo int64
	if err := c.St.R().QueryRow(`SELECT repo_id FROM sessions WHERE provider_session_id='synthetic-busy'`).Scan(&repo); err != nil {
		t.Fatal(err)
	}
	list, err := c.ProjectWorktrees(ctx, repo)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Worktree{}
	for _, w := range list {
		got[filepath.Base(w.Path)] = w
	}
	want := map[string]string{"synthetic-main": "主工作目录", "unmerged": "还没有合并", "dirty": "未提交", "busy": "正在"}
	for name, reason := range want {
		if w := got[name]; w.Removable || !strings.Contains(w.Reason, reason) {
			t.Fatalf("%s should be kept (%s): %+v", name, reason, w)
		}
	}
	if !got["merged"].Removable {
		t.Fatalf("merged clean idle worktree should be removable: %+v", got["merged"])
	}
	if err := c.RemoveWorktree(ctx, repo, unmerged); !errors.Is(err, ErrConflict) {
		t.Fatal("unmerged worktree removed", err)
	}
	if err := c.RemoveWorktree(ctx, repo, main); !errors.Is(err, ErrConflict) {
		t.Fatal("main worktree removed", err)
	}
	if err := c.RemoveWorktree(ctx, repo, filepath.Join(root, "elsewhere")); !errors.Is(err, ErrBadRequest) {
		t.Fatal("unrelated path accepted", err)
	}
	if err := c.RemoveWorktree(ctx, repo, merged); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(trash, "merged", "README.md")); err != nil {
		t.Fatal("worktree not moved to trash", err)
	}
	after, _ := c.ProjectWorktrees(ctx, repo)
	for _, w := range after {
		if filepath.Base(w.Path) == "merged" {
			t.Fatal("git still lists the removed worktree")
		}
	}
	for _, p := range []string{unmerged, dirty, busy, main} {
		if _, err := os.Stat(p); err != nil {
			t.Fatal("kept worktree was touched", p)
		}
	}
	c.TrashPath = nil
	if err := c.RemoveWorktree(ctx, repo, dirty); !errors.Is(err, ErrBadRequest) {
		t.Fatal("removal allowed without a trash", err)
	}
}
