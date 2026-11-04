package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/projectstructure"
)

func TestDemoUsesFreshDataAndNeverReusesExistingDirectories(t *testing.T) {
	ctx := context.Background()
	protected := t.TempDir()
	sentinel := filepath.Join(protected, "steward.sqlite")
	if err := os.WriteFile(sentinel, []byte("keep existing data"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("STEWARD_HOME", protected)
	for _, address := range []string{"0.0.0.0:0", "localhost:0", "127.0.0.1:-1", "127.0.0.1:65536"} {
		fresh := filepath.Join(t.TempDir(), "unused")
		if _, err := prepareDemo(ctx, fresh, address); err == nil {
			t.Fatalf("unsafe address accepted: %s", address)
		}
		if _, err := os.Stat(fresh); !os.IsNotExist(err) {
			t.Fatal("address rejection created a data directory")
		}
	}
	if _, err := prepareDemo(ctx, protected, "127.0.0.1:0"); err == nil {
		t.Fatal("existing data directory accepted")
	}
	link := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(protected, link); err != nil {
		t.Fatal(err)
	}
	if _, err := prepareDemo(ctx, link, "127.0.0.1:0"); err == nil {
		t.Fatal("existing symlink accepted")
	}
	if _, err := prepareDemo(ctx, "relative-demo", "127.0.0.1:0"); err == nil {
		t.Fatal("relative path accepted")
	}
	if _, err := prepareDemo(ctx, filepath.Join(t.TempDir(), "missing", "demo"), "127.0.0.1:0"); err == nil || !strings.Contains(err.Error(), "父目录") {
		t.Fatal("missing parent not explained", err)
	}
	fresh := filepath.Join(t.TempDir(), "new demo with spaces")
	instance, err := prepareDemo(ctx, fresh, "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer instance.close()
	got, err := os.ReadFile(sentinel)
	if err != nil || string(got) != "keep existing data" {
		t.Fatal("demo touched the selected STEWARD_HOME", err)
	}
	entries, _ := os.ReadDir(protected)
	if len(entries) != 1 {
		t.Fatal("demo created files in STEWARD_HOME")
	}
	if instance.core.Term != nil || instance.core.OrchExecutor != nil || instance.server.Dispatch != nil || instance.server.HookCoverage != nil || instance.server.Hub != nil || len(instance.core.Agents) != 0 || instance.core.AutoMerge {
		t.Fatal("demo acquired real execution or discovery capabilities")
	}
	for _, name := range []string{"ingest.token", "panel.token"} {
		info, err := os.Stat(filepath.Join(instance.dir, name))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatal("demo token not private", name, err)
		}
	}
}

func TestDemoFirstProjectStructureFlowUsesExistingContracts(t *testing.T) {
	ctx := context.Background()
	instance, err := prepareDemo(ctx, filepath.Join(t.TempDir(), "demo"), "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer instance.close()
	before, err := instance.core.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Repos) != 3 || len(before.Features) != 9 || len(before.Structures) != 2 || len(before.WorkItems) != 3 {
		t.Fatalf("unexpected demo shape: repos=%d features=%d structures=%d tasks=%d", len(before.Repos), len(before.Features), len(before.Structures), len(before.WorkItems))
	}
	var assetRepo int64
	for _, r := range before.Repos {
		if !strings.HasPrefix(r.Name, "示例-") || !strings.HasPrefix(r.CommonDir, "dir:"+instance.dir+string(os.PathSeparator)) {
			t.Fatal("non-synthetic project in demo", r)
		}
		if r.Name == "示例-素材册" {
			assetRepo = r.ID
		}
	}
	for _, session := range before.Sessions {
		if session.ResumeCommand != "" {
			t.Fatal("fictional session offers a real Agent resume command", session.ResumeCommand)
		}
	}
	if before.ManagedNote == "" {
		t.Fatal("demo does not explain why Agents cannot be started")
	}
	for _, f := range before.Features {
		if f.Accepted || len(f.Contributions) == 0 {
			t.Fatal("synthetic Agent report became real acceptance", f)
		}
		for _, report := range f.Contributions {
			if !strings.Contains(report.Evidence, "合成") {
				t.Fatal("sample report missing its synthetic label", report)
			}
		}
	}
	for _, s := range before.Structures {
		seen := map[string]bool{}
		for _, g := range s.Document.Groups {
			for _, f := range g.Features {
				if seen[f.ID] {
					t.Fatal("duplicate primary group", f.ID)
				}
				seen[f.ID] = true
			}
		}
		for _, f := range before.Features {
			if f.RepoID == s.RepoID && !seen[f.ID] {
				t.Fatal("unmapped sample feature", f.ID)
			}
		}
	}
	// This is the same portable JSON users import in the first-use walkthrough.
	raw, err := os.ReadFile("../../examples/project-structure/asset-library.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = projectstructure.Decode(raw); err != nil {
		t.Fatal(err)
	}
	manual, err := instance.core.SaveProjectStructure(ctx, assetRepo, raw, "", "user")
	if err != nil {
		t.Fatal(err)
	}
	after, _ := instance.core.Snapshot(ctx)
	if len(after.Structures) != 3 || !reflect.DeepEqual(before.Features, after.Features) || !reflect.DeepEqual(before.WorkItems, after.WorkItems) || !reflect.DeepEqual(before.Approvals, after.Approvals) {
		t.Fatal("import changed progress, acceptance or requests")
	}
	if _, err = instance.core.SaveProjectStructure(ctx, assetRepo, raw, manual.Revision, "agent"); err == nil {
		t.Fatal("Agent overwrote the user's directory")
	}
	api := httptest.NewServer(instance.handler(context.Background()))
	defer api.Close()
	response, err := http.Get(api.URL + "/api/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatal("demo API is unauthenticated", response.StatusCode)
	}
	for _, path := range []string{"/hook/ping", "/api/sessions/1/conversation"} {
		request, _ := http.NewRequest("GET", api.URL+path, nil)
		request.AddCookie(&http.Cookie{Name: "steward_panel", Value: instance.server.PanelToken})
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatal("demo exposed live hooks or the real conversation resolver", path, response.StatusCode)
		}
	}
}

type demoReadyWriter struct {
	ready chan struct{}
	once  sync.Once
}

func (w *demoReadyWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.ready) })
	return len(p), nil
}

