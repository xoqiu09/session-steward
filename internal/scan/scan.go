// Package scan 冷启动扫描 Claude Code 与 Codex 的本地会话文件，只读取元数据，不读取对话正文。
package scan

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

// Found 是一条历史发现的会话。
type Found struct {
	Provider  string
	SessionID string
	Cwd       string
	Branch    string
	Client    string
	Version   string
	FirstAt   time.Time
	LastAt    time.Time // 文件修改时间
}

// Claude 扫描 ~/.claude/projects/*/*.jsonl。从文件开头若干行中取 sessionId、cwd、gitBranch、entrypoint、version。
func Claude(root string, since time.Time) []Found {
	files, _ := filepath.Glob(filepath.Join(root, "*", "*.jsonl"))
	var out []Found
	for _, f := range files {
		fi, err := os.Stat(f)
		if err != nil || fi.ModTime().Before(since) {
			continue
		}
		fd := claudeMeta(f)
		if fd.SessionID == "" {
			fd.SessionID = strings.TrimSuffix(filepath.Base(f), ".jsonl")
		}
		if fd.Cwd == "" {
			continue
		}
		fd.Provider = "claude"
		fd.LastAt = fi.ModTime()
		out = append(out, fd)
	}
	return out
}

func claudeMeta(path string) Found {
	var fd Found
	f, err := os.Open(path)
	if err != nil {
		return fd
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 256*1024), 4*1024*1024)
	for i := 0; i < 30 && sc.Scan(); i++ {
		var m struct {
			SessionID  string `json:"sessionId"`
			Cwd        string `json:"cwd"`
			GitBranch  string `json:"gitBranch"`
			Entrypoint string `json:"entrypoint"`
			Version    string `json:"version"`
			Timestamp  string `json:"timestamp"`
		}
		if json.Unmarshal(sc.Bytes(), &m) != nil {
			continue
		}
		if fd.SessionID == "" {
			fd.SessionID = m.SessionID
		}
		if fd.FirstAt.IsZero() && m.Timestamp != "" {
			fd.FirstAt, _ = time.Parse(time.RFC3339Nano, m.Timestamp)
		}
		if m.Cwd != "" {
			fd.Cwd = m.Cwd
			if m.GitBranch != "HEAD" {
				fd.Branch = m.GitBranch
			}
			fd.Version = m.Version
			switch {
			case m.Entrypoint == "cli":
				fd.Client = "cli"
			case strings.Contains(m.Entrypoint, "desktop"):
				fd.Client = "desktop"
			case m.Entrypoint != "":
				fd.Client = m.Entrypoint
			}
			break
		}
	}
	return fd
}

var (
	codexID      = regexp.MustCompile(`"id"\s*:\s*"([0-9a-fA-F-]{20,})"`)
	codexCwd     = regexp.MustCompile(`"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"`)
	codexOrig    = regexp.MustCompile(`"originator"\s*:\s*"([^"]*)"`)
	codexVersion = regexp.MustCompile(`"cli_version"\s*:\s*"([^"]*)"`)
	codexTS      = regexp.MustCompile(`"timestamp"\s*:\s*"([^"]*)"`)
	codexBranch  = regexp.MustCompile(`"branch"\s*:\s*"([^"]*)"`)
)

// Codex 扫描 ~/.codex/sessions/YYYY/MM/DD/*.jsonl。只读文件开头 64KB 的 session_meta 前缀字段。
func Codex(root string, since time.Time) []Found {
	files, _ := filepath.Glob(filepath.Join(root, "*", "*", "*", "*.jsonl"))
	var out []Found
	for _, f := range files {
		fi, err := os.Stat(f)
		if err != nil || fi.ModTime().Before(since) {
			continue
		}
		head := readHead(f, 64*1024)
		if !strings.Contains(head, `"session_meta"`) {
			continue
		}
		fd := Found{Provider: "codex", LastAt: fi.ModTime()}
		fd.SessionID = sub(codexID, head)
		if c := sub(codexCwd, head); c != "" {
			var s string
			if json.Unmarshal([]byte(`"`+c+`"`), &s) == nil {
				fd.Cwd = s
			}
		}
		fd.Version = sub(codexVersion, head)
		fd.Branch = sub(codexBranch, head)
		o := sub(codexOrig, head)
		fd.Client = event.CodexClient(o)
		if ts := sub(codexTS, head); ts != "" {
			fd.FirstAt, _ = time.Parse(time.RFC3339Nano, ts)
		}
		if fd.SessionID == "" || fd.Cwd == "" {
			continue
		}
		out = append(out, fd)
	}
	return out
}

func sub(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

func readHead(path string, n int) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, n)
	k, _ := io.ReadFull(f, buf)
	return string(buf[:k])
}
