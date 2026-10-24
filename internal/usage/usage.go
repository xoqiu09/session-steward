// Package usage 从本机 Agent transcript 中只读取 token 计数字段，不保存或返回任何对话内容。
// 格式依据各 Agent 本地 JSONL：Claude 的 assistant 行 message.usage；Codex 的 token_count 事件。
// 格式未知或变化时返回零值，不猜测。
package usage

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type Totals struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

func (t Totals) Zero() bool { return t == Totals{} }

// claudeLine 只声明需要的数字字段；其余内容被 json 解码器丢弃。
type claudeLine struct {
	Type    string `json:"type"`
	Message struct {
		ID    string `json:"id"`
		Usage *struct {
			Input      int64 `json:"input_tokens"`
			Output     int64 `json:"output_tokens"`
			CacheRead  int64 `json:"cache_read_input_tokens"`
			CacheWrite int64 `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	} `json:"message"`
}

func scan(path string, fn func([]byte)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 256*1024), 16*1024*1024)
	for sc.Scan() {
		fn(sc.Bytes())
	}
	return sc.Err()
}

// Claude 汇总一个会话文件。同一条消息可能分多行写入（流式），按 message.id 只计最后一次。
func Claude(path string) (Totals, error) {
	per := map[string]Totals{}
	n := 0
	err := scan(path, func(b []byte) {
		if !strings.Contains(string(b), `"usage"`) {
			return
		}
		var l claudeLine
		if json.Unmarshal(b, &l) != nil || l.Type != "assistant" || l.Message.Usage == nil {
			return
		}
		id := l.Message.ID
		if id == "" {
			n++
			id = "#" + string(rune(n))
		}
		u := l.Message.Usage
		per[id] = Totals{Input: u.Input, Output: u.Output, CacheRead: u.CacheRead, CacheWrite: u.CacheWrite}
	})
	var t Totals
	for _, v := range per {
		t.Input += v.Input
		t.Output += v.Output
		t.CacheRead += v.CacheRead
		t.CacheWrite += v.CacheWrite
	}
	return t, err
}

type codexLine struct {
	Type    string `json:"type"`
	Payload struct {
		Type string `json:"type"`
		Info *struct {
			Total *struct {
				Input     int64 `json:"input_tokens"`
				Cached    int64 `json:"cached_input_tokens"`
				Output    int64 `json:"output_tokens"`
				Reasoning int64 `json:"reasoning_output_tokens"`
			} `json:"total_token_usage"`
		} `json:"info"`
	} `json:"payload"`
}

// Codex 取最后一次 token_count 的累计值。cached 从 input 中拆出为 CacheRead。
func Codex(path string) (Totals, error) {
	var t Totals
	err := scan(path, func(b []byte) {
		if !strings.Contains(string(b), `"token_count"`) {
			return
		}
		var l codexLine
		if json.Unmarshal(b, &l) != nil || l.Payload.Type != "token_count" || l.Payload.Info == nil || l.Payload.Info.Total == nil {
			return
		}
		u := l.Payload.Info.Total
		in := u.Input - u.Cached
		if in < 0 {
			in = u.Input
		}
		// output_tokens 已包含 reasoning_output_tokens；后者只是明细，不能再相加。
		t = Totals{Input: in, Output: u.Output, CacheRead: u.Cached}
	})
	return t, err
}

// Finder 定位会话 transcript。根目录可替换以便测试。
type Finder struct {
	ClaudeRoot string // ~/.claude/projects
	CodexRoot  string // ~/.codex/sessions
}

func DefaultFinder() Finder {
	h, _ := os.UserHomeDir()
	return Finder{ClaudeRoot: filepath.Join(h, ".claude", "projects"), CodexRoot: filepath.Join(h, ".codex", "sessions")}
}

func safeID(id string) bool {
	return id != "" && !strings.ContainsAny(id, `/\*?[]`) && !strings.Contains(id, "..")
}

// Totals 返回会话累计用量；找不到文件时 ok=false。
func (f Finder) Totals(provider, sessionID string) (Totals, bool) {
	if !safeID(sessionID) {
		return Totals{}, false
	}
	var files []string
	var parse func(string) (Totals, error)
	switch provider {
	case "claude":
		files, _ = filepath.Glob(filepath.Join(f.ClaudeRoot, "*", sessionID+".jsonl"))
		parse = Claude
	case "codex":
		files, _ = filepath.Glob(filepath.Join(f.CodexRoot, "*", "*", "*", "*"+sessionID+".jsonl"))
		parse = Codex
	default:
		return Totals{}, false
	}
	if len(files) == 0 {
		return Totals{}, false
	}
	t, err := parse(files[len(files)-1])
	return t, err == nil
}
