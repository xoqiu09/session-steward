package hook

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestSessionGuidanceUsesExactSessionAndSafeCommand(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		e := &event.Event{Source: event.Source{Provider: provider}, SessionID: "session-123"}
		var out struct {
			HookSpecificOutput struct {
				HookEventName     string `json:"hookEventName"`
				AdditionalContext string `json:"additionalContext"`
			} `json:"hookSpecificOutput"`
		}
		if err := json.Unmarshal(SessionGuidance(e, "", "/local dev/steward-hook"), &out); err != nil {
			t.Fatal(err)
		}
		s := out.HookSpecificOutput.AdditionalContext
		if out.HookSpecificOutput.HookEventName != "SessionStart" || !strings.Contains(s, "'/local dev/steward-hook' begin") || !strings.Contains(s, "--session 'session-123'") {
			t.Fatalf("invalid guidance: %s", s)
		}
		if !strings.Contains(string(SessionGuidance(e, "W-1", "/bin/hook")), " report ") {
			t.Fatal("已有归属应提示回报")
		}
		resumed := string(SessionGuidance(e, "", "/bin/hook", "W-1"))
		if !strings.Contains(resumed, "claim 'W-1'") || !strings.Contains(resumed, "若本次仍继续同一任务") {
			t.Fatal("恢复提示必须指出原归属，且以继续同一任务为条件")
		}
	}
}

func TestOnlySuccessfulEnabledSessionStartEmitsContext(t *testing.T) {
	for _, tc := range []struct {
		name      string
		enabled   bool
		code      int
		eventName string
		want      bool
	}{
		{"enabled", true, 200, "SessionStart", true}, {"disabled", false, 200, "SessionStart", false}, {"offline", true, 503, "SessionStart", false}, {"ordinary", true, 200, "Stop", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.code)
				json.NewEncoder(w).Encode(map[string]any{"acked": []string{"e"}, "reporting_hints": tc.enabled})
			}))
			defer srv.Close()
			c := &Client{BaseURL: srv.URL, HostID: "h"}
			var out bytes.Buffer
			c.Handle(context.Background(), "claude", tc.eventName, []byte(`{"session_id":"s1","cwd":"/repo"}`), &out)
			if (out.Len() > 0) != tc.want {
				t.Fatalf("unexpected output: %s", out.String())
			}
		})
	}
}
