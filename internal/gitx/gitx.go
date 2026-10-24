// Package gitx 提供只读 Git 查询：定位仓库、worktree、分支和提交关系。
package gitx

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Location struct {
	IsGit     bool
	CommonDir string // 规范化后的 git common dir（同一仓库的多个 worktree 相同）
	Worktree  string // worktree 根目录
	Branch    string
	RepoName  string
}

// Run 执行只读 git 命令。
func Run(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(cmd.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", errors.New(strings.TrimSpace(errb.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// Locate 解析 cwd 所在的仓库与 worktree。不是 Git 目录时 IsGit=false。
func Locate(ctx context.Context, cwd string) Location {
	out, err := Run(ctx, cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel")
	if err != nil {
		abs, _ := filepath.Abs(cwd)
		abs = canon(abs)
		return Location{CommonDir: "dir:" + abs, Worktree: abs, RepoName: filepath.Base(abs)}
	}
	lines := strings.Split(out, "\n")
	if len(lines) < 2 {
		return Location{CommonDir: "dir:" + cwd, Worktree: cwd, RepoName: filepath.Base(cwd)}
	}
	common := canon(lines[0])
	loc := Location{IsGit: true, CommonDir: common, Worktree: canon(lines[1])}
	// Unborn repositories have no HEAD commit but still have a stable Git identity.
	if branch, err := Run(ctx, cwd, "symbolic-ref", "--quiet", "--short", "HEAD"); err == nil {
		loc.Branch = branch
	}
	// 仓库名：common dir 是 .../repo/.git 时取 repo；裸仓库取去掉 .git 后缀的目录名
	if filepath.Base(common) == ".git" {
		loc.RepoName = filepath.Base(filepath.Dir(common))
	} else {
		loc.RepoName = strings.TrimSuffix(filepath.Base(common), ".git")
	}
	return loc
}

func canon(p string) string {
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Clean(p)
}

// Locator 带缓存的 Locate，避免每个事件都启动 git。
type Locator struct {
	mu  sync.Mutex
	m   map[string]cached
	TTL time.Duration
}

type cached struct {
	loc Location
	at  time.Time
}

func NewLocator() *Locator { return &Locator{m: map[string]cached{}, TTL: 20 * time.Second} }

func (l *Locator) Locate(ctx context.Context, cwd string) Location {
	l.mu.Lock()
	c, ok := l.m[cwd]
	l.mu.Unlock()
	if ok && time.Since(c.at) < l.TTL {
		return c.loc
	}
	loc := Locate(ctx, cwd)
	l.mu.Lock()
	l.m[cwd] = cached{loc, time.Now()}
	l.mu.Unlock()
	return loc
}

// RevParse 返回 ref 对应的提交 SHA；不存在时返回空。
func RevParse(ctx context.Context, dir, ref string) string {
	out, err := Run(ctx, dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return ""
	}
	return out
}

// IsAncestor 判断 a 是否是 b 的祖先（即 b 已包含 a）。
func IsAncestor(ctx context.Context, dir, a, b string) bool {
	_, err := Run(ctx, dir, "merge-base", "--is-ancestor", a, b)
	return err == nil
}

// Ahead 返回 src 相对 target 领先的提交数。
func Ahead(ctx context.Context, dir, target, src string) int {
	out, err := Run(ctx, dir, "rev-list", "--count", target+".."+src)
	if err != nil {
		return 0
	}
	n, _ := strconv.Atoi(out)
	return n
}

// DiffStat 返回 target...src 的简要统计。
func DiffStat(ctx context.Context, dir, target, src string) string {
	out, _ := Run(ctx, dir, "diff", "--shortstat", target+"..."+src)
	return out
}

// Branches 列出本地分支及其 HEAD。
func Branches(ctx context.Context, dir string) map[string]string {
	out, err := Run(ctx, dir, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads")
	res := map[string]string{}
	if err != nil {
		return res
	}
	for _, l := range strings.Split(out, "\n") {
		if f := strings.Fields(l); len(f) == 2 {
			res[f[0]] = f[1]
		}
	}
	return res
}

// LastCommitTime 返回 ref 最新提交时间。
func LastCommitTime(ctx context.Context, dir, ref string) time.Time {
	out, err := Run(ctx, dir, "log", "-1", "--format=%cI", ref)
	if err != nil {
		return time.Time{}
	}
	t, _ := time.Parse(time.RFC3339, out)
	return t
}
