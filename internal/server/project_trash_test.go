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

func TestProjectTrashPanelAuthorizationAndRestoration(t *testing.T) {
	ts, c, _ := start(t)
	ctx := context.Background()
	if _, err := c.Ingest(ctx, &event.Event{EventID: "trash-seed", SchemaVersion: 1, OccurredAt: time.Now(), Source: event.Source{Provider: "codex", HostID: "synthetic"}, Kind: event.KindSessionStart, SessionID: "trash-test", Cwd: "/r"}); err != nil {
		t.Fatal(err)
	}
	p, _ := c.Projects(ctx)
	id := p[0].ID
	for _, withCookie := range []bool{false, true} {
		req, _ := http.NewRequest("POST", ts.URL+"/api/projects/trash", strings.NewReader(`{"ids":[1],"trashed":true}`))
		req.Header.Set("Authorization", "Bearer ing")
		want := 401
		if withCookie {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
			want = 403
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != want {
			t.Fatal(resp.StatusCode, want)
		}
	}
	if code, _ := panelReq(t, ts, "POST", "/api/projects/trash", map[string]any{"ids": []int64{id}}); code != 400 {
		t.Fatal(code)
	}
	for _, trash := range []bool{true, false} {
		code, body := panelReq(t, ts, "POST", "/api/projects/trash", map[string]any{"ids": []int64{id}, "trashed": trash})
		if code != 200 {
			t.Fatal(code, string(body))
		}
		code, body = panelReq(t, ts, "GET", "/api/snapshot", nil)
		var s core.Snapshot
		if code != 200 || json.Unmarshal(body, &s) != nil || (len(s.Repos) == 0) != trash {
			t.Fatal(code, string(body))
		}
	}
	h := remoteServer(t, []string{rh})
	if w := do(h, rq{method: "POST", host: rh, path: "/api/projects/trash", cookie: remoteCookie, value: "rem", origin: "https://" + rh, steward: true}); w.Code != 403 {
		t.Fatal("remote viewer deleted local projects", w.Code)
	}
}
