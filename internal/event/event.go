// Package event 定义 Steward 的统一事件格式，并把各 Agent 的 hook 输入转换成它。
package event

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

const SchemaVersion = 1

// Kind 是标准化后的事件类型，与具体 Agent 的事件名解耦。
type Kind string

const (
	KindSessionStart     Kind = "session_start"
	KindPrompt           Kind = "prompt"
	KindToolPre          Kind = "tool_pre"
	KindToolPost         Kind = "tool_post"
	KindToolFail         Kind = "tool_fail"
	KindPermission       Kind = "permission_request"
	KindNotifyPerm       Kind = "notify_permission"
	KindNotifyIdle       Kind = "notify_idle"
	KindNotifyInput      Kind = "notify_input"
	KindNotifyOther      Kind = "notify_other"
	KindStop             Kind = "stop"
	KindStopFailure      Kind = "stop_failure"
	KindInterrupt        Kind = "interrupt"
	KindSessionEnd       Kind = "session_end"
	KindSubagentOn       Kind = "subagent_start"
	KindSubagentOff      Kind = "subagent_stop"
	KindCompact          Kind = "compact"
	KindPermissionDenied Kind = "permission_denied"
	KindCwdChanged       Kind = "cwd_changed"
	KindTaskCompleted    Kind = "task_completed"
	KindQuotaResumed     Kind = "quota_resumed"
	KindQuotaAwaitInput  Kind = "quota_await_input"
	KindAsk              Kind = "ask"   // steward-hook ask：Agent 主动求助
	KindClaim            Kind = "claim" // steward-hook claim：Agent 声明工作项
	KindDeliver          Kind = "deliver"
	KindBegin            Kind = "begin"  // 明确任务标题后，一次创建或复用并关联
	KindReport           Kind = "report" // steward-hook report：Agent 回报工作简报
	KindFeatures         Kind = "features"
	KindUnknown          Kind = "unknown"
)

// Source 描述事件来自哪个 Agent、哪个客户端。
type Source struct {
	Channel    string `json:"channel,omitempty"`    // hook | transcript | process | git | github | hub | model | user
	Ref        string `json:"ref,omitempty"`        // 本机回查引用；不进入多设备摘要
	Provider   string `json:"provider"`             // claude | codex | other
	Client     string `json:"client"`               // cli | desktop | unknown
	Originator string `json:"originator,omitempty"` // 原始入口标识，供诊断；不作为客户端枚举
	Version    string `json:"version,omitempty"`
	HostID     string `json:"host_id"`
}

// Event 是落库与推送的统一结构。只包含脱敏后的字段。
type Event struct {
	EventID              string            `json:"event_id"`
	SchemaVersion        int               `json:"schema_version"`
	OccurredAt           time.Time         `json:"occurred_at"`
	ReceivedAt           time.Time         `json:"received_at,omitempty"`
	Source               Source            `json:"source"`
	Kind                 Kind              `json:"kind"`
	RawName              string            `json:"raw_name"` // 原始 hook 事件名，便于排查
	SessionID            string            `json:"session_id"`
	ParentID             string            `json:"parent_session_id,omitempty"`
	SubagentID           string            `json:"subagent_id,omitempty"`
	TurnID               string            `json:"turn_id,omitempty"`
	ToolUseID            string            `json:"tool_use_id,omitempty"`
	ExecutionFingerprint string            `json:"execution_fingerprint,omitempty"` // 仅关联执行证据，不能用于授权
	Cwd                  string            `json:"cwd,omitempty"`
	Branch               string            `json:"branch,omitempty"`
	ToolName             string            `json:"tool_name,omitempty"`
	Fingerprint          string            `json:"fingerprint,omitempty"` // 工具名+参数+cwd 的哈希
	Preview              string            `json:"preview,omitempty"`     // 截断后的命令/路径预览
	Reason               string            `json:"reason,omitempty"`      // 失败原因、通知类型等
	WorkTag              string            `json:"work_tag,omitempty"`    // prompt 中的 #QM-014 等显式标识
	Text                 string            `json:"text,omitempty"`        // 仅 ask/deliver 或开启摘要时保存
	EndsWithAsk          bool              `json:"ends_with_question,omitempty"`
	WorkTitle            string            `json:"work_title,omitempty"`
	ProjectPath          string            `json:"project_path,omitempty"`
	Brief                map[string]string `json:"brief,omitempty"` // 仅 report：goal/progress/blocker/next，空串表示清除
	Features             *FeatureBatch     `json:"features,omitempty"`
}

