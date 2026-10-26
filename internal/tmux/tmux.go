// Package tmux 封装托管会话使用的 tmux 命令。所有会话放在独立 socket（-L steward），
// 不触碰用户自己的 tmux 服务器；目标一律用 "=name:" 精确匹配，避免前缀误中。
package tmux

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// Pane 是一次 list-panes 观察到的状态。
type Pane struct {
	Name     string
	Dead     bool
	ExitCode int
	// HasExitCode 为 false 表示进程已结束但 tmux 没给出退出码（如 Ubuntu 24.04 的 tmux 3.4）。
	HasExitCode bool
}

type Tmux struct {
	Bin    string // tmux 可执行文件
	Socket string // -L 名称
}

// Find 返回可用的 tmux 路径；服务可能由 launchd 启动，PATH 不含 Homebrew。
func Find(configured string) string {
	if configured != "" {
		return configured
	}
	if p, err := exec.LookPath("tmux"); err == nil {
		return p
	}
	for _, p := range []string{"/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

var ErrNoSession = errors.New("tmux 会话不存在")

func (t *Tmux) run(ctx context.Context, args ...string) (string, error) {
	if t.Bin == "" {
		return "", errors.New("未找到 tmux")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	// -u：LANG/LC_ALL 不含 UTF-8 时（launchd、systemd、cron 常见），tmux 客户端会把输出里的
	// 制表符等控制字符替换成 "_"，list-panes 按制表符拆分的结果就全部丢失。
	cmd := exec.CommandContext(ctx, t.Bin, append([]string{"-u", "-L", t.Socket, "-f", "/dev/null"}, args...)...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if strings.Contains(msg, "can't find") || strings.Contains(msg, "no server running") || strings.Contains(msg, "no such") || strings.Contains(msg, "error connecting") {
			return "", ErrNoSession
		}
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(msg)
	}
	return out.String(), nil
}

func target(name string) string { return "=" + name + ":" }

// Start 在 dir 中启动 argv。先放占位进程并打开 remain-on-exit，再替换为实际命令，
// 这样即使 Agent 立即退出也能读到退出码和最后画面。
func (t *Tmux) Start(ctx context.Context, name, dir string, env []string, argv []string) error {
	if len(argv) == 0 {
		return errors.New("命令为空")
	}
	if _, err := t.run(ctx, "new-session", "-d", "-s", name, "-x", "160", "-y", "48", "-c", dir, "--", "sleep", "86400"); err != nil {
		return err
	}
	if _, err := t.run(ctx, "set-option", "-t", target(name), "remain-on-exit", "on"); err != nil {
		t.Kill(ctx, name)
		return err
	}
	t.run(ctx, "set-option", "-t", target(name), "history-limit", "5000")
	args := []string{"respawn-pane", "-k", "-t", target(name), "-c", dir}
	for _, e := range env {
		args = append(args, "-e", e)
	}
	args = append(args, "--")
	args = append(args, argv...)
	if _, err := t.run(ctx, args...); err != nil {
		t.Kill(ctx, name)
		return err
	}
	return nil
}

// List 返回本 socket 上以 prefix 开头的会话及其首个 pane 的状态。
func (t *Tmux) List(ctx context.Context, prefix string) (map[string]Pane, error) {
	out, err := t.run(ctx, "list-panes", "-a", "-F", "#{session_name}\t#{pane_dead}\t#{pane_dead_status}")
	if errors.Is(err, ErrNoSession) {
		return map[string]Pane{}, nil
	}
	if err != nil {
		return nil, err
	}
	return parsePanes(out, prefix), nil
}

// parsePanes 解析 list-panes 输出。只去掉换行，不能 TrimSpace 整段：
// 末尾空的 pane_dead_status 字段会被一并削掉。
func parsePanes(out, prefix string) map[string]Pane {
	m := map[string]Pane{}
	for _, line := range strings.Split(strings.TrimRight(out, "\r\n"), "\n") {
		f := strings.SplitN(strings.TrimRight(line, "\r"), "\t", 3)
		if len(f) < 3 || !strings.HasPrefix(f[0], prefix) {
			continue
		}
		if _, seen := m[f[0]]; seen {
			continue
		}
		p := Pane{Name: f[0], Dead: f[1] == "1"}
		if p.Dead {
			if code, err := strconv.Atoi(strings.TrimSpace(f[2])); err == nil {
				p.ExitCode, p.HasExitCode = code, true
			}
		}
		m[f[0]] = p
	}
	return m
}

// Capture 返回当前画面及最近 lines 行回滚（纯文本，不含控制序列）。
func (t *Tmux) Capture(ctx context.Context, name string, lines int) (string, error) {
	return t.run(ctx, "capture-pane", "-p", "-J", "-t", target(name), "-S", strconv.Itoa(-lines))
}

// SendText 按字面输入文本（不解释为按键名）。
func (t *Tmux) SendText(ctx context.Context, name, text string) error {
	_, err := t.run(ctx, "send-keys", "-t", target(name), "-l", "--", text)
	return err
}

// SendKey 发送一个具名按键，例如 Enter、Escape、C-c。
func (t *Tmux) SendKey(ctx context.Context, name, key string) error {
	_, err := t.run(ctx, "send-keys", "-t", target(name), key)
	return err
}

func (t *Tmux) Kill(ctx context.Context, name string) error {
	_, err := t.run(ctx, "kill-session", "-t", "="+name)
	if errors.Is(err, ErrNoSession) {
		return nil
	}
	return err
}
