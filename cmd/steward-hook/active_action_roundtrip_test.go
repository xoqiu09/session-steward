package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/hook"
	"github.com/xoqiu09/session-steward/internal/server"
	"github.com/xoqiu09/session-steward/internal/store"
)

type actionFixtureLocator struct{ project string }

func (l actionFixtureLocator) Locate(context.Context, string) gitx.Location {
	return gitx.Location{IsGit: true, CommonDir: filepath.Join(l.project, ".git"), Worktree: l.project, RepoName: "synthetic"}
}

type actionExchange struct {
	Method   string `json:"method"`
	Path     string `json:"path"`
	Request  string `json:"request"`
	Status   int    `json:"status"`
	Response string `json:"response"`
}

// Only this optional evidence path is read from the environment; identities are explicit fixtures.
func TestActiveActionRoundTripCoreSQLite(t *testing.T) {
	root := t.TempDir()
	if base := os.Getenv("SS_ACTIVE_ACTION_EVIDENCE_DIR"); base != "" {
		root = filepath.Join(base, t.Name())
		if _, err := os.Stat(root); !os.IsNotExist(err) {
			t.Fatal("evidence path exists or cannot be checked; refusing overwrite")
		}
		if err := os.MkdirAll(root, 0700); err != nil {
			t.Fatal(err)
		}
	}
	persist := func(name string, value any) {
		t.Helper()
		b, err := json.MarshalIndent(value, "", "  ")
		if err == nil {
			err = os.WriteFile(filepath.Join(root, name), append(b, '\n'), 0600)
		}
		if err != nil {
			t.Errorf("evidence %s: %v", name, err)
		}
	}
	project := filepath.Join(root, "fixture_home", "project")
	if err := os.MkdirAll(project, 0700); err != nil {
		t.Fatal(err)
	}
	dbPath := filepath.Join(root, "synthetic.sqlite")
	st, err := store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	c := core.New(st, actionFixtureLocator{project})
	c.Term = nil
	c.Agents = nil
	c.Checks = nil
	c.AutoMerge = false
	c.SummaryCmd = nil
	c.SummaryRepos = nil
	c.SummaryRun = nil
	c.StewardHome = filepath.Join(root, "fixture_home")
	c.WorktreeRoot = filepath.Join(root, "unused-worktrees")
	var mu sync.Mutex
	var exchanges []actionExchange
	var actions []map[string]any
	resources := map[string]any{"scope": "synthetic CLI handler/Core/Server/SQLite only", "pid": os.Getpid(), "database": dbPath, "fixture_home": filepath.Dir(project), "term_nil": c.Term == nil, "agents_nil": c.Agents == nil, "checks_nil": c.Checks == nil, "auto_merge": c.AutoMerge, "summary_disabled": len(c.SummaryCmd) == 0, "config_entrypoints_called": false}
	s := &server.Server{Core: c, IngestToken: "synthetic-ingest", PanelToken: "synthetic-panel", PermWait: time.Second}
	realHandler := s.Handler()
	observer := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		input, readErr := io.ReadAll(r.Body)
		if readErr != nil {
			t.Error(readErr)
			http.Error(w, "synthetic request read failure", 400)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(input))
		rec := httptest.NewRecorder()
		realHandler.ServeHTTP(rec, r)
		mu.Lock()
		exchanges = append(exchanges, actionExchange{r.Method, r.URL.Path, string(input), rec.Code, rec.Body.String()})
		mu.Unlock()
		for k, values := range rec.Header() {
			w.Header()[k] = append([]string(nil), values...)
		}
		w.WriteHeader(rec.Code)
		if _, err := w.Write(rec.Body.Bytes()); err != nil {
			t.Error(err)
		}
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		st.Close()
		t.Fatal(err)
	}
	if ln.Addr().(*net.TCPAddr).Port == 7788 {
		ln.Close()
		st.Close()
		t.Fatal("forbidden port7788 allocated")
	}
	ts := &httptest.Server{Listener: ln, Config: &http.Server{Handler: observer, ReadHeaderTimeout: time.Second}}
	ts.Start()
	address := ln.Addr().String()
	resources["address"] = address
	transport := &http.Transport{Proxy: nil, DialContext: func(ctx context.Context, network, target string) (net.Conn, error) {
		if target != address {
			return nil, errors.New("non-owned network target rejected")
		}
		return (&net.Dialer{}).DialContext(ctx, network, target)
	}}
	httpClient := &http.Client{Transport: transport, Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	client := &hook.Client{BaseURL: ts.URL, Token: "synthetic-ingest", HostID: "synthetic-host", HTTP: httpClient, Env: func(string) string { return "" }}
	serverClosed, storeClosed, reopenedClosed := false, false, false
	var reopened *store.Store
	closeServer := func() {
		if serverClosed {
			return
		}
		transport.CloseIdleConnections()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := ts.Config.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		ts.Close()
		conn, dialErr := net.DialTimeout("tcp", address, 200*time.Millisecond)
		if conn != nil {
			conn.Close()
		}
		if dialErr == nil {
			t.Error("owned listener still reachable")
		}
		resources["listener_closed"] = dialErr != nil
		serverClosed = true
	}
	closeStore := func() {
		if !storeClosed {
			err := st.Close()
			resources["store_close_error"] = errorText(err)
			if err != nil {
				t.Error(err)
			}
			storeClosed = true
			resources["store_closed"] = err == nil
		}
	}
	t.Cleanup(func() {
		closeServer()
		closeStore()
		if reopened != nil && !reopenedClosed {
			err := reopened.Close()
			resources["reopened_store_closed"] = err == nil
			if err != nil {
				t.Error(err)
			}
		}
		resources["test_failed"] = t.Failed()
		resources["cleanup_at"] = time.Now().UTC()
		mu.Lock()
		saved := append([]actionExchange(nil), exchanges...)
		mu.Unlock()
		persist("exchanges.json", saved)
		persist("cli-results.json", actions)
		persist("resources.json", resources)
	})
	persist("resources-start.json", resources)
	request := func(method, path string, body any) []byte {
		t.Helper()
		b, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequest(method, ts.URL+path, bytes.NewReader(b))
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(path, "/hook/") {
			req.Header.Set("Authorization", "Bearer synthetic-ingest")
		} else {
			req.AddCookie(&http.Cookie{Name: "steward_panel", Value: "synthetic-panel"})
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := httpClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != 200 {
			t.Fatalf("%s: status=%d err=%v body=%s", path, resp.StatusCode, err, data)
		}
		return data
	}
	snapshot := func(name string) *core.Snapshot {
		t.Helper()
		var snap core.Snapshot
		if err := json.Unmarshal(request("GET", "/api/snapshot", nil), &snap); err != nil {
			t.Fatal(err)
		}
		persist(name, &snap)
		return &snap
	}
	invoke := func(label string, wantSuccess bool, fn func() int) {
		t.Helper()
		mu.Lock()
		before := len(exchanges)
		mu.Unlock()
		code := fn()
		mu.Lock()
		observed := append([]actionExchange(nil), exchanges[before:]...)
		mu.Unlock()
		if len(observed) != 1 || observed[0].Path != "/hook/agent-action" {
			t.Fatalf("%s did not make one actual active-action request: %+v", label, observed)
		}
		var sent event.Event
		var reply struct {
			Acked    []string            `json:"acked"`
			Rejected []map[string]string `json:"rejected"`
			Item     string              `json:"work_item_id"`
		}
		if err := json.Unmarshal([]byte(observed[0].Request), &sent); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(observed[0].Response), &reply); err != nil {
			t.Fatal(err)
		}
		matched := false
		for _, id := range reply.Acked {
			if id == sent.EventID {
				matched = true
			}
		}
		actions = append(actions, map[string]any{"label": label, "cli_exit_code": code, "http_status": observed[0].Status, "event_id": sent.EventID, "acked": reply.Acked, "rejected": reply.Rejected, "exact_ack": matched, "work_item_id_response": reply.Item, "synthetic_session": sent.SessionID})
		if wantSuccess {
			if code != 0 || !matched || len(reply.Rejected) > 0 {
				t.Fatalf("%s not confirmed: code=%d ACK=%+v", label, code, reply)
			}
		} else if code == 0 || len(reply.Rejected) == 0 || matched {
			t.Fatalf("%s rejection not propagated: code=%d ACK=%+v", label, code, reply)
		}
	}
	for _, sid := range []string{"synthetic-A", "synthetic-B", "synthetic-unbound"} {
		request("POST", "/hook/event", &event.Event{EventID: "start-" + sid, SchemaVersion: 1, OccurredAt: time.Now().UTC(), Source: event.Source{Provider: "codex", HostID: "synthetic-host"}, Kind: event.KindSessionStart, SessionID: sid, Cwd: project})
	}
	identity := func(args []string, sid string) []string { return append(args, "--provider", "codex", "--session", sid) }
	invoke("begin-A", true, func() int {
		return report(context.Background(), client, identity([]string{"begin", "--title", "Synthetic implementation", "--project", project}, "synthetic-A"), false)
	})
	invoke("begin-B", true, func() int {
		return report(context.Background(), client, identity([]string{"begin", "--title", "Synthetic review", "--project", project}, "synthetic-B"), false)
	})
	snap := snapshot("snapshot-after-begin.json")
	if len(snap.WorkItems) != 2 || len(snap.Runs) != 2 || len(snap.Repos) != 1 {
		t.Fatalf("begin identities conflated: %+v", snap)
	}
	itemFor := func(s *core.Snapshot, title string) core.WorkItem {
		t.Helper()
		for _, w := range s.WorkItems {
			if w.Title == title {
				return w
			}
		}
		t.Fatalf("missing %s", title)
		return core.WorkItem{}
	}
	a, b := itemFor(snap, "Synthetic implementation"), itemFor(snap, "Synthetic review")
	if a.ID == b.ID || a.RepoID == nil || b.RepoID == nil || *a.RepoID != *b.RepoID {
		t.Fatal("same-project work identities not distinct")
	}
	sessionItems := map[int64]string{}
	for _, session := range snap.Sessions {
		if session.ProviderSessionID == "synthetic-A" {
			sessionItems[session.ID] = a.ID
		} else if session.ProviderSessionID == "synthetic-B" {
			sessionItems[session.ID] = b.ID
		}
	}
	for _, run := range snap.Runs {
		if sessionItems[run.SessionID] != run.WorkItemID {
			t.Fatalf("Run linked to wrong session/work item: %+v", run)
		}
	}
	invoke("report-B", true, func() int {
		return report(context.Background(), client, identity([]string{"report", "--summary", "B summary", "--progress", "B independent progress", "--blocker", "B sample missing", "--stage", "validating", "--next-owner", "agent"}, "synthetic-B"), false)
	})
	invoke("report-A", true, func() int {
		return report(context.Background(), client, identity([]string{"report", "--summary", "A summary", "--progress", "A progress", "--stage", "validating", "--next-owner", "agent"}, "synthetic-A"), false)
	})
	snap = snapshot("snapshot-after-report.json")
	a = itemFor(snap, a.Title)
	b = itemFor(snap, b.Title)
	value := func(w core.WorkItem, key string) string {
		if w.Brief == nil || w.Brief.Fields[key] == nil {
			return ""
		}
		return w.Brief.Fields[key].Text
	}
	if value(a, "summary") != "A summary" || value(a, "progress") != "A progress" || value(a, "stage") != "validating" || value(a, "next_owner") != "agent" || value(b, "progress") != "B independent progress" || value(b, "blocker") != "B sample missing" {
		t.Fatal("report fields missing or crossed work items")
	}
	featurePath := filepath.Join(root, "feature-v1.json")
	batch := event.FeatureBatch{ScopeStatus: "documented", ScopeBasis: "synthetic specification", Features: []event.FeatureUpdate{{ID: "synthetic-feature", Title: "Synthetic feature", Candidate: strings.Repeat("a", 40), Implementation: "implemented", Validation: "passed", Evidence: "synthetic fixture only; not independent acceptance"}}}
	persist("feature-v1.json", batch)
	invoke("features-A-v1", true, func() int {
		return features(context.Background(), client, identity([]string{"features", "--file", featurePath}, "synthetic-A"))
	})
	snap = snapshot("snapshot-feature-v1.json")
	if len(snap.Features) != 1 || snap.Features[0].Candidate != strings.Repeat("a", 40) || snap.Features[0].Validation != "passed" || snap.Features[0].Accepted {
		t.Fatal("feature implementation/validation conflated with Owner acceptance")
	}
	if len(snap.Features[0].Contributions) != 1 || snap.Features[0].Contributions[0].WorkItemID != a.ID || sessionItems[snap.Features[0].Contributions[0].SessionID] != a.ID {
		t.Fatal("feature provenance not tied to A")
	}
	p := snap.Features[0].Contributions[0]
	linked := false
	for _, r := range snap.Runs {
		if r.ID == p.RunID && r.SessionID == p.SessionID && r.WorkItemID == a.ID {
			linked = true
		}
	}
	if !linked {
		t.Fatal("feature run ID does not match its real Session/WorkItem")
	}
	batch.Features[0].Candidate = strings.Repeat("b", 40)
	batch.Features[0].Validation = ""
	batch.Features[0].Evidence = ""
	persist("feature-v2.json", batch)
	invoke("features-A-v2", true, func() int {
		return features(context.Background(), client, identity([]string{"features", "--file", filepath.Join(root, "feature-v2.json")}, "synthetic-A"))
	})
	snap = snapshot("snapshot-feature-v2.json")
	assertCandidateReset := func(s *core.Snapshot) {
		t.Helper()
		if len(s.Features) != 1 || s.Features[0].Candidate != strings.Repeat("b", 40) || s.Features[0].Validation != "unknown" || s.Features[0].Accepted {
			t.Fatal("new candidate retained old passed validation or claimed Owner acceptance")
		}
		if len(s.Features[0].Contributions) != 1 || s.Features[0].Contributions[0].Validation != "" || s.Features[0].Contributions[0].Evidence != "" || s.Features[0].Contributions[0].ValidationAt != "" {
			t.Fatal("new candidate retained old contribution validation, evidence or timestamp")
		}
	}
	assertCandidateReset(snap)
	invoke("deliver-A", true, func() int {
		return agentAction(context.Background(), client, identity([]string{"deliver", "--summary", "A summary", "--progress", "A progress", "--next", "Owner reviews synthetic artifacts"}, "synthetic-A"))
	})
	snap = snapshot("snapshot-after-deliver.json")
	a = itemFor(snap, a.Title)
	b = itemFor(snap, b.Title)
	if a.Status != "review" || value(a, "stage") != "review" || value(a, "next_owner") != "user" || b.Status == "review" || snap.Features[0].Accepted {
		t.Fatal("deliver crossed tasks or claimed Owner completion")
	}
	invoke("unbound-report", false, func() int {
		return report(context.Background(), client, identity([]string{"report", "--progress", "must not overwrite valid work"}, "synthetic-unbound"), false)
	})
	invoke("missing-work-claim", false, func() int {
		return agentAction(context.Background(), client, identity([]string{"claim", "GAP-999"}, "synthetic-unbound"))
	})
	snap = snapshot("snapshot-after-rejections.json")
	if len(snap.WorkItems) != 2 || len(snap.Runs) != 2 || value(itemFor(snap, a.Title), "progress") != "A progress" || value(itemFor(snap, b.Title), "blocker") != "B sample missing" {
		t.Fatal("rejected action overwrote valid data")
	}
	closeServer()
	closeStore()
	reopened, err = store.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := core.New(reopened, actionFixtureLocator{project}).Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	persist("snapshot-reopened-sqlite.json", stored)
	assertCandidateReset(stored)
	if len(stored.Runs) != 2 || itemFor(stored, a.Title).ID != a.ID || itemFor(stored, a.Title).Status != "review" || value(itemFor(stored, a.Title), "stage") != "review" || value(itemFor(stored, a.Title), "next_owner") != "user" || value(itemFor(stored, a.Title), "summary") != "A summary" || value(itemFor(stored, a.Title), "progress") != "A progress" || value(itemFor(stored, b.Title), "blocker") != "B sample missing" || stored.Features[0].Candidate != strings.Repeat("b", 40) || stored.Features[0].Accepted {
		t.Fatal("closed/reopened SQLite lost identity or state")
	}
	if err := reopened.Close(); err != nil {
		t.Fatal(err)
	}
	reopenedClosed = true
	resources["reopened_store_closed"] = true
	resources["owner_accepted"] = false
	resources["cli_actions"] = len(actions)
	resources["listener_was_random_loopback"] = true
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
