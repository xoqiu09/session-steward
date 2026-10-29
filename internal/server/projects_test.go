package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
)

func TestProjectManagementAuthArchiveAndRestore(t *testing.T) {
	ts, c, _ := start(t)
	e := &event.Event{EventID: "project-seed", SchemaVersion: 1, OccurredAt: time.Now(), Source: event.Source{Provider: "codex", HostID: "synthetic"}, Kind: event.KindSessionStart, SessionID: "synthetic", Cwd: "/r"}
	if _, err := c.Ingest(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/api/projects", "/api/merge-sync"} {
		resp, err := http.Get(ts.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatal(path, "requires auth", resp.StatusCode)
		}
	}
	req, _ := http.NewRequest("POST", ts.URL+"/api/projects/archive", strings.NewReader(`{"ids":[1],"archived":true}`))
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("archive accepted without CSRF header")
	}
	code, b := panelReq(t, ts, "GET", "/api/projects", nil)
	var projects []core.ProjectInfo
	if code != 200 || json.Unmarshal(b, &projects) != nil || len(projects) != 1 {
		t.Fatal(code, string(b))
	}
	id := projects[0].ID
	code, b = panelReq(t, ts, "POST", "/api/projects/archive", map[string]any{"ids": []int64{id}})
	if code != 400 {
		t.Fatal("omitted archive action accepted", code, string(b))
	}
	for _, archived := range []bool{true, false} {
		code, b = panelReq(t, ts, "POST", "/api/projects/archive", map[string]any{"ids": []int64{id}, "archived": archived})
		if code != 200 {
			t.Fatal(code, string(b))
		}
		code, b = panelReq(t, ts, "GET", "/api/snapshot", nil)
		var snap core.Snapshot
		if code != 200 || json.Unmarshal(b, &snap) != nil {
			t.Fatal(code, string(b))
		}
		if (len(snap.Repos) == 0) != archived {
			t.Fatal("visibility", archived, string(b))
		}
	}
}
