package event

import (
	"encoding/json"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

// HookInput 是 Claude Code 与 Codex hook stdin 的公共字段超集。
// 字段缺失时保持零值；未识别的字段被忽略，不落库。
type HookInput struct {
	SessionID        string          `json:"session_id"`
	TranscriptPath   string          `json:"transcript_path"`
	Cwd              string          `json:"cwd"`
	HookEventName    string          `json:"hook_event_name"`
	PermissionMode   string          `json:"permission_mode"`
	Model            string          `json:"model"`
	TurnID           string          `json:"turn_id"`
	ToolUseID        string          `json:"tool_use_id"`
	ToolName         string          `json:"tool_name"`
	ToolInput        json.RawMessage `json:"tool_input"`
	Prompt           string          `json:"prompt"`
	Message          string          `json:"message"`
	NotificationType string          `json:"notification_type"`
	LastAssistant    string          `json:"last_assistant_message"`
	Error            json.RawMessage `json:"error"`
	ErrorType        string          `json:"error_type"`
	Reason           string          `json:"reason"`
	Source           string          `json:"source"` // SessionStart: startup|resume|...
	AgentID          string          `json:"agent_id"`
	AgentType        string          `json:"agent_type"`
}

// Options 控制规范化时的隐私与环境信息。
type Options struct {
	Provider      string
	HostID        string
	Env           func(string) string
	KeepSummary   bool // 是否保留 prompt/最后回复的截断摘要
	Now           func() time.Time
	NewID         func() string
	ReadFirstLine func(path string) string
}

func (o *Options) defaults() {
	if o.Env == nil {
		o.Env = os.Getenv
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.ReadFirstLine == nil {
		o.ReadFirstLine = readFirstLine
	}
}

// Normalize 把一次 hook 调用转换成统一事件。不会保存原始 payload。
func Normalize(raw []byte, opt Options) (*Event, *HookInput, error) {
	opt.defaults()
	var in HookInput
	if err := json.Unmarshal(raw, &in); err != nil {
		return nil, nil, err
	}
	e := &Event{
		EventID:       opt.NewID(),
		SchemaVersion: SchemaVersion,
		OccurredAt:    opt.Now().UTC(),
		Source: Source{
			Provider: opt.Provider,
			Channel:  "hook",
			HostID:   opt.HostID,
		},
		RawName:    in.HookEventName,
		SessionID:  in.SessionID,
		Cwd:        in.Cwd,
		ToolName:   in.ToolName,
		SubagentID: in.AgentID,
		TurnID:     in.TurnID,
		ToolUseID:  in.ToolUseID,
	}
	e.Source.Ref = e.EventID
	e.Source.Client, e.Source.Version, e.Source.Originator = detectClient(opt, in.TranscriptPath)
	e.Kind = classify(opt.Provider, &in)

	switch e.Kind {
	case KindToolPre, KindToolPost, KindToolFail, KindPermission:
		e.Preview = Redact(Truncate(toolPreview(in.ToolName, in.ToolInput), 160))
		e.Fingerprint = Fingerprint(in.ToolName, in.ToolInput, in.Cwd)
		e.ExecutionFingerprint = ExecutionFingerprint(in.ToolName, in.ToolInput, in.Cwd)
	case KindPrompt:
		e.WorkTag = ExtractWorkTag(in.Prompt)
		if opt.KeepSummary {
			e.Text = Redact(Truncate(in.Prompt, 200))
		}
	case KindStop:
		e.EndsWithAsk = EndsWithQuestion(in.LastAssistant)
		if opt.KeepSummary || e.EndsWithAsk {
			// 问句结尾时保留末尾片段，作为“疑似需要关注”的上下文
			e.Text = Redact(tail(in.LastAssistant, 200))
		}
	case KindStopFailure:
		e.Reason = firstNonEmpty(in.ErrorType, errString(in.Error), in.Reason, "unknown")
	case KindNotifyPerm, KindNotifyIdle, KindNotifyInput, KindNotifyOther:
		e.Reason = in.NotificationType
		e.Preview = Redact(Truncate(in.Message, 160))
		if NativeInputTool(opt.Provider, in.ToolName) {
			e.Reason = "native_user_input"
			e.Preview = Redact(Truncate(toolPreview(in.ToolName, in.ToolInput), 160))
			e.Fingerprint = Fingerprint(in.ToolName, in.ToolInput, in.Cwd)
			e.ExecutionFingerprint = ExecutionFingerprint(in.ToolName, in.ToolInput, in.Cwd)
		}
	case KindSessionStart, KindSessionEnd:
		e.Reason = firstNonEmpty(in.Source, in.Reason)
	}
	return e, &in, nil
}

func classify(provider string, in *HookInput) Kind {
	switch in.HookEventName {
	case "SessionStart":
		return KindSessionStart
	case "UserPromptSubmit":
		return KindPrompt
	case "PreToolUse":
		return KindToolPre
	case "PostToolUse":
		return KindToolPost
	case "PostToolUseFailure":
		return KindToolFail
	case "PermissionRequest":
		if NativeInputTool(provider, in.ToolName) {
			return KindNotifyInput
		}
		return KindPermission
	case "Notification":
		switch in.NotificationType {
		case "permission_prompt":
			return KindNotifyPerm
		case "idle_prompt":
			return KindNotifyIdle
		case "agent_needs_input", "elicitation_dialog":
			return KindNotifyInput
		}
		return KindNotifyOther
	case "Stop":
		return KindStop
	case "StopFailure":
		return KindStopFailure
	case "Interrupt":
		return KindInterrupt
	case "SessionEnd":
		return KindSessionEnd
	case "SubagentStart":
		return KindSubagentOn
	case "SubagentStop":
		return KindSubagentOff
	case "PreCompact", "PostCompact":
		return KindCompact
	}
	return KindUnknown
}

// These tools collect an answer or plan approval. A generic allow/deny cannot
// supply that interaction; leave it to Claude's native UI.
func NativeInputTool(provider, tool string) bool {
	return provider == "claude" && (tool == "AskUserQuestion" || tool == "ExitPlanMode")
}

// detectClient 判断事件来自 CLI 还是桌面客户端。只读取 transcript 第一行。
func detectClient(opt Options, transcript string) (client, version, originator string) {
	switch opt.Provider {
	case "claude":
		// 版本与入口从 transcript 开头读取；环境变量优先决定客户端
		head := ""
		if transcript != "" {
			head = opt.ReadFirstLine(transcript)
		}
		v := matchField(claudeVersionRe, head)
		ep := opt.Env("CLAUDE_CODE_ENTRYPOINT")
		if ep == "" {
			ep = matchField(claudeEntryRe, head)
		}
		switch {
		case ep == "cli":
			return "cli", v, ep
		case strings.Contains(ep, "desktop"):
			return "desktop", v, ep
		case ep != "":
			return ep, v, ep
		}
		return "unknown", v, ep
	case "codex":
		if transcript == "" {
			return "unknown", "", ""
		}
		head := opt.ReadFirstLine(transcript)
		o := matchField(originatorRe, head)
		v := matchField(cliVersionRe, head)
		return CodexClient(o), v, o
	}
	return "unknown", "", ""
}

func toolPreview(tool string, input json.RawMessage) string {
	if len(input) == 0 {
		return tool
	}
	var m map[string]any
	if json.Unmarshal(input, &m) != nil {
		return tool
	}
	if tool == "AskUserQuestion" {
		if questions, ok := m["questions"].([]any); ok {
			var parts []string
			for _, q := range questions {
				if question, ok := q.(map[string]any); ok {
					if text, ok := question["question"].(string); ok {
						parts = append(parts, text)
					}
				}
			}
			if len(parts) > 0 {
				return strings.Join(parts, "；")
			}
		}
	}
	if tool == "ExitPlanMode" {
		return "请回到 Claude 审阅并确认实施计划"
	}
	for _, k := range []string{"command", "cmd", "file_path", "path", "url", "pattern", "description"} {
		if v, ok := m[k]; ok {
			switch t := v.(type) {
			case string:
				return tool + ": " + t
			case []any:
				parts := make([]string, 0, len(t))
				for _, p := range t {
					if s, ok := p.(string); ok {
						parts = append(parts, s)
					}
				}
				return tool + ": " + strings.Join(parts, " ")
			}
		}
	}
	return tool
}

func errString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) == nil {
		for _, k := range []string{"type", "code", "message"} {
			if v, ok := m[k].(string); ok && v != "" {
				return v
			}
		}
	}
	return ""
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}

func tail(s string, n int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return "…" + string(r[len(r)-n:])
}

var (
	originatorRe = regexp.MustCompile(`"originator"\s*:\s*"([^"]*)"`)
	cliVersionRe = regexp.MustCompile(`"cli_version"\s*:\s*"([^"]*)"`)
	// Claude transcript 每行带 "version" 与 "entrypoint"；只读开头即可
	claudeVersionRe = regexp.MustCompile(`"version"\s*:\s*"(\d+\.\d+\.\d+[^"]*)"`)
	claudeEntryRe   = regexp.MustCompile(`"entrypoint"\s*:\s*"([^"]*)"`)
)

func matchField(re *regexp.Regexp, s string) string {
	if m := re.FindStringSubmatch(s); m != nil {
		return m[1]
	}
	return ""
}

// readFirstLine 只读取文件开头 64KB；Codex 的 session_meta 行可能很长，只需前缀字段。
func readFirstLine(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	buf := make([]byte, 64*1024)
	n, _ := io.ReadFull(f, buf)
	return string(buf[:n])
}