func (e *Event) Validate() error {
	if !ValidChannel(e.Source.Channel) {
		return fmt.Errorf("未知信号渠道: %s", e.Source.Channel)
	}
	if len(e.Source.Ref) > 1024 || strings.ContainsAny(e.Source.Ref, "\r\n\x00") {
		return fmt.Errorf("信号引用格式无效")
	}
	if e.Features != nil && e.Kind != KindFeatures {
		return fmt.Errorf("功能回报请使用 features 动作")
	}
	if e.Kind == KindFeatures {
		if err := e.Features.Validate(); err != nil {
			return err
		}
	}
	if e.EventID == "" {
		return fmt.Errorf("event_id 为空")
	}
	if e.SessionID == "" {
		return fmt.Errorf("session_id 为空")
	}
	if e.Source.Provider == "" {
		return fmt.Errorf("provider 为空")
	}
	if e.OccurredAt.IsZero() {
		return fmt.Errorf("occurred_at 为空")
	}
	if e.Kind == KindBegin || e.Kind == KindReport || e.Kind == KindDeliver {
		if stage, ok := e.Brief["stage"]; ok {
			switch stage {
			case "", "unknown", "planning", "implementing", "validating":
			case "review":
				if e.Kind != KindDeliver {
					return fmt.Errorf("待验收请使用 deliver")
				}
			default:
				return fmt.Errorf("stage 应为 unknown/planning/implementing/validating；待验收请使用 deliver，已验收只能由用户确认")
			}
		}
		if owner, ok := e.Brief["next_owner"]; ok {
			switch owner {
			case "", "unknown", "agent", "claude", "codex", "user", "external":
			default:
				return fmt.Errorf("next_owner 应为 unknown/agent/claude/codex/user/external")
			}
		}
	}
	return nil
}

var workTagRe = regexp.MustCompile(`#([A-Za-z][A-Za-z0-9]{0,15}-\d{1,6})\b`)

// ExtractWorkTag 从文本中找出第一个 #ABC-123 形式的工作项标识。
func ExtractWorkTag(s string) string {
	m := workTagRe.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return strings.ToUpper(m[1])
}

// Fingerprint 计算权限请求的内容指纹。参数先做规范化 JSON 编码，避免键序影响。
func Fingerprint(tool string, input json.RawMessage, cwd string) string {
	var v any
	canon := []byte(input)
	if len(input) > 0 && json.Unmarshal(input, &v) == nil {
		if b, err := json.Marshal(v); err == nil { // map 键在 Marshal 时排序
			canon = b
		}
	}
	h := sha256.New()
	h.Write([]byte(tool))
	h.Write([]byte{0})
	h.Write(canon)
	h.Write([]byte{0})
	h.Write([]byte(cwd))
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// ExecutionFingerprint 在同一轮中寻找对应的工具调用。Bash 的权限事件会
// 增加 description 等展示字段，因此执行关联只取命令和有效目录；实际授权
// 仍使用包含完整参数的 Fingerprint，且关联必须由唯一的 tool_use_id 确认。
func ExecutionFingerprint(tool string, input json.RawMessage, cwd string) string {
	if tool != "Bash" {
		return Fingerprint(tool, input, cwd)
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(input, &m) != nil || len(m["command"]) == 0 {
		return ""
	}
	for _, key := range []string{"cwd", "workdir"} {
		var dir string
		if json.Unmarshal(m[key], &dir) == nil && dir != "" {
			cwd = dir
			break
		}
	}
	return Fingerprint(tool, m["command"], cwd)
}

// CodexClient 统一已知入口名。未识别的值保留为 unknown，原始入口另存。
func CodexClient(originator string) string {
	s := strings.ToLower(strings.TrimSpace(originator))
	s = strings.NewReplacer("-", "_", " ", "_").Replace(s)
	switch s {
	case "desktop", "codex_desktop", "codex_work_desktop":
		return "desktop"
	case "cli", "codex_cli", "codex_cli_rs", "codex_tui", "codex_exec", "codex_exec_v2", "exec":
		return "cli"
	default:
		return "unknown"
	}
}

// Truncate 截断到 n 个字符（按 rune）。
func Truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

var (
	bearerRe = regexp.MustCompile(`(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{6,}`)
	secretRe = regexp.MustCompile(`(?i)((?:api[_-]?key|access[_-]?key|token|secret|password|passwd|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s'"]+)`)
	keyRe    = regexp.MustCompile(`\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})`)
)

// Redact 遮盖预览中明显的密钥片段。
func Redact(s string) string {
	s = bearerRe.ReplaceAllString(s, "${1} ***")
	s = secretRe.ReplaceAllString(s, "${1}***")
	return keyRe.ReplaceAllString(s, "***")
}

// EndsWithQuestion 判断最后一条消息是否以问句结尾（低置信度提醒用）。
func EndsWithQuestion(s string) bool {
	s = strings.TrimSpace(s)
	s = strings.TrimRight(s, " \t\n*_`")
	return strings.HasSuffix(s, "?") || strings.HasSuffix(s, "？")
}
