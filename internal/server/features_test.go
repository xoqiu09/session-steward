package server

import (
	"context"
	"encoding/json"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/hook"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestFeatureReportReadSnapshotAndPanelAcceptance(t *testing.T) {
	ts, c, _ := start(t)
	ctx := context.Background()
	client := &hook.Client{BaseURL: ts.URL, Token: "ing", HostID: "local"}
	e := &event.Event{EventID: "feature-session", SchemaVersion: 1, OccurredAt: time.Now().Add(-time.Second), Source: event.Source{Provider: "claude", HostID: "local"}, Kind: event.KindSessionStart, SessionID: "feature-flow", Cwd: "/r"}
	if _, err := c.Ingest(ctx, e); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Begin(ctx, "Synthetic export", "", map[string]string{"goal": "export"}, "claude", "feature-flow", "/r"); err != nil {
		t.Fatal(err)
	}
	b := &event.FeatureBatch{ScopeStatus: "documented", ScopeBasis: "Synthetic spec", Features: []event.FeatureUpdate{{ID: "export", Title: "Synthetic export", Candidate: "sha-one", Implementation: "implemented", Validation: "not_verified"}}}
	if err := client.Features(ctx, b, "claude", "feature-flow", "/r"); err != nil {
		t.Fatal(err)
	}
	list, err := client.ListFeatures(ctx, "claude", "feature-flow", "/r")
	if err != nil || !strings.Contains(string(list), "Synthetic export") {
		t.Fatalf("list %s %v", list, err)
	}
	if _, err = client.ListFeatures(ctx, "claude", "missing", "/r"); err == nil {
		t.Fatal("unknown session read project features")
	}
	code, body := panelReq(t, ts, "GET", "/api/snapshot", nil)
	if code != 200 {
		t.Fatal(code)
	}
	var snap struct {
		Features []struct {
			RepoID    int64  `json:"repo_id"`
			ID        string `json:"id"`
			Candidate string `json:"candidate"`
			Revision  string `json:"revision"`
			Accepted  bool   `json:"accepted"`
		}
	}
	if err = json.Unmarshal(body, &snap); err != nil || len(snap.Features) != 1 {
		t.Fatalf("snapshot %s %v", body, err)
	}
	f := snap.Features[0]
	if f.Accepted {
		t.Fatal("Agent implicitly accepted feature")
	}
	endpoint := ts.URL + "/api/features/1/export/accept"
	req, _ := http.NewRequest("POST", endpoint, strings.NewReader(`{}`))
	req.Header.Set("Authorization", "Bearer ing")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("ingest credential accepted as user")
	}
	code, body = panelReq(t, ts, "POST", "/api/features/1/export/accept", map[string]string{"candidate": f.Candidate, "revision": f.Revision, "decision": "accepted"})
	if code != 200 {
		t.Fatalf("accept %d %s", code, body)
	}
	s, err := c.Snapshot(ctx)
	if err != nil || !s.Features[0].Accepted {
		t.Fatal("explicit acceptance not reflected")
	}
}
