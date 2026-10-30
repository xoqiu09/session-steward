package server

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestPanelSignalUsesUserChannelOnlyAfterAuthorizedSuccessfulChange(t *testing.T) {
	ts, c, _ := start(t)
	_, err := c.Ingest(context.Background(), &event.Event{EventID: "synthetic", SessionID: "synthetic", SchemaVersion: 1, Source: event.Source{Provider: "claude", HostID: "synthetic"}, Kind: event.KindSessionStart, OccurredAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if code, b := panelReq(t, ts, "POST", "/api/work-items", map[string]any{"id": "SIG-1", "title": "Synthetic"}); code != 201 {
		t.Fatalf("%d %s", code, b)
	}
	var body string
	c.St.R().QueryRow(`SELECT body FROM events WHERE kind='user_action'`).Scan(&body)
	var e event.Event
	if err := json.Unmarshal([]byte(body), &e); err != nil || e.Source.Channel != "user" || e.Source.Ref != "panel:work_item.create" {
		t.Fatalf("%s %v", body, err)
	}
	if code, _ := panelReq(t, ts, "GET", "/api/snapshot", nil); code != 200 {
		t.Fatal(code)
	}
	var count int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&count)
	if count != 1 {
		t.Fatal("user edit fabricated a session")
	}
	if code, _ := panelReq(t, ts, "PATCH", "/api/work-items/MISSING-1", map[string]any{"title": "should fail"}); code != 404 {
		t.Fatal(code)
	}
	c.St.R().QueryRow(`SELECT COUNT(*) FROM events WHERE kind='user_action'`).Scan(&count)
	if count != 1 {
		t.Fatal("failed operation audited")
	}
}
