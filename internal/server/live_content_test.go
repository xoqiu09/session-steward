package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/xoqiu09/session-steward/internal/core"
)

func TestLiveContentOwnerAndDisplayPermissions(t *testing.T) {
	h := liveServer(t, "liv")
	body := `{"action":"save","revision":"","items":[{"id":"a","source":"compass","title":"公开标题","body":"公开正文","enabled":true,"approved":true},{"id":"b","source":"compass","title":"DRAFT_CANARY","body":"DRAFT_SECRET","enabled":true,"approved":false}],"sources":["compass"],"interval_seconds":40,"focus":"town"}`
	for _, method := range []string{"GET", "PUT"} {
		if w := liveDo(h, method, local, "/api/live/content", liveCookie, "liv", body, true); w.Code != http.StatusUnauthorized {
			t.Fatalf("display %s: %d", method, w.Code)
		}
		if w := liveDo(h, method, rh, "/api/live/content", cookieName, "pan", body, true); w.Code != http.StatusForbidden {
			t.Fatalf("remote %s: %d", method, w.Code)
		}
	}
	if w := liveDo(h, "PUT", local, "/api/live/content", cookieName, "pan", body, false); w.Code != http.StatusForbidden {
		t.Fatalf("missing same-origin write guard: %d", w.Code)
	}
	w := liveDo(h, "PUT", local, "/api/live/content", cookieName, "pan", body, true)
	if w.Code != 200 {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	var saved core.LiveContent
	if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Revision == "" {
		t.Fatal("missing revision")
	}
	if w := liveDo(h, "PUT", local, "/api/live/content", cookieName, "pan", body, true); w.Code != 409 {
		t.Fatalf("stale edit: %d", w.Code)
	}
	read := liveDo(h, "GET", local, "/api/live/note", liveCookie, "liv", "", false)
	if read.Code != 200 || !strings.Contains(read.Body.String(), "公开正文") || strings.Contains(read.Body.String(), "DRAFT_") {
		t.Fatalf("display projection: %d %s", read.Code, read.Body.String())
	}
	owner := liveDo(h, "GET", local, "/api/live/content", cookieName, "pan", "", false)
	if owner.Code != 200 || !strings.Contains(owner.Body.String(), "DRAFT_SECRET") {
		t.Fatal("owner cannot retrieve draft")
	}
}
