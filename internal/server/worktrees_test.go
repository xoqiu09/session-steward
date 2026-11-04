package server

import (
	"net/http"
	"strings"
	"testing"
)

func TestWorktreeRoutesStayLocalAndAuthenticated(t *testing.T) {
	ts, _, _ := start(t)
	// Unauthenticated.
	resp, err := http.Get(ts.URL + "/api/projects/1/worktrees")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatal("worktree list without panel login", resp.StatusCode)
	}
	// Forwarded (remote browsing through a proxy) is refused before touching Git.
	req, _ := http.NewRequest("POST", ts.URL+"/api/projects/1/worktrees/remove", strings.NewReader(`{"path":"/synthetic"}`))
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	req.Header.Set("X-Steward", "1")
	req.Header.Set("X-Forwarded-For", "203.0.113.7")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatal("forwarded worktree removal not refused", resp.StatusCode)
	}
	if code, _ := panelReq(t, ts, "GET", "/api/projects/999/worktrees", nil); code != http.StatusNotFound {
		t.Fatal("unknown project", code)
	}
	if code, _ := panelReq(t, ts, "POST", "/api/projects/1/worktrees/remove", map[string]string{}); code != http.StatusBadRequest {
		t.Fatal("empty path accepted", code)
	}
}

func TestSnapshotReportsDispatchAvailability(t *testing.T) {
	ts, _, s := start(t)
	code, body := panelReq(t, ts, "GET", "/api/snapshot", nil)
	if code != http.StatusOK || !strings.Contains(string(body), `"dispatch_available":false`) {
		t.Fatal("snapshot without a dispatch desk should say so", code)
	}
	_ = s
}
