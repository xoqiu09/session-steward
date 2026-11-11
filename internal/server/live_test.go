package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/store"
)

const local = "127.0.0.1:7788"

func liveServer(t *testing.T, liveToken string) http.Handler {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "live.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	s := &Server{Core: core.New(st, nil), IngestToken: "ing", PanelToken: "pan", LiveToken: liveToken, RemoteToken: "rem", RemoteHosts: []string{rh}, PermWait: time.Second,
		Static: fstest.MapFS{"index.html": {Data: []byte("<html>synthetic</html>")}, "assets/app.js": {Data: []byte("//js")}}}
	return s.Handler()
}

func liveDo(h http.Handler, method, host, path, cookie, value, body string, steward bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, "http://"+host+path, strings.NewReader(body))
	r.Host = host
	if cookie != "" {
		r.AddCookie(&http.Cookie{Name: cookie, Value: value})
	}
	if steward {
		r.Header.Set("X-Steward", "1")
		r.Header.Set("Origin", "http://"+host)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestLiveLoginSetsSeparateCookie(t *testing.T) {
	h := liveServer(t, "liv")
	w := liveDo(h, "GET", local, "/live?k=liv", "", "", "", false)
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/?view=town&live=1" {
		t.Fatalf("登录应跳到展示视图: %d %q", w.Code, w.Header().Get("Location"))
	}
	var got *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == liveCookie {
			got = c
		}
		if c.Name == cookieName {
			t.Fatal("展示登录不应设置面板 cookie")
		}
	}
	if got == nil || got.Value != "liv" || !got.HttpOnly {
		t.Fatalf("展示 cookie: %+v", got)
	}
	for _, k := range []string{"", "pan", "bad"} {
		if w := liveDo(h, "GET", local, "/live?k="+k, "", "", "", false); w.Code != http.StatusUnauthorized {
			t.Fatalf("错误展示令牌 %q 应拒绝: %d", k, w.Code)
		}
	}
	// 面板令牌换不到展示 cookie，展示令牌也登录不了面板。
	if w := liveDo(h, "GET", local, "/login?t=liv", "", "", "", false); w.Code != http.StatusUnauthorized {
		t.Fatalf("展示令牌不能登录面板: %d", w.Code)
	}
}

func TestLiveCookieOnlyReadsLiveAPI(t *testing.T) {
	h := liveServer(t, "liv")
	for _, path := range []string{"/api/live/snapshot", "/api/live/note"} {
		if w := liveDo(h, "GET", local, path, liveCookie, "liv", "", false); w.Code != 200 {
			t.Fatalf("展示 cookie 应能读 %s: %d %s", path, w.Code, w.Body)
		}
		if w := liveDo(h, "GET", local, path, cookieName, "pan", "", false); w.Code != 200 {
			t.Fatalf("面板 cookie 也应能读 %s: %d", path, w.Code)
		}
		if w := liveDo(h, "GET", local, path, "", "", "", false); w.Code != http.StatusUnauthorized {
			t.Fatalf("无 cookie 读 %s 应拒绝: %d", path, w.Code)
		}
		if w := liveDo(h, "GET", local, path, liveCookie, "bad", "", false); w.Code != http.StatusUnauthorized {
			t.Fatalf("错误展示 cookie 读 %s 应拒绝: %d", path, w.Code)
		}
	}
	for _, q := range []struct{ method, path string }{
		{"GET", "/api/snapshot"}, {"GET", "/api/stream"}, {"GET", "/api/hooks/status"}, {"GET", "/api/history"}, {"GET", "/api/version"},
		{"GET", "/api/live/link"}, {"PUT", "/api/live/note"}, {"PATCH", "/api/work-items/A-1"}, {"GET", "/api/projects"},
		{"POST", "/api/live/companion"},
	} {
		if w := liveDo(h, q.method, local, q.path, liveCookie, "liv", `{"doing":"x"}`, true); w.Code != http.StatusUnauthorized {
			t.Fatalf("展示 cookie 不应访问 %s %s: %d", q.method, q.path, w.Code)
		}
	}
	// 首页：只有带 live=1 时才给展示 cookie；静态资源照常可取。
	if w := liveDo(h, "GET", local, "/?view=town&live=1", liveCookie, "liv", "", false); w.Code != 200 || !strings.Contains(w.Body.String(), "synthetic") {
		t.Fatalf("展示 cookie 应能打开展示首页: %d", w.Code)
	}
	for _, path := range []string{"/", "/?view=town", "/?view=town&kiosk=1", "/?live=0"} {
		if w := liveDo(h, "GET", local, path, liveCookie, "liv", "", false); w.Code != http.StatusUnauthorized {
			t.Fatalf("展示 cookie 不应打开 %s: %d", path, w.Code)
		}
	}
	if w := liveDo(h, "GET", local, "/?view=town&live=1", "", "", "", false); w.Code != http.StatusUnauthorized {
		t.Fatalf("没有 cookie 不应打开展示首页: %d", w.Code)
	}
}

