package hook

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestNativeQuestionsNeverWaitForGenericPermission(t *testing.T) {
	for _, tool := range []string{"AskUserQuestion", "ExitPlanMode"} {
		t.Run(tool, func(t *testing.T) {
			var got event.Event
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/hook/event" {
					t.Errorf("native input called blocking endpoint: %s", r.URL.Path)
				}
				json.NewDecoder(r.Body).Decode(&got)
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"acked":[]}`))
			}))
			defer server.Close()
			client := Client{BaseURL: server.URL, Env: func(string) string { return "" }}
			raw, _ := json.Marshal(map[string]any{"session_id": "synthetic", "hook_event_name": "PermissionRequest", "tool_name": tool, "tool_input": map[string]any{"questions": []map[string]any{{"question": "选择合成格式？"}}}})
			var stdout bytes.Buffer
			client.Handle(context.Background(), "claude", "", raw, &stdout)
			if stdout.Len() != 0 || got.Kind != event.KindNotifyInput || got.Reason != "native_user_input" {
				t.Fatalf("must leave native UI in control: output=%q event=%+v", stdout.String(), got)
			}
		})
	}
}
