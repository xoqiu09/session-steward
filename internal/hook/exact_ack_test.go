package hook

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestActiveActionsRequireExactEventACK(t *testing.T) {
	actions := []struct {
		name string
		call func(*Client) (string, error)
	}{
		{"AgentActionBrief", func(c *Client) (string, error) {
			return "", c.AgentActionBrief(context.Background(), event.KindDeliver, "synthetic delivery", map[string]string{"progress": "synthetic progress"}, "codex", "synthetic-session", "/synthetic")
		}},
		{"Report", func(c *Client) (string, error) {
			return "", c.Report(context.Background(), map[string]string{"progress": "synthetic progress"}, "codex", "synthetic-session", "/synthetic")
		}},
		{"Features", func(c *Client) (string, error) {
			return "", c.Features(context.Background(), &event.FeatureBatch{ScopeStatus: "documented", ScopeBasis: "synthetic specification", Features: []event.FeatureUpdate{{ID: "synthetic-feature", Title: "Synthetic feature", Implementation: "implementing"}}}, "codex", "synthetic-session", "/synthetic")
		}},
		{"Begin", func(c *Client) (string, error) {
			return c.Begin(context.Background(), "Synthetic task", "/synthetic", nil, "codex", "synthetic-session", "/synthetic")
		}},
	}
	cases := []struct {
		name      string
		status    int
		body      func(string) string
		wantError string
	}{
		{"exact", 200, func(id string) string { return fmt.Sprintf(`{"acked":[%q],"work_item_id":"SYN-1"}`, id) }, ""},
		{"other_and_exact", 200, func(id string) string {
			return fmt.Sprintf(`{"acked":["other-event",%q,"third-event"],"work_item_id":"SYN-1"}`, id)
		}, ""},
		{"missing", 200, func(string) string { return `{"work_item_id":"SYN-1"}` }, "未确认"},
		{"empty", 200, func(string) string { return `{"acked":[],"work_item_id":"SYN-1"}` }, "未确认"},
		{"null", 200, func(string) string { return `{"acked":null,"work_item_id":"SYN-1"}` }, "未确认"},
		{"wrong", 200, func(string) string { return `{"acked":["different-event"],"work_item_id":"SYN-1"}` }, "未确认"},
		{"rejected", 200, func(id string) string {
			return fmt.Sprintf(`{"rejected":[{"event_id":%q,"error":"synthetic explicit rejection"}]}`, id)
		}, "synthetic explicit rejection"},
		{"rejected_with_exact", 200, func(id string) string {
			return fmt.Sprintf(`{"acked":[%q],"rejected":[{"event_id":%q,"error":"synthetic explicit rejection"}],"work_item_id":"SYN-1"}`, id, id)
		}, "synthetic explicit rejection"},
		{"malformed_json", 200, func(string) string { return `{` }, "Steward 服务不可用"},
		{"malformed_ack_type", 200, func(id string) string { return fmt.Sprintf(`{"acked":%q}`, id) }, "Steward 服务不可用"},
		{"http_error", 409, func(string) string { return `{"error":"synthetic conflict"}` }, "Steward 请求未接受"},
	}
	for _, action := range actions {
		t.Run(action.name, func(t *testing.T) {
			for _, tc := range cases {
				t.Run(tc.name, func(t *testing.T) {
					ids := make(chan string, 1)
					srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						var e event.Event
						if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
							t.Error(err)
							http.Error(w, "invalid fixture request", 400)
							return
						}
						if r.URL.Path != "/hook/agent-action" || e.EventID == "" {
							t.Error("missing exact event identity or wrong endpoint")
						}
						ids <- e.EventID
						w.Header().Set("Content-Type", "application/json")
						w.WriteHeader(tc.status)
						_, _ = w.Write([]byte(tc.body(e.EventID)))
					}))
					defer srv.Close()
					c := &Client{BaseURL: srv.URL, HostID: "synthetic-host", Token: "synthetic-token", HTTP: srv.Client()}
					item, err := action.call(c)
					id := <-ids
					if tc.wantError == "" {
						if err != nil {
							t.Fatalf("matching ACK rejected: %v", err)
						}
						if action.name == "Begin" && item != "SYN-1" {
							t.Fatalf("Begin lost work_item_id: %q", item)
						}
					} else {
						if err == nil || !strings.Contains(err.Error(), tc.wantError) {
							t.Fatalf("expected %q for event %s, got item=%q err=%v", tc.wantError, id, item, err)
						}
						if action.name == "Begin" && item != "" {
							t.Fatalf("unconfirmed Begin returned item %q", item)
						}
						if tc.wantError == "未确认" && !strings.Contains(err.Error(), id) {
							t.Fatalf("unconfirmed error lacks this event ID: %v", err)
						}
					}
				})
			}
		})
	}
}