func TestDemoServerStopsWithoutLeavingListener(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "demo")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := &demoReadyWriter{ready: make(chan struct{})}
	done := make(chan error, 1)
	go func() { done <- runDemo(ctx, dir, "127.0.0.1:0", false, w) }()
	select {
	case <-w.ready:
	case err := <-done:
		t.Fatal("demo exited before readiness", err)
	case <-time.After(5 * time.Second):
		t.Fatal("demo did not start")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	var configuration struct{ Listen string }
	if err := json.Unmarshal(raw, &configuration); err != nil {
		t.Fatal(err)
	}
	token, err := os.ReadFile(filepath.Join(dir, "panel.token"))
	if err != nil {
		t.Fatal(err)
	}
	request, _ := http.NewRequest("GET", "http://"+configuration.Listen+"/api/version", nil)
	request.AddCookie(&http.Cookie{Name: "steward_panel", Value: strings.TrimSpace(string(token))})
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatal(response.StatusCode)
	}
	// An open browser tab keeps an event stream; it must not delay shutdown.
	stream, _ := http.NewRequest("GET", "http://"+configuration.Listen+"/api/stream", nil)
	stream.AddCookie(&http.Cookie{Name: "steward_panel", Value: strings.TrimSpace(string(token))})
	streaming, err := http.DefaultClient.Do(stream)
	if err != nil {
		t.Fatal(err)
	}
	defer streaming.Body.Close()
	go io.Copy(io.Discard, streaming.Body)
	stopping := time.Now()
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("demo did not stop")
	}
	if elapsed := time.Since(stopping); elapsed > 2*time.Second {
		t.Fatal("open event stream delayed shutdown", elapsed)
	}
	if conn, err := net.DialTimeout("tcp", configuration.Listen, time.Second); err == nil {
		conn.Close()
		t.Fatal("demo listener survived shutdown")
	}
}
