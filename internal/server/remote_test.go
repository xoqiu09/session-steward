package server

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/store"
)

func remoteServer(t *testing.T, hosts []string) http.Handler {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "r.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	s := &Server{Core: core.New(st, nil), IngestToken: "ing", PanelToken: "pan", RemoteToken: "rem", RemoteHosts: hosts, PermWait: time.Second}
	return s.Handler()
}

type rq struct {
	method, host, path, cookie, value, origin string
	steward                                   bool
}

func do(h http.Handler, q rq) *httptest.ResponseRecorder {
	r := httptest.NewRequest(q.method, "http://"+q.host+q.path, strings.NewReader("{}"))
	r.Host = q.host
	if q.cookie != "" {
		r.AddCookie(&http.Cookie{Name: q.cookie, Value: q.value})
	}
	if q.origin != "" {
		r.Header.Set("Origin", q.origin)
	}
	if q.steward {
		r.Header.Set("X-Steward", "1")
	}
	r.Header.Set("Authorization", "Bearer ing")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

const rh = "mac.tailnet-synthetic.ts.net"

func TestRemoteDisabledByDefault(t *testing.T) {
	h := remoteServer(t, nil)
	if w := do(h, rq{method: "GET", host: rh, path: "/api/snapshot", cookie: remoteCookie, value: "rem"}); w.Code != 403 {
		t.Fatalf("未开启时远程主机应拒绝: %d", w.Code)
	}
}

func TestRemoteTokensAreSeparate(t *testing.T) {
	h := remoteServer(t, []string{rh})
	cases := []struct {
		name string
		q    rq
		want int
	}{
		{"远程+远程 token", rq{method: "GET", host: rh, path: "/api/snapshot", cookie: remoteCookie, value: "rem"}, 200},
		{"远程+本机 token", rq{method: "GET", host: rh, path: "/api/snapshot", cookie: cookieName, value: "pan"}, 401},
		{"本机+远程 token", rq{method: "GET", host: "127.0.0.1:7788", path: "/api/snapshot", cookie: remoteCookie, value: "rem"}, 401},
		{"本机+本机 token", rq{method: "GET", host: "127.0.0.1:7788", path: "/api/snapshot", cookie: cookieName, value: "pan"}, 200},
		{"其他主机", rq{method: "GET", host: "evil.example", path: "/api/snapshot", cookie: remoteCookie, value: "rem"}, 403},
		{"远程不开放采集接口", rq{method: "POST", host: rh, path: "/hook/event"}, 403},
		{"远程 Origin 必须是 https 同主机", rq{method: "POST", host: rh, path: "/api/approvals/x/dismiss", cookie: remoteCookie, value: "rem", origin: "http://" + rh, steward: true}, 403},
		{"远程本机 Origin 拒绝", rq{method: "POST", host: rh, path: "/api/approvals/x/dismiss", cookie: remoteCookie, value: "rem", origin: "http://127.0.0.1:7788", steward: true}, 403},
		{"远程审批也只读", rq{method: "POST", host: rh, path: "/api/approvals/x/dismiss", cookie: remoteCookie, value: "rem", origin: "https://" + rh, steward: true}, 403},
		{"本机仍可处理审批（条目不存在）", rq{method: "POST", host: "127.0.0.1:7788", path: "/api/approvals/x/dismiss", cookie: cookieName, value: "pan", origin: "http://127.0.0.1:7788", steward: true}, 409},
		{"远程 HEAD 是只读", rq{method: "HEAD", host: rh, path: "/api/snapshot", cookie: remoteCookie, value: "rem"}, 200},
		{"本机 Origin 前缀伪造", rq{method: "POST", host: "127.0.0.1:7788", path: "/api/approvals/x/dismiss", cookie: cookieName, value: "pan", origin: "http://127.0.0.1.evil.example", steward: true}, 403},
		{"本机跨端口拒绝", rq{method: "POST", host: "127.0.0.1:7788", path: "/api/approvals/x/dismiss", cookie: cookieName, value: "pan", origin: "http://127.0.0.1:7789", steward: true}, 403},
		{"远程跨端口拒绝", rq{method: "POST", host: rh, path: "/api/approvals/x/dismiss", cookie: remoteCookie, value: "rem", origin: "https://" + rh + ":444", steward: true}, 403},
	}
	for _, c := range cases {
		if w := do(h, c.q); w.Code != c.want {
			t.Errorf("%s: got %d want %d (%s)", c.name, w.Code, c.want, strings.TrimSpace(w.Body.String()))
		}
	}
}

func TestRemoteCannotRunProcessesOrMerge(t *testing.T) {
	h := remoteServer(t, []string{rh})
	for _, p := range []string{"/api/approvals/x/reject-merge", "/api/approvals/x/merge-instruction"} {
		if w := do(h, rq{method: "POST", host: rh, path: p, cookie: remoteCookie, value: "rem", origin: "https://" + rh, steward: true}); w.Code != 403 {
			t.Errorf("remote merge operation %s: %d", p, w.Code)
		}
	}
	for _, p := range []string{"/api/managed", "/api/managed/x/input", "/api/managed/x/takeover", "/api/work-items/X-1/handoff", "/api/approvals/x/checked-merge", "/api/approvals/x/approve-merge", "/api/work-items/X-1/summary", "/api/work-items/X-1/handoff/preview"} {
		w := do(h, rq{method: "POST", host: rh, path: p, cookie: remoteCookie, value: "rem", origin: "https://" + rh, steward: true})
		if w.Code != 403 || !strings.Contains(w.Body.String(), "本机") {
			t.Errorf("%s: %d %s", p, w.Code, w.Body.String())
		}
	}
	if w := do(h, rq{method: "GET", host: rh, path: "/api/work-items/X-1/summary", cookie: remoteCookie, value: "rem"}); w.Code == 403 {
		t.Errorf("远程应能查看已有摘要: %d", w.Code)
	}
	// 只读终端画面也不开放给远程（终端可能显示敏感内容）
	if w := do(h, rq{method: "GET", host: rh, path: "/api/managed/x/terminal", cookie: remoteCookie, value: "rem"}); w.Code != 403 {
		t.Errorf("远程终端画面: %d", w.Code)
	}
}

func TestRemoteLoginSetsSecureCookie(t *testing.T) {
	h := remoteServer(t, []string{rh})
	if w := do(h, rq{method: "GET", host: rh, path: "/login?t=pan"}); w.Code != 401 {
		t.Fatalf("本机 token 不能登录远程: %d", w.Code)
	}
	w := do(h, rq{method: "GET", host: rh, path: "/login?t=rem"})
	ck := w.Result().Cookies()
	if w.Code != 303 || len(ck) != 1 || ck[0].Name != remoteCookie || !ck[0].Secure || !ck[0].HttpOnly {
		t.Fatalf("%d %+v", w.Code, ck)
	}
	if w.Header().Get("Strict-Transport-Security") == "" {
		t.Fatal("远程应带 HSTS")
	}
}

// 每类写入口都经过同一远程只读边界，而不是依赖易漏项的路径黑名单。
func TestRemoteReadOnlyRejectsEveryMutation(t *testing.T) {
	h := remoteServer(t, []string{rh})
	for _, q := range []struct{ method, path string }{
		{"POST", "/api/approvals/x/decide"},
		{"POST", "/api/approvals/x/dismiss"},
		{"POST", "/api/work-items"},
		{"PATCH", "/api/work-items/X-1"},
		{"POST", "/api/work-items/X-1/brief"},
		{"POST", "/api/features/1/export/accept"},
		{"POST", "/api/features/1/export/confirm-scope"},
		{"POST", "/api/attributions/decide"},
		{"POST", "/api/attributions/reconcile"},
		{"POST", "/api/sessions/1/bind"},
		{"POST", "/api/sessions/1/unbind"},
		{"POST", "/api/runs/1/outcome"},
		{"POST", "/api/deps"},
		{"DELETE", "/api/deps"},
		{"POST", "/api/scan/merges"},
	} {
		t.Run(q.method+q.path, func(t *testing.T) {
			w := do(h, rq{method: q.method, host: rh, path: q.path, cookie: remoteCookie, value: "rem", origin: "https://" + rh, steward: true})
			if w.Code != http.StatusForbidden {
				t.Fatalf("remote mutation reached handler: %d %s", w.Code, w.Body.String())
			}
		})
	}
	// 未出现过的未来路径也默认只读。
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		if !remoteBlocked(method, "/api/future-feature") {
			t.Errorf("future %s must be blocked", method)
		}
	}
	for _, method := range []string{"GET", "HEAD"} {
		if remoteBlocked(method, "/api/snapshot") {
			t.Errorf("%s read denied", method)
		}
		if !remoteBlocked(method, "/api/managed/x/terminal") {
			t.Errorf("%s terminal exposed", method)
		}
	}
}
