package server

import (
	"encoding/json"
	"fmt"
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

func TestLiveReadingTopicProjectionAndWriteGuard(t *testing.T) {
	h := liveServer(t, "liv")
	body := `{"action":"save","revision":"","items":[{"id":"public","source":"kuangye","title":"合成阅读","body":"合成正文","topic":"emotion","enabled":true,"approved":true},{"id":"draft","source":"kuangye","title":"DRAFT_CANARY","body":"PRIVATE_BODY","topic":"family","enabled":true,"approved":false}],"sources":["kuangye"],"interval_seconds":40,"focus":"town"}`
	if w := liveDo(h, "PUT", local, "/api/live/content", liveCookie, "liv", body, true); w.Code != http.StatusUnauthorized {
		t.Fatalf("display could write: %d", w.Code)
	}
	if w := liveDo(h, "PUT", local, "/api/live/content", cookieName, "pan", body, true); w.Code != http.StatusOK {
		t.Fatalf("save: %d %s", w.Code, w.Body.String())
	}
	w := liveDo(h, "GET", local, "/api/live/note", liveCookie, "liv", "", false)
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"topic":"emotion"`) || strings.Contains(w.Body.String(), `"family"`) || strings.Contains(w.Body.String(), "DRAFT_CANARY") {
		t.Fatalf("topic projection incorrect: %d %s", w.Code, w.Body.String())
	}
	bad := strings.ReplaceAll(body, `"emotion"`, `"/PRIVATE_TOPIC_CANARY"`)
	w = liveDo(h, "PUT", local, "/api/live/content", cookieName, "pan", bad, true)
	if w.Code != http.StatusBadRequest || strings.Contains(w.Body.String(), "PRIVATE_TOPIC_CANARY") {
		t.Fatalf("invalid topic: %d %s", w.Code, w.Body.String())
	}
}

func TestReadingPoolIsOwnerOnlyAndWindowStaysSmall(t *testing.T) {
	h := liveServer(t, "liv")
	pool := core.LiveReadingPoolUpdate{Confirmed: true, LiveReadingPool: core.LiveReadingPool{SourceCount: 100, Items: []core.PublicLiveContentItem{}}}
	for i := 0; i < 37; i++ {
		pool.Items = append(pool.Items, core.PublicLiveContentItem{ID: fmt.Sprintf("synthetic-%03d", i), Source: "kuangye", Title: fmt.Sprintf("合成思考片段%d。", i), Credit: "摘句", Topic: "emotion"})
	}
	body, _ := json.Marshal(pool)
	for _, method := range []string{"GET", "PUT"} {
		if w := liveDo(h, method, local, "/api/live/reading-pool", liveCookie, "liv", string(body), true); w.Code != 401 {
			t.Fatalf("display pool %s: %d", method, w.Code)
		}
		if w := liveDo(h, method, rh, "/api/live/reading-pool", cookieName, "pan", string(body), true); w.Code != 403 {
			t.Fatalf("remote pool %s: %d", method, w.Code)
		}
	}
	if w := liveDo(h, "PUT", local, "/api/live/reading-pool", cookieName, "pan", string(body), false); w.Code != 403 {
		t.Fatal("missing origin guard")
	}
	for _, bad := range []string{string(body) + `{}`, strings.TrimSuffix(string(body), "}") + `,"private_path":"CANARY"}`, `{"items":[],"padding":"` + strings.Repeat("x", 4<<20) + `"}`} {
		if w := liveDo(h, "PUT", local, "/api/live/reading-pool", cookieName, "pan", bad, true); w.Code != 400 {
			t.Fatalf("malformed import: %d", w.Code)
		}
	}
	w := liveDo(h, "PUT", local, "/api/live/reading-pool", cookieName, "pan", string(body), true)
	if w.Code != 200 {
		t.Fatalf("import: %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), `"items"`) || strings.Contains(w.Body.String(), "合成思考") {
		t.Fatal("summary returned full library")
	}
	if w := liveDo(h, "PUT", local, "/api/live/reading-pool", cookieName, "pan", string(body), true); w.Code != 409 {
		t.Fatal("stale import accepted")
	}
	config := `{"action":"save","mode":"random","revision":"","items":[{"id":"draft","source":"compass","title":"PRIVATE_DRAFT_CANARY","body":"SECRET","enabled":true,"approved":false}],"sources":["kuangye"],"interval_seconds":40,"focus":"town"}`
	if w := liveDo(h, "PUT", local, "/api/live/content", cookieName, "pan", config, true); w.Code != 200 {
		t.Fatalf("random mode: %d %s", w.Code, w.Body.String())
	}
	w = liveDo(h, "GET", local, "/api/live/note", liveCookie, "liv", "", false)
	if w.Code != 200 {
		t.Fatalf("display: %d", w.Code)
	}
	var note core.LiveNote
	if err := json.Unmarshal(w.Body.Bytes(), &note); err != nil {
		t.Fatal(err)
	}
	if len(note.Content.Items) != 24 || note.Content.Mode != "random" || w.Body.Len() > 12000 {
		t.Fatal("public window not bounded")
	}
	for _, hidden := range []string{"PRIVATE_DRAFT_CANARY", "random_seed", "random_offset", "source_count", "revision", "synthetic-"} {
		if strings.Contains(w.Body.String(), hidden) {
			t.Fatalf("leaked %s", hidden)
		}
	}
}
