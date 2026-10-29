package server

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/xoqiu09/session-steward/internal/core"
)

func TestWorkManagementPanelAuthAndRoundTrip(t *testing.T) {
	ts, c, _ := start(t)
	ctx := context.Background()
	no := false
	if err := c.CreateWorkItem(ctx, core.WorkItemInput{ID: "MG-1", Title: "synthetic", NeedsMerge: &no}); err != nil {
		t.Fatal(err)
	}
	for _, cookie := range []bool{false, true} {
		req, _ := http.NewRequest("PATCH", ts.URL+"/api/work-items/MG-1", strings.NewReader(`{"management":{"state":"accepted"}}`))
		if cookie {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		want := 401
		if cookie {
			want = 403
		}
		if res.StatusCode != want {
			t.Fatal("unauthorized management accepted", res.StatusCode)
		}
	}
	for _, state := range []string{"paused", "active", "accepted"} {
		code, b := panelReq(t, ts, "PATCH", "/api/work-items/MG-1", map[string]any{"management": map[string]any{"state": state}})
		if code != 200 {
			t.Fatal(code, string(b))
		}
		code, b = panelReq(t, ts, "GET", "/api/snapshot", nil)
		if code != 200 || state != "active" && !strings.Contains(string(b), `"state":"`+state+`"`) {
			t.Fatal("management missing from snapshot", code, string(b))
		}
	}
}
