package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/xoqiu09/session-steward/internal/gitx"
)

// 项目的 Git 工作目录（worktree）。只有你在本机明确确认后才会删除，而且只删同时满足以下条件的：
// 不是主工作目录、没有锁定、没有未提交或未跟踪的改动、当前提交已包含在目标分支里、
// 没有正在运行的会话或托管会话。删除是移到废纸篓，分支和提交都保留，再执行 git worktree prune。
type Worktree struct {
	Path      string `json:"path"`
	Branch    string `json:"branch,omitempty"`
	Head      string `json:"head"`
	Main      bool   `json:"main"`
	Removable bool   `json:"removable"`
	Reason    string `json:"reason,omitempty"`
}

// TrashPath 把目录移到废纸篓；为 nil 时（测试、演示、非 macOS）不提供删除。
type TrashPath func(ctx context.Context, path string) error

func (c *Core) gitProject(ctx context.Context, repo int64) (common, target string, err error) {
	var isGit bool
	err = c.St.R().QueryRowContext(ctx, `SELECT common_dir, is_git, target_ref FROM repos WHERE id=? AND id NOT IN (SELECT repo_id FROM repo_aliases)`, repo).Scan(&common, &isGit, &target)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", ErrNotFound
	}
	if err != nil {
		return "", "", err
	}
	if !isGit {
		return "", "", fmt.Errorf("%w: 这个项目不是 Git 仓库，没有可管理的工作目录", ErrBadRequest)
	}
	if target == "" {
		target = "main"
	}
	return common, target, nil
}

func (c *Core) ProjectWorktrees(ctx context.Context, repo int64) ([]Worktree, error) {
	common, target, err := c.gitProject(ctx, repo)
	if err != nil {
		return nil, err
	}
	out, err := gitx.Run(ctx, common, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, fmt.Errorf("读取工作目录失败: %w", err)
	}
	var list []Worktree
	locked := map[string]bool{}
	for i, block := range strings.Split(strings.TrimSpace(out), "\n\n") {
		var w Worktree
		for _, line := range strings.Split(block, "\n") {
			key, value, _ := strings.Cut(line, " ")
			switch key {
			case "worktree":
				w.Path = value
			case "HEAD":
				w.Head = value
			case "branch":
				w.Branch = strings.TrimPrefix(value, "refs/heads/")
			case "locked":
				locked[w.Path] = true
			case "prunable":
				w.Reason = "目录已不存在，可用 git worktree prune 清理记录"
			case "bare":
				w.Main = true
			}
		}
		if w.Path == "" {
			continue
		}
		w.Main = w.Main || i == 0
		list = append(list, w)
	}
	for i := range list {
		if list[i].Reason == "" {
			list[i].Removable, list[i].Reason = c.worktreeRemovable(ctx, repo, common, target, list[i], locked[list[i].Path])
		}
	}
	return list, nil
}

func (c *Core) worktreeRemovable(ctx context.Context, repo int64, common, target string, w Worktree, locked bool) (bool, string) {
	switch {
	case w.Main:
		return false, "主工作目录不会删除"
	case locked:
		return false, "工作目录已锁定"
	case c.TrashPath == nil:
		return false, "这台电脑上的服务不提供删除"
	}
	if info, err := os.Stat(w.Path); err != nil || !info.IsDir() {
		return false, "目录不存在"
	}
	if status, err := gitx.Run(ctx, w.Path, "status", "--porcelain", "--untracked-files=all"); err != nil {
		return false, "无法读取改动状态"
	} else if status != "" {
		return false, "有未提交或未跟踪的改动"
	}
	merged := false
	for _, ref := range []string{target, "refs/remotes/origin/" + target} {
		if gitx.RevParse(ctx, common, ref) != "" && gitx.IsAncestor(ctx, common, w.Head, ref) {
			merged = true
			break
		}
	}
	if !merged {
		return false, "当前提交还没有合并进 " + target
	}
	var busy int
	staleBefore := c.St.Now().Add(-c.StaleAfter).UTC().Format("2006-01-02T15:04:05.000000000Z")
	c.St.R().QueryRowContext(ctx, `SELECT
	 (SELECT COUNT(*) FROM sessions WHERE repo_id=? AND worktree=? AND state IN ('running','waiting_permission') AND last_activity_at>=?)
	 + (SELECT COUNT(*) FROM managed_sessions WHERE worktree=? AND state IN ('starting','running'))`,
		repo, w.Path, staleBefore, w.Path).Scan(&busy)
	if busy > 0 {
		return false, "有会话正在这个目录里运行"
	}
	return true, ""
}

// RemoveWorktree 重新核对一遍条件，满足时把工作目录移到废纸篓并清理 Git 的工作目录记录。
func (c *Core) RemoveWorktree(ctx context.Context, repo int64, path string) error {
	if c.TrashPath == nil {
		return fmt.Errorf("%w: 这台电脑上的服务不提供删除工作目录", ErrBadRequest)
	}
	path = filepath.Clean(path)
	list, err := c.ProjectWorktrees(ctx, repo)
	if err != nil {
		return err
	}
	for _, w := range list {
		if filepath.Clean(w.Path) != path {
			continue
		}
		if !w.Removable {
			return fmt.Errorf("%w: 不能删除这个工作目录：%s", ErrConflict, w.Reason)
		}
		common, _, err := c.gitProject(ctx, repo)
		if err != nil {
			return err
		}
		if err := c.TrashPath(ctx, w.Path); err != nil {
			return fmt.Errorf("移到废纸篓失败，目录保持原样: %w", err)
		}
		if _, err := gitx.Run(ctx, common, "worktree", "prune"); err != nil {
			return fmt.Errorf("目录已移到废纸篓，但清理 Git 工作目录记录失败: %w", err)
		}
		c.notify()
		return nil
	}
	return fmt.Errorf("%w: 这个目录不是该项目的工作目录", ErrBadRequest)
}
