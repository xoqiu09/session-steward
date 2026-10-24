// Package notify 实现“需要你”推送渠道：macOS 通知（osascript）与可选 ntfy webhook。
package notify

import (
	"context"
	"errors"
	"mime"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
)

// MacOS 默认使用带 Steward 图标的通知助手，点击只打开该条通知的本机深链。
// 没有安装助手时退回普通系统横幅；Dialog 是显式启用的旧兼容模式。
type MacOS struct {
	Dialog   bool
	AppPath  string
	SpoolDir string
	Run      func(ctx context.Context, name string, args ...string) ([]byte, error)
}

func asString(s string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", " ").Replace(s) + `"`
}

func (m *MacOS) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	if m.Run != nil {
		return m.Run(ctx, name, args...)
	}
	return exec.CommandContext(ctx, name, args...).Output()
}

// Script 返回发送通知的 AppleScript；文本经过转义，不能注入脚本。
func (m *MacOS) Script(a core.Alert) string {
	if !m.Dialog {
		return "display notification " + asString(a.Body) + " with title " + asString("Session Steward") + " subtitle " + asString(a.Title) + " sound name \"Glass\""
	}
	return "display notification " + asString(a.Body) + " with title " + asString("Session Steward") + " subtitle " + asString(a.Title) + " sound name \"Glass\"\n" +
		"set r to display dialog " + asString(a.Title+"\n"+a.Body) + " with title " + asString("Session Steward") + " buttons {\"稍后\", \"打开面板\"} default button \"打开面板\" giving up after 120\n" +
		"if button returned of r is \"打开面板\" then return \"open\"\nreturn \"\""
}

func (m *MacOS) Send(ctx context.Context, a core.Alert) error {
	if !m.Dialog && m.AppPath != "" {
		return m.sendNative(ctx, a)
	}
	script := m.Script(a)
	if !m.Dialog {
		_, err := m.run(ctx, "osascript", "-e", script)
		return err
	}
	// 对话框最长等待 2 分钟，放到后台，不阻塞后续推送
	go func() {
		c, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		out, err := m.run(c, "osascript", "-e", script)
		if err == nil && strings.TrimSpace(string(out)) == "open" && strings.HasPrefix(a.Link, "http://") {
			m.run(c, "open", a.Link)
		}
	}()
	return nil
}

// Ntfy 向 ntfy 主题 URL 发送推送；只发送类别与编号，不发送命令或对话内容。
type Ntfy struct {
	URL    string
	Client *http.Client
}

func (n *Ntfy) Send(ctx context.Context, a core.Alert) error {
	if n.URL == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "POST", n.URL, strings.NewReader(a.Body))
	if err != nil {
		return err
	}
	// HTTP 头按 latin-1 传输，中文标题用 RFC 2047 编码（ntfy 支持解码）
	req.Header.Set("Title", mime.BEncoding.Encode("utf-8", "Session Steward: "+a.Title))
	link := a.Link
	if a.RemoteLink != "" {
		link = a.RemoteLink
	}
	req.Header.Set("Click", link)
	req.Header.Set("Tags", "bell")
	c := n.Client
	if c == nil {
		c = http.DefaultClient
	}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		return errors.New("ntfy 返回 " + resp.Status)
	}
	return nil
}
