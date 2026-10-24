package event

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func opts(provider string, env map[string]string) Options {
	return Options{Provider: provider, HostID: "h", NewID: func() string { return "id1" },
		Env: func(k string) string { return env[k] }, Now: func() time.Time { return time.Unix(0, 0) },
		ReadFirstLine: func(string) string {
			return `{"timestamp":"x","type":"session_meta","payload":{"id":"abc","originator":"codex_work_desktop","cli_version":"0.163.0","base_instructions":{"text":"...`
		}}
}

func TestNormalizeClaudePermission(t *testing.T) {
	raw := `{"session_id":"s","cwd":"/r","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"curl -H 'Authorization: Bearer abc123' x","description":"d"}}`
	e, _, err := Normalize([]byte(raw), opts("claude", map[string]string{"CLAUDE_CODE_ENTRYPOINT": "cli"}))
	if err != nil {
		t.Fatal(err)
	}
	if e.Kind != KindPermission || e.Source.Client != "cli" || e.Fingerprint == "" {
		t.Fatalf("%+v", e)
	}
	if strings.Contains(e.Preview, "abc123") {
		t.Fatalf("预览未脱敏: %s", e.Preview)
	}
	b, _ := json.Marshal(e)
	if strings.Contains(string(b), "abc123") {
		t.Fatal("事件中不应包含原始密钥")
	}
}

func TestFingerprintStable(t *testing.T) {
	a := Fingerprint("Bash", json.RawMessage(`{"a":1,"b":2}`), "/r")
	b := Fingerprint("Bash", json.RawMessage(`{"b":2, "a":1}`), "/r")
	c := Fingerprint("Bash", json.RawMessage(`{"a":1,"b":3}`), "/r")
	if a != b || a == c {
		t.Fatal("指纹应与键序无关、与内容相关")
	}
}

func TestNotificationKinds(t *testing.T) {
	for typ, want := range map[string]Kind{"idle_prompt": KindNotifyIdle, "permission_prompt": KindNotifyPerm, "agent_needs_input": KindNotifyInput, "x": KindNotifyOther} {
		raw := `{"session_id":"s","hook_event_name":"Notification","notification_type":"` + typ + `","message":"m"}`
		e, _, _ := Normalize([]byte(raw), opts("claude", nil))
		if e.Kind != want {
			t.Fatalf("%s → %s", typ, e.Kind)
		}
	}
}

func TestCodexClientAndInterrupt(t *testing.T) {
	raw := `{"session_id":"s","transcript_path":"/t.jsonl","hook_event_name":"Interrupt"}`
	e, _, _ := Normalize([]byte(raw), opts("codex", nil))
	if e.Kind != KindInterrupt || e.Source.Client != "desktop" || e.Source.Version != "0.163.0" {
		t.Fatalf("%+v", e)
	}
}

func TestCodexOriginatorVariants(t *testing.T) {
	for origin, want := range map[string]string{
		"Codex Desktop": "desktop", "codex_work_desktop": "desktop",
		"codex-tui": "cli", "codex_cli_rs": "cli", "codex_exec": "cli",
		"future-custom-client": "unknown", "desktop-imposter": "unknown",
	} {
		t.Run(origin, func(t *testing.T) {
			o := opts("codex", nil)
			o.ReadFirstLine = func(string) string {
				b, _ := json.Marshal(map[string]string{"originator": origin, "cli_version": "0.163.0-alpha.10.2"})
				return string(b)
			}
			e, _, err := Normalize([]byte(`{"session_id":"s","transcript_path":"/t","hook_event_name":"Stop"}`), o)
			if err != nil || e.Source.Client != want || e.Source.Originator != origin || e.Source.Version != "0.163.0-alpha.10.2" {
				t.Fatalf("%+v err=%v", e.Source, err)
			}
		})
	}
}

func TestCodexPermissionExecutionIdentity(t *testing.T) {
	pre := `{"session_id":"s","turn_id":"turn","tool_use_id":"call","cwd":"/r","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"printf OK","timeout_ms":10000}}`
	perm := `{"session_id":"s","turn_id":"turn","cwd":"/r","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"printf OK","description":"Need approval"}}`
	a, _, _ := Normalize([]byte(pre), opts("codex", nil))
	b, _, _ := Normalize([]byte(perm), opts("codex", nil))
	if a.TurnID != "turn" || a.ToolUseID != "call" || a.Fingerprint == b.Fingerprint || a.ExecutionFingerprint == "" || a.ExecutionFingerprint != b.ExecutionFingerprint {
		t.Fatalf("授权指纹须完整保留，执行关联单独处理: pre=%+v perm=%+v", a, b)
	}
	if ExecutionFingerprint("Bash", json.RawMessage(`{"command":"printf OTHER"}`), "/r") == a.ExecutionFingerprint ||
		ExecutionFingerprint("Bash", json.RawMessage(`{"command":"printf OK","workdir":"/elsewhere"}`), "/r") == a.ExecutionFingerprint {
		t.Fatal("命令或有效目录不同不得视为同一执行")
	}
}

func TestStopPrivacy(t *testing.T) {
	raw := `{"session_id":"s","hook_event_name":"Stop","last_assistant_message":"已经完成了修改。"}`
	e, _, _ := Normalize([]byte(raw), opts("claude", nil))
	if e.Text != "" || e.EndsWithAsk {
		t.Fatal("默认不保存最后回复")
	}
	raw = `{"session_id":"s","hook_event_name":"Stop","last_assistant_message":"要我继续合并吗？"}`
	e, _, _ = Normalize([]byte(raw), opts("claude", nil))
	if !e.EndsWithAsk || e.Text == "" {
		t.Fatal("问句结尾应保留片段")
	}
}

func TestWorkTag(t *testing.T) {
	if ExtractWorkTag("继续 #qm-014 的工作") != "QM-014" {
		t.Fatal()
	}
	if ExtractWorkTag("issue #123") != "" {
		t.Fatal("纯数字不算工作项编号")
	}
}

func TestRedact(t *testing.T) {
	cases := map[string]string{
		"curl -H 'Authorization: Bearer abc123def'":                "abc123def",
		"export API_KEY=supersecret1":                              "supersecret1",
		"password: \"hunter22\"":                                   "hunter22",
		"echo sk-abcdefghijklmnop1234":                             "sk-abcdefghijklmnop1234",
		"git push https://ghp_aaaaaaaaaaaaaaaaaaaaaaaa@github.com": "ghp_aaaaaaaaaaaaaaaaaaaaaaaa",
	}
	for in, secret := range cases {
		if out := Redact(in); strings.Contains(out, secret) {
			t.Errorf("%q → %q 仍含密钥", in, out)
		}
	}
	if Redact("go test ./...") != "go test ./..." {
		t.Error("普通命令不应改变")
	}
}

func TestClaudeVersionFromTranscript(t *testing.T) {
	o := opts("claude", nil)
	o.ReadFirstLine = func(string) string {
		return `{"type":"queue-operation"}` + "\n" + `{"type":"user","entrypoint":"cli","version":"2.1.302","cwd":"/r"}`
	}
	e, _, _ := Normalize([]byte(`{"session_id":"s","transcript_path":"/t","hook_event_name":"Stop"}`), o)
	if e.Source.Client != "cli" || e.Source.Version != "2.1.302" {
		t.Fatalf("%+v", e.Source)
	}
}