func TestLiveCompanionRequiresLocalOwnerAndSameOrigin(t *testing.T) {
	h := liveServer(t, "liv")
	for _, q := range []struct {
		host, cookie, token string
		steward             bool
		status              int
	}{
		{local, "", "", true, 401}, {local, liveCookie, "liv", true, 401},
		{local, cookieName, "pan", false, 403}, {rh, remoteCookie, "rem", true, 403},
		{local, cookieName, "pan", true, 200},
	} {
		w := liveDo(h, "POST", q.host, "/api/live/companion", q.cookie, q.token, `{"kind":"pat"}`, q.steward)
		if w.Code != q.status {
			t.Fatalf("gesture auth: %+v got %d %s", q, w.Code, w.Body)
		}
	}
	w := liveDo(h, "GET", local, "/api/live/note", liveCookie, "liv", "", false)
	var n core.LiveNote
	if err := json.Unmarshal(w.Body.Bytes(), &n); err != nil || n.Companion == nil || n.Companion.Kind != "pat" {
		t.Fatalf("display read: %s %v", w.Body, err)
	}
	w = liveDo(h, "POST", local, "/api/live/companion", cookieName, "pan", `{"kind":"approve"}`, true)
	if w.Code != 400 {
		t.Fatalf("arbitrary command accepted: %d", w.Code)
	}
}

func TestLivePreviewCanOnlyEmbedTheReadOnlyLocalRoute(t *testing.T) {
	h := liveServer(t, "liv")
	w := liveDo(h, "GET", local, "/?view=town&live=1", cookieName, "pan", "", false)
	if w.Code != 200 || w.Header().Get("X-Frame-Options") != "SAMEORIGIN" || w.Header().Get("Content-Security-Policy") != "frame-ancestors 'self'" {
		t.Fatalf("local preview headers: %d %v", w.Code, w.Header())
	}
	for _, path := range []string{"/", "/?view=town", "/?view=town&live=0", "/?view=canvas&live=1", "/api/live/note"} {
		w = liveDo(h, "GET", local, path, cookieName, "pan", "", false)
		if w.Header().Get("X-Frame-Options") != "DENY" {
			t.Fatalf("private route can be embedded: %s %v", path, w.Header())
		}
	}
	w = liveDo(h, "GET", rh, "/?view=town&live=1", remoteCookie, "rem", "", false)
	if w.Header().Get("X-Frame-Options") != "DENY" {
		t.Fatal("remote framing allowed")
	}
}

func TestLiveRemoteRejected(t *testing.T) {
	h := liveServer(t, "liv")
	for _, q := range []struct{ cookie, value, path string }{
		{"", "", "/live?k=liv"},
		{liveCookie, "liv", "/api/live/snapshot"},
		{liveCookie, "liv", "/api/live/note"},
		{remoteCookie, "rem", "/api/live/snapshot"},
		{remoteCookie, "rem", "/api/live/note"},
		{remoteCookie, "rem", "/api/live/link"},
		{liveCookie, "liv", "/?view=town&live=1"},
	} {
		w := liveDo(h, "GET", rh, q.path, q.cookie, q.value, "", false)
		if w.Code != http.StatusForbidden && w.Code != http.StatusUnauthorized {
			t.Fatalf("远程访问 %s 应拒绝: %d", q.path, w.Code)
		}
		if strings.Contains(w.Body.String(), "liv") && strings.Contains(q.path, "link") {
			t.Fatal("远程不应拿到展示地址")
		}
	}
	if w := liveDo(h, "PUT", rh, "/api/live/note", remoteCookie, "rem", `{"doing":"x"}`, true); w.Code != http.StatusForbidden {
		t.Fatalf("远程写说明应拒绝: %d", w.Code)
	}
	// 未允许的主机名仍被 guard 拒绝。
	if w := liveDo(h, "GET", "evil.test", "/live?k=liv", "", "", "", false); w.Code != http.StatusForbidden {
		t.Fatalf("DNS rebinding 主机应拒绝: %d", w.Code)
	}
}

