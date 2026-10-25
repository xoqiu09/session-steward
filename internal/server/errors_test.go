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

func assertJSONError(t *testing.T, code int, ct, body string) {
	t.Helper()
	if !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type=%q code=%d body=%s", ct, code, body)
	}
	var v struct{ Error string }
	if err := json.Unmarshal([]byte(body), &v); err != nil || v.Error == "" {
		t.Fatalf("不是 JSON 错误: %v %q", err, body)
	}
}

// 程序调用的接口（/api/、/hook/）在 Host、鉴权、远程只读、Origin、X-Steward 各类拒绝时都返回 JSON {"error": ...}，
// 前端才能按状态码区分未登录（401）和无权限（403）。
func TestAPIErrorsAreJSON(t *testing.T) {
	h := remoteServer(t, []string{rh})
	local := "127.0.0.1:7788"
	cases := []struct {
		name string
		q    rq
		want int
	}{
		{"未登录", rq{method: "GET", host: local, path: "/api/snapshot"}, 401},
		{"非法 Host", rq{method: "GET", host: "evil.example", path: "/api/snapshot", cookie: cookieName, value: "pan"}, 403},
		{"远程访问采集接口", rq{method: "POST", host: rh, path: "/hook/event"}, 403},
		{"远程只读", rq{method: "POST", host: rh, path: "/api/deps", cookie: remoteCookie, value: "rem", origin: "https://" + rh, steward: true}, 403},
		{"Origin 不符", rq{method: "POST", host: local, path: "/api/deps", cookie: cookieName, value: "pan", origin: "http://evil.example", steward: true}, 403},
		{"缺少 X-Steward", rq{method: "POST", host: local, path: "/api/deps", cookie: cookieName, value: "pan", origin: "http://" + local}, 403},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := do(h, c.q)
			if w.Code != c.want {
				t.Fatalf("code=%d want=%d body=%s", w.Code, c.want, w.Body.String())
			}
			assertJSONError(t, w.Code, w.Header().Get("Content-Type"), w.Body.String())
		})
	}
}

func TestIngestUnauthorizedIsJSON(t *testing.T) {
	h := remoteServer(t, nil)
	r, _ := http.NewRequest("POST", "http://127.0.0.1:7788/hook/event", strings.NewReader("{}"))
	r.Host = "127.0.0.1:7788"
	r.Header.Set("Authorization", "Bearer wrong")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("code=%d", w.Code)
	}
	assertJSONError(t, w.Code, w.Header().Get("Content-Type"), w.Body.String())
}

// 未注册的 /api 路径不回落到 index.html；浏览器直接打开的页面仍返回可读的纯文本提示。
func TestUnknownAPIAndHTMLPages(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "s.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	s := &Server{Core: core.New(st, nil), IngestToken: "ing", PanelToken: "pan", PermWait: time.Second,
		Static: fstest.MapFS{"index.html": {Data: []byte("<html>panel</html>")}}}
	h := s.Handler()
	local := "127.0.0.1:7788"

	w := do(h, rq{method: "GET", host: local, path: "/api/no-such", cookie: cookieName, value: "pan"})
	if w.Code != 404 {
		t.Fatalf("未知接口: %d %s", w.Code, w.Body.String())
	}
	assertJSONError(t, w.Code, w.Header().Get("Content-Type"), w.Body.String())

	w = do(h, rq{method: "GET", host: local, path: "/"})
	if w.Code != 401 || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/plain") || !strings.Contains(w.Body.String(), "steward open") {
		t.Fatalf("页面未登录: %d %q %s", w.Code, w.Header().Get("Content-Type"), w.Body.String())
	}
	w = do(h, rq{method: "GET", host: local, path: "/", cookie: cookieName, value: "pan"})
	if w.Code != 200 || !strings.Contains(w.Body.String(), "panel") {
		t.Fatalf("页面: %d %s", w.Code, w.Body.String())
	}
}
