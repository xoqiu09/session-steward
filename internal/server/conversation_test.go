package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/conversation"
	"github.com/xoqiu09/session-steward/internal/event"
)

func TestConversationLinkIsLocalPanelReadOnly(t *testing.T) {
	ts, c, _ := start(t)
	ctx := context.Background()
	const sessionID = "11111111-2222-4333-8444-555555555555"
	_, err := c.Ingest(ctx, &event.Event{EventID: "synthetic-conversation", SchemaVersion: 1, OccurredAt: time.Now(), Source: event.Source{Provider: "codex", HostID: "local", Client: "desktop"}, Kind: event.KindSessionStart, SessionID: sessionID, Cwd: "/r"})
	if err != nil {
		t.Fatal(err)
	}
	before, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/sessions/" + strconv.FormatInt(before.Sessions[0].ID, 10) + "/conversation"
	code, body := panelReq(t, ts, "GET", endpoint, nil)
	var target conversation.Target
	if json.Unmarshal(body, &target) != nil || code != 200 || target.URL != "codex://threads/"+sessionID {
		t.Fatalf("%d %s", code, body)
	}
	after, _ := c.Snapshot(ctx)
	if before.Cursor != after.Cursor || len(after.WorkItems) != len(before.WorkItems) {
		t.Fatal("navigation mutated business data")
	}
	req, _ := http.NewRequest("GET", ts.URL+endpoint, nil)
	req.Header.Set("Authorization", "Bearer ing")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("ingest credential read desktop metadata: %d", resp.StatusCode)
	}
	for _, path := range []string{"/api/sessions/0/conversation", "/api/sessions/9999/conversation"} {
		code, _ := panelReq(t, ts, "GET", path, nil)
		if code != 400 && code != 404 {
			t.Fatal(code)
		}
	}
	h := remoteServer(t, []string{rh})
	if w := do(h, rq{method: "GET", host: rh, path: endpoint, cookie: remoteCookie, value: "rem"}); w.Code != 403 {
		t.Fatalf("remote received local conversation metadata: %d", w.Code)
	}
}
