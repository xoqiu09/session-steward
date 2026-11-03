package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/hook"
)

func TestStructureHookAndPanelAuthority(t *testing.T) {
	ts, c, s := start(t)
	ctx := context.Background()
	client := &hook.Client{BaseURL: ts.URL, Token: "ing", HostID: "local"}
	e := &event.Event{EventID: "structure-session", SchemaVersion: 1, OccurredAt: time.Now().Add(-time.Second), Source: event.Source{Provider: "codex", HostID: "local"}, Kind: event.KindSessionStart, SessionID: "structure-flow", Cwd: "/r"}
	if _, err := c.Ingest(ctx, e); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Begin(ctx, "Synthetic description", "", map[string]string{"goal": "Describe"}, "codex", "structure-flow", "/r"); err != nil {
		t.Fatal(err)
	}
	b := &event.FeatureBatch{ScopeStatus: "documented", ScopeBasis: "Synthetic spec", Features: []event.FeatureUpdate{{ID: "export", Title: "Synthetic export", Implementation: "not_started"}}}
	if err := client.Features(ctx, b, "codex", "structure-flow", "/r"); err != nil {
		t.Fatal(err)
	}
	raw := json.RawMessage(`{"schema_version":1,"goal":"Synthetic tool","audience":"Operator","scope":"Export","prepared_at":"2026-11-03","basis_version":"synthetic-sha","groups":[{"id":"output","title":"Results","question":"What is produced?","features":[{"id":"export"}]}],"relations":[],"sources":[]}`)
	out, err := client.ProjectStructure(ctx, "write", "codex", "structure-flow", "/r", "", raw)
	if err != nil {
		t.Fatal(err)
	}
	var res struct {
		Structure core.ProjectStructure `json:"structure"`
	}
	if json.Unmarshal(out, &res) != nil || res.Structure.Author != "agent" {
		t.Fatal(string(out))
	}
	path := fmt.Sprintf("/api/projects/%d/structure", res.Structure.RepoID)
	code, body := panelReq(t, ts, "PUT", path, map[string]any{"base_revision": res.Structure.Revision, "document": raw, "origin": "agent"})
	if code != 200 || json.Unmarshal(body, &res) != nil || res.Structure.Author != "agent" {
		t.Fatal("Agent suggestion mislabelled", code, string(body))
	}
	spoof, _ := http.NewRequest("POST", ts.URL+"/hook/structure/read", strings.NewReader(`{"provider":"codex","session":"structure-flow","host":"local","cwd":"/r","origin":"user"}`))
	spoof.Header.Set("Authorization", "Bearer ing")
	spoofResp, err := http.DefaultClient.Do(spoof)
	if err != nil {
		t.Fatal(err)
	}
	spoofResp.Body.Close()
	if spoofResp.StatusCode != 400 {
		t.Fatal("Hook overrode source authority", spoofResp.StatusCode)
	}
	resp, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatal("unauthed read", resp.StatusCode)
	}
	for _, token := range []string{"", "ing"} {
		req, _ := http.NewRequest("PUT", ts.URL+path, strings.NewReader(`{}`))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		} else {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
		}
		resp, err = http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 && resp.StatusCode != 403 {
			t.Fatal("wrong credential or missing CSRF accepted", resp.StatusCode)
		}
	}
	if _, err = client.ProjectStructure(ctx, "read", "codex", "missing", "/r", "", nil); err == nil {
		t.Fatal("unknown session read another project")
	}
	code, body = panelReq(t, ts, "PUT", path, map[string]any{"base_revision": res.Structure.Revision, "document": raw, "accepted": true})
	if code != 400 {
		t.Fatal("status field accepted", code, string(body))
	}
	code, body = panelReq(t, ts, "PUT", path, map[string]any{"base_revision": res.Structure.Revision, "document": raw})
	if code != 200 {
		t.Fatal(code, string(body))
	}
	json.Unmarshal(body, &res)
	if res.Structure.Author != "user" {
		t.Fatal("panel edit not protected")
	}
	if _, err = client.ProjectStructure(ctx, "write", "codex", "structure-flow", "/r", res.Structure.Revision, raw); err == nil {
		t.Fatal("Agent replaced user edits")
	}
	code, _ = panelReq(t, ts, "PUT", path, map[string]any{"base_revision": "old", "document": raw})
	if code != 409 {
		t.Fatal("late write accepted", code)
	}
	s.RemoteHosts = []string{"remote.example.test"}
	s.RemoteToken = "remote"
	req, _ := http.NewRequest("PUT", ts.URL+path, strings.NewReader(`{}`))
	req.Host = "remote.example.test"
	req.AddCookie(&http.Cookie{Name: remoteCookie, Value: "remote"})
	req.Header.Set("X-Steward", "1")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatal("remote write allowed", resp.StatusCode)
	}
	snap, err := c.Snapshot(ctx)
	if err != nil || len(snap.Features) != 1 || snap.Features[0].Implementation != "not_started" || snap.Features[0].Accepted {
		t.Fatal("metadata changed business state", err)
	}
}
