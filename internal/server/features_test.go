package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/hook"
	"github.com/xoqiu09/session-steward/internal/store"
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

func TestStaleFeatureAcceptanceKeepsChangesRequested(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "features.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := core.New(st, loc{})
	h := (&Server{Core: c, PanelToken: "pan"}).Handler()
	ctx := context.Background()
	st.Now = func() time.Time { return time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC) }
	e := event.Event{EventID: "feature-begin", SchemaVersion: 1, OccurredAt: st.Now().Add(-time.Minute),
		Source: event.Source{Provider: "claude", HostID: "local"}, Kind: event.KindBegin, SessionID: "feature-review", Cwd: "/r", WorkTitle: "Synthetic export"}
	if _, err := c.Ingest(ctx, &e); err != nil {
		t.Fatal(err)
	}
	e.EventID, e.Kind, e.OccurredAt = "feature-report", event.KindFeatures, st.Now()
	e.Features = &event.FeatureBatch{ScopeStatus: "documented", ScopeBasis: "Synthetic spec", Features: []event.FeatureUpdate{
		{ID: "export", Title: "Synthetic export", Candidate: "sha-one", Implementation: "implemented"},
	}}
	if _, err := c.Ingest(ctx, &e); err != nil {
		t.Fatal(err)
	}
	read := func() core.ProjectFeature {
		t.Helper()
		w := liveDo(h, "GET", local, "/api/snapshot", cookieName, "pan", "", false)
		var snap struct{ Features []core.ProjectFeature }
		if err := json.Unmarshal(w.Body.Bytes(), &snap); w.Code != http.StatusOK || err != nil || len(snap.Features) != 1 {
			t.Fatalf("读取待验收功能失败：HTTP %d，%s，%v", w.Code, w.Body, err)
		}
		return snap.Features[0]
	}
	decide := func(f core.ProjectFeature, decision string, wantCode int) {
		t.Helper()
		path := fmt.Sprintf("/api/features/%d/%s/accept", f.RepoID, f.ID)
		body := fmt.Sprintf(`{"candidate":%q,"revision":%q,"decision":%q}`, f.Candidate, f.Revision, decision)
		w := liveDo(h, "POST", local, path, cookieName, "pan", body, true)
		if w.Code != wantCode {
			t.Errorf("提交 %s：得到 HTTP %d，预期 HTTP %d，%s", decision, w.Code, wantCode, w.Body)
		}
	}
	pageOne, pageTwo := read(), read()
	if pageOne.Accepted || pageTwo.Accepted || pageOne.Revision == "" || pageOne.Revision != pageTwo.Revision {
		t.Fatal("两个页面应读到同一个待验收版本")
	}
	decide(pageOne, "accepted", http.StatusOK)
	pageOne = read()
	if !pageOne.Accepted {
		t.Fatal("第一个页面的验收未生效")
	}
	decide(pageOne, "changes_requested", http.StatusOK)
	returned := read()
	if returned.Accepted {
		t.Fatal("第一个页面的退回未生效")
	}
	decide(pageTwo, "accepted", http.StatusBadRequest)
	if after := read(); after.Accepted || after.Revision != returned.Revision {
		t.Error("旧页面的验收覆盖了退回决定")
	}
}