func TestLiveDisabledWithoutToken(t *testing.T) {
	h := liveServer(t, "")
	if w := liveDo(h, "GET", local, "/live?k=", "", "", "", false); w.Code != http.StatusNotFound {
		t.Fatalf("没有展示令牌时不开放: %d", w.Code)
	}
	if w := liveDo(h, "GET", local, "/?view=town&live=1", liveCookie, "", "", false); w.Code != http.StatusUnauthorized {
		t.Fatalf("空展示 cookie 不能打开首页: %d", w.Code)
	}
}

func TestLiveNoteAndLink(t *testing.T) {
	h := liveServer(t, "liv")
	// 写说明只给面板，并要求 X-Steward 与同源。
	if w := liveDo(h, "PUT", local, "/api/live/note", cookieName, "pan", `{"doing":"整理合成数据","contact":"留言"}`, false); w.Code != http.StatusForbidden {
		t.Fatalf("缺少 X-Steward 应拒绝: %d", w.Code)
	}
	w := liveDo(h, "PUT", local, "/api/live/note", cookieName, "pan", `{"doing":"整理合成数据","contact":"留言"}`, true)
	if w.Code != 200 {
		t.Fatalf("面板写说明: %d %s", w.Code, w.Body)
	}
	w = liveDo(h, "GET", local, "/api/live/note", liveCookie, "liv", "", false)
	var n core.LiveNote
	if err := json.Unmarshal(w.Body.Bytes(), &n); err != nil || n.Doing != "整理合成数据" || n.Contact != "留言" || n.Thinking != "" || n.UpdatedAt == "" {
		t.Fatalf("读回说明: %s %v", w.Body, err)
	}
	long := `{"thinking":"` + strings.Repeat("字", core.LiveNoteMax+1) + `"}`
	if w := liveDo(h, "PUT", local, "/api/live/note", cookieName, "pan", long, true); w.Code != http.StatusBadRequest {
		t.Fatalf("超长说明应返回 400: %d", w.Code)
	}
	w = liveDo(h, "GET", local, "/api/live/link", cookieName, "pan", "", false)
	var link struct{ URL string }
	if err := json.Unmarshal(w.Body.Bytes(), &link); err != nil || w.Code != 200 || link.URL != "http://"+local+"/live?k=liv" {
		t.Fatalf("展示地址: %d %s", w.Code, w.Body)
	}
	if w := liveDo(h, "GET", local, "/api/live/link", "", "", "", false); w.Code != http.StatusUnauthorized {
		t.Fatalf("未登录不能取展示地址: %d", w.Code)
	}
}

func TestLiveSnapshotEndpointIsSanitized(t *testing.T) {
	h := liveServer(t, "liv")
	w := liveDo(h, "GET", local, "/api/live/snapshot", liveCookie, "liv", "", false)
	var snap core.Snapshot
	if err := json.Unmarshal(w.Body.Bytes(), &snap); err != nil || w.Code != 200 {
		t.Fatalf("%d %s %v", w.Code, w.Body, err)
	}
	if snap.Approvals == nil || snap.Repos == nil || snap.Now == "" {
		t.Fatalf("展示快照应保持兼容结构: %s", w.Body)
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &keys); err != nil {
		t.Fatal(err)
	}
	if _, ok := keys["more"]; !ok {
		t.Fatalf("展示快照应带没画出来的项目数: %s", w.Body)
	}
	for _, k := range []string{"features", "managed", "handoffs", "attributions", "session_usage", "merge_jobs"} {
		if _, ok := keys[k]; ok {
			t.Fatalf("展示快照不应带 %s: %s", k, w.Body)
		}
	}
}
