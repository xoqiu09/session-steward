// Package conversation resolves existing desktop conversation links without launching an agent.
package conversation

import (
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var uuid = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var hostSession = regexp.MustCompile(`^local_[A-Za-z0-9_-]{1,64}$`)

type Target struct {
	Mode     string `json:"mode"` // app | manual
	Provider string `json:"provider"`
	URL      string `json:"url,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

func Resolve(provider, client, sessionID, claudeSessions string) Target {
	t := Target{Mode: "manual", Provider: provider, Reason: "这条记录没有可直接定位的桌面会话入口，可复制恢复命令继续处理。"}
	if !uuid.MatchString(sessionID) || client != "desktop" {
		return t
	}
	switch provider {
	case "codex":
		t.Mode, t.URL, t.Reason = "app", (&url.URL{Scheme: "codex", Host: "threads", Path: "/" + sessionID}).String(), ""
	case "claude":
		u := url.URL{Scheme: "claude", Host: "resume"}
		q := url.Values{"session": []string{sessionID}}
		if host := ClaudeDesktopHost(claudeSessions, sessionID); host != "" {
			u.Host, u.Path = "code", "/continue"
			q.Set("session", host)
		}
		u.RawQuery = q.Encode()
		t.Mode, t.URL, t.Reason = "app", u.String(), ""
	}
	return t
}

// Claude's small live sidecars contain the desktop host ID. No transcript is read.
func ClaudeDesktopHost(directory, sessionID string) string {
	if !uuid.MatchString(sessionID) || !filepath.IsAbs(directory) {
		return ""
	}
	files, _ := os.ReadDir(directory)
	type candidate struct {
		host     string
		modified time.Time
	}
	var candidates []candidate
	for i, entry := range files {
		if i >= 512 {
			break
		}
		if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 {
			continue
		}
		f, err := os.Open(filepath.Join(directory, entry.Name()))
		if err != nil {
			continue
		}
		data, err := io.ReadAll(io.LimitReader(f, (64<<10)+1))
		f.Close()
		if err != nil || len(data) > 64<<10 {
			continue
		}
		var meta struct {
			SessionID  string `json:"sessionId"`
			HostID     string `json:"hostSessionId"`
			Entrypoint string `json:"entrypoint"`
		}
		if json.Unmarshal(data, &meta) != nil || meta.SessionID != sessionID || !hostSession.MatchString(meta.HostID) {
			continue
		}
		if meta.Entrypoint != "" && !strings.Contains(meta.Entrypoint, "desktop") {
			continue
		}
		candidates = append(candidates, candidate{meta.HostID, info.ModTime()})
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].modified.After(candidates[j].modified) })
	if len(candidates) > 0 {
		return candidates[0].host
	}
	return ""
}
