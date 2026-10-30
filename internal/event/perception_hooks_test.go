package event

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPerceptionHooksDoNotReadOrKeepContent(t *testing.T) {
	for _, test := range []struct {
		event, notification string
		kind                Kind
	}{
		{"PermissionDenied", "", KindPermissionDenied}, {"CwdChanged", "", KindCwdChanged},
		{"PreCompact", "", KindCompact}, {"PostCompact", "", KindCompact},
		{"TaskCompleted", "", KindTaskCompleted}, {"Notification", "agent_completed", KindNotifyOther},
		{"Notification", "quota_auto_resume_fired", KindQuotaResumed},
		{"Notification", "quota_auto_resume_stale", KindQuotaAwaitInput},
		{"Notification", "quota_auto_resume_disabled", KindNotifyOther},
		{"Notification", "quota_auto_resume_future_variant", KindNotifyOther},
	} {
		t.Run(test.event+test.notification, func(t *testing.T) {
			raw, _ := json.Marshal(map[string]any{"session_id": "synthetic", "hook_event_name": test.event, "notification_type": test.notification,
				"cwd": "/old", "new_cwd": "/new", "transcript_path": "/must/not/read", "tool_name": "Bash", "tool_input": map[string]string{"command": "PRIVATE-CONTENT"},
				"message": "PRIVATE-CONTENT", "prompt": "PRIVATE-CONTENT", "last_assistant_message": "PRIVATE-CONTENT?", "task_subject": "PRIVATE-CONTENT", "reason": "PRIVATE-CONTENT"})
			e, _, err := Normalize(raw, Options{Provider: "claude", HostID: "test", KeepSummary: true, NewID: func() string { return "test" },
				Now: time.Now, Env: func(string) string { return "cli" }, ReadFirstLine: func(string) string { t.Fatal("Observation opened transcript"); return "" }})
			if err != nil || e.Kind != test.kind {
				t.Fatalf("got=%+v err=%v", e, err)
			}
			body, _ := json.Marshal(e)
			if strings.Contains(string(body), "PRIVATE-CONTENT") || strings.Contains(string(body), "/must/not/read") {
				t.Fatalf("Content leaked: %s", body)
			}
			if e.Kind == KindCwdChanged && e.Cwd != "/new" {
				t.Fatalf("Wrong target directory: %s", e.Cwd)
			}
			if e.Kind == KindPermissionDenied && e.Preview != "被自动拒绝：Bash" {
				t.Fatal(e.Preview)
			}
			if test.notification == "quota_auto_resume_future_variant" && e.Reason != "quota_auto_resume_unknown" {
				t.Fatal("Unknown quota type was interpreted")
			}
		})
	}
}

// 同一份 JSON 也由前端 SessionActivity 测试读取，连接规范化与实际文案。
func TestPerceptionUIFixtureMatchesNormalizedEvents(t *testing.T) {
	data, err := os.ReadFile("../../web/src/ui/claude-perception.fixture.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Input json.RawMessage `json:"input"`
		Event map[string]any  `json:"event"`
	}
	if err := json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for i, fixture := range fixtures {
		name := fixture.Event["raw_name"].(string)
		at := time.Date(2026, 10, 30, 0, 0, i, 0, time.UTC)
		e, _, err := Normalize(fixture.Input, Options{Provider: "claude", HostID: "synthetic", Env: func(string) string { return "cli" }, Now: func() time.Time { return at }, NewID: func() string { return "p3-" + name }, ReadFirstLine: func(string) string { t.Fatal("Fixture opened transcript"); return "" }})
		if err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(e)
		var normalized map[string]any
		json.Unmarshal(body, &normalized)
		for key, want := range fixture.Event {
			if normalized[key] != want {
				t.Fatalf("%s %s: got %v want %v", name, key, normalized[key], want)
			}
		}
	}
}
