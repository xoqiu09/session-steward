package hook

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestRejectedBeginDoesNotLookOfflineAndReportStillWorks(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var e event.Event
		if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if e.Kind == event.KindBegin {
			w.WriteHeader(http.StatusConflict)
			w.Write([]byte(`{"error":"当前会话已关联 TEST-1，继续当前工作请用 report"}`))
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"acked": []string{e.EventID}})
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, HostID: "test"}
	_, err := c.Begin(context.Background(), "another title", "/repo", nil, "claude", "s", "/repo")
	if err == nil || strings.Contains(err.Error(), "服务不可用") || !strings.Contains(err.Error(), "report") {
		t.Fatalf("misleading conflict: %v", err)
	}
	if err := c.Report(context.Background(), map[string]string{"progress": "actual progress"}, "claude", "s", "/repo"); err != nil {
		t.Fatalf("report should work after conflict: %v", err)
	}
	srv.Close()
	if err := c.Report(context.Background(), map[string]string{"progress": "actual progress"}, "claude", "s", "/repo"); err == nil || !strings.Contains(err.Error(), "服务不可用") {
		t.Fatalf("offline should remain clear: %v", err)
	}
}
