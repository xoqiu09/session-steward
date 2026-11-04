package core

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// macOS 会按程序签名决定能不能读外置盘、“文稿”“桌面”“下载”等受保护位置。每次换了签名，
// 后台服务第一次读取时系统会等你授权，而 launchd 启动的服务弹不出可见的提示，读取就一直卡住，
// 表现为 Git 核对超时、工作目录读不出来。这里定期试着打开项目所在的这些位置，卡住时在面板上说明原因。

// AccessIssue 是一个读取时卡住的位置。
type AccessIssue struct {
	Path  string `json:"path"`
	Since string `json:"since"`
}

// AccessProbeTimeout 内没有打开就视为卡住。
var AccessProbeTimeout = 3 * time.Second

type accessProbe struct {
	mu       sync.Mutex
	stuck    map[string]time.Time
	inflight map[string]bool
	open     func(path string) error // 测试替换
}

func defaultOpen(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	f.Readdirnames(1) // 空目录返回 EOF，也算能读
	return nil
}

// protectedRoot 返回需要单独授权的顶层位置；其他位置返回空。
func protectedRoot(path, home string) string {
	path = filepath.Clean(strings.TrimPrefix(strings.TrimSuffix(path, "/.git"), "dir:"))
	if rest, ok := strings.CutPrefix(path, "/Volumes/"); ok {
		name, _, _ := strings.Cut(rest, "/")
		if name != "" {
			return "/Volumes/" + name
		}
	}
	if home != "" {
		for _, dir := range []string{"Documents", "Desktop", "Downloads", "Library/Mobile Documents"} {
			root := filepath.Join(home, dir)
			if path == root || strings.HasPrefix(path, root+"/") {
				return root
			}
		}
	}
	return ""
}

// ProbeAccess 试着打开使用中项目所在的受保护位置；已经在等的位置不会重复去试。
func (c *Core) ProbeAccess(ctx context.Context) error {
	rows, err := c.St.R().QueryContext(ctx, `SELECT common_dir FROM repos WHERE id NOT IN (SELECT repo_id FROM repo_aliases)
	 AND NOT EXISTS (SELECT 1 FROM meta WHERE (k='repo_archive:'||repos.id OR k='repo_trash:'||repos.id) AND v<>'')`)
	if err != nil {
		return err
	}
	home, _ := os.UserHomeDir()
	roots := map[string]bool{}
	for rows.Next() {
		var dir string
		if rows.Scan(&dir) == nil {
			if r := protectedRoot(dir, home); r != "" {
				roots[r] = true
			}
		}
	}
	rows.Close()
	p := &c.access
	p.mu.Lock()
	if p.stuck == nil {
		p.stuck, p.inflight = map[string]time.Time{}, map[string]bool{}
	}
	open := p.open
	if open == nil {
		open = defaultOpen
	}
	p.mu.Unlock()
	for root := range roots {
		p.mu.Lock()
		busy := p.inflight[root]
		if !busy {
			p.inflight[root] = true
		}
		p.mu.Unlock()
		if busy {
			continue
		}
		done := make(chan struct{})
		go func(root string) {
			open(root) // 卡住时这里会一直等到你在系统里授权
			close(done)
			p.mu.Lock()
			delete(p.inflight, root)
			delete(p.stuck, root)
			p.mu.Unlock()
			c.notify()
		}(root)
		select {
		case <-done:
		case <-time.After(AccessProbeTimeout):
			p.mu.Lock()
			if _, ok := p.stuck[root]; !ok {
				p.stuck[root] = c.St.Now()
			}
			p.mu.Unlock()
			c.notify()
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

// AccessIssues 返回当前仍卡住的位置。
func (c *Core) AccessIssues() []AccessIssue {
	p := &c.access
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]AccessIssue, 0, len(p.stuck))
	for path, since := range p.stuck {
		out = append(out, AccessIssue{Path: path, Since: since.UTC().Format(time.RFC3339)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}
