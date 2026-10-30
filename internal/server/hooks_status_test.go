package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/install"
)

func TestHookCoverageRequiresPanelAuthAndIsReadOnly(t *testing.T) {
	ts, _, server := start(t)
	var calls atomic.Int32
	server.HookCoverage = func(context.Context) []install.Coverage {
		calls.Add(1)
		return []install.Coverage{{Provider: "claude", Version: "2.1.310", Installed: []string{"Stop"}, Missing: []string{"CwdChanged"}, Skipped: []string{}}}
	}
	for _, auth := range []string{"none", "ingest", "wrong"} {
		req, _ := http.NewRequest("GET", ts.URL+"/api/hooks/status", nil)
		if auth == "ingest" {
			req.Header.Set("Authorization", "Bearer ing")
		}
		if auth == "wrong" {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: "wrong"})
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatalf("%s status=%d", auth, resp.StatusCode)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("Unauthenticated requests probed local clients")
	}
	status, body := panelReq(t, ts, "GET", "/api/hooks/status", nil)
	if status != 200 || !strings.Contains(string(body), "CwdChanged") || calls.Load() != 1 {
		t.Fatalf("status=%d body=%s calls=%d", status, body, calls.Load())
	}
	if status, _ := panelReq(t, ts, "POST", "/api/hooks/status", nil); status != 405 {
		t.Fatalf("Status endpoint accepted write: %d", status)
	}
}

func TestSlowHookVersionProbeDoesNotHoldSnapshotOrCore(t *testing.T) {
	ts, _, server := start(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	server.HookCoverage = func(ctx context.Context) []install.Coverage {
		close(entered)
		select {
		case <-release:
		case <-ctx.Done():
		}
		return []install.Coverage{}
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		req, _ := http.NewRequest("GET", ts.URL+"/api/hooks/status", nil)
		req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	}()
	<-entered
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", ts.URL+"/api/snapshot", nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	response, err := http.DefaultClient.Do(req)
	status := 0
	if err == nil {
		status = response.StatusCode
		response.Body.Close()
	}
	close(release)
	<-done
	if err != nil || status != 200 {
		t.Fatal("Slow version probe blocked normal snapshot")
	}
}
