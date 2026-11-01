package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/nativecontrol"
	"github.com/xoqiu09/session-steward/internal/store"
)

func dispatchServer(t *testing.T, withDesk bool) (http.Handler, *store.Store) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "d.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	c := core.New(st, nil)
	s := &Server{Core: c, IngestToken: "ing", PanelToken: "pan", RemoteToken: "rem", RemoteHosts: []string{rh}, PermWait: time.Second}
	if withDesk {
		// 合成测试不启动任何 Codex：工厂直接报错。
		d, err := nativecontrol.NewDesk(context.Background(), c, func(context.Context, string) (nativecontrol.Transport, error) {
			return nil, errors.New("synthetic: no codex")
		}, "synthetic-host", "Synthetic Studio", "codex-cli 0.0.0-synthetic")
		if err != nil {
			t.Fatal(err)
		}
		s.Dispatch = d
		t.Cleanup(d.Close)
	}
	t.Cleanup(func() { st.Close() })
	return s.Handler(), st
}

type drq struct {
	method, host, remote, path, body string
	cookie, value                    string
	headers                          map[string]string
}

func ddo(h http.Handler, q drq) *httptest.ResponseRecorder {
	if q.body == "" {
		q.body = "{}"
	}
	r := httptest.NewRequest(q.method, "http://"+q.host+q.path, strings.NewReader(q.body))
	r.Host, r.RemoteAddr = q.host, q.remote
	if q.cookie != "" {
		r.AddCookie(&http.Cookie{Name: q.cookie, Value: q.value})
	}
	if q.method != "GET" {
		r.Header.Set("Origin", "http://"+q.host)
		r.Header.Set("X-Steward", "1")
		r.Header.Set("Content-Type", "application/json")
	}
	for k, v := range q.headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

const localHost, loopPeer = "127.0.0.1:7788", "127.0.0.1:50123"

func TestDispatchRoutesAreLocalOnly(t *testing.T) {
	h, _ := dispatchServer(t, true)
	cases := []struct {
		name string
		q    drq
		want int
	}{
		{"本机", drq{method: "GET", host: localHost, remote: loopPeer, path: "/api/dispatch", cookie: cookieName, value: "pan"}, 200},
		{"本机未登录", drq{method: "GET", host: localHost, remote: loopPeer, path: "/api/dispatch"}, 401},
		{"远程主机即使带远程 token", drq{method: "GET", host: rh, remote: loopPeer, path: "/api/dispatch", cookie: remoteCookie, value: "rem"}, 403},
		{"远程主机写操作", drq{method: "POST", host: rh, remote: loopPeer, path: "/api/dispatch/acquire", body: `{"client":"controller-remote"}`, cookie: remoteCookie, value: "rem"}, 403},
		{"回环但带转发头", drq{method: "GET", host: localHost, remote: loopPeer, path: "/api/dispatch", cookie: cookieName, value: "pan", headers: map[string]string{"X-Forwarded-For": "100.64.0.9"}}, 403},
		{"回环但带 Tailscale 身份头", drq{method: "GET", host: localHost, remote: loopPeer, path: "/api/dispatch", cookie: cookieName, value: "pan", headers: map[string]string{"Tailscale-User-Login": "someone@example.invalid"}}, 403},
		{"对端不是回环", drq{method: "GET", host: localHost, remote: "192.0.2.7:4000", path: "/api/dispatch", cookie: cookieName, value: "pan"}, 403},
	}
	for _, c := range cases {
		if w := ddo(h, c.q); w.Code != c.want {
			t.Errorf("%s: %d want %d (%s)", c.name, w.Code, c.want, w.Body.String())
		}
	}
	if !remoteBlocked("GET", "/api/dispatch/tasks/x") || !remoteBlocked("POST", "/api/dispatch/acquire") {
		t.Fatal("派活路由应在远程拦截名单里")
	}
}

func TestDispatchUnavailableWithoutCodex(t *testing.T) {
	h, _ := dispatchServer(t, false)
	w := ddo(h, drq{method: "GET", host: localHost, remote: loopPeer, path: "/api/dispatch", cookie: cookieName, value: "pan"})
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), `"available":false`) {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestDispatchRejectsUnauthorizedProjectAndLegacyApproval(t *testing.T) {
	h, st := dispatchServer(t, true)
	w := ddo(h, drq{method: "POST", host: localHost, remote: loopPeer, path: "/api/dispatch/acquire", body: `{"client":"controller-local"}`, cookie: cookieName, value: "pan"})
	if w.Code != 200 {
		t.Fatalf("acquire: %d %s", w.Code, w.Body.String())
	}
	var v struct {
		Epoch int `json:"epoch"`
	}
	json.Unmarshal(w.Body.Bytes(), &v)
	body, _ := json.Marshal(map[string]any{"client": "controller-local", "epoch": v.Epoch, "operation": "operation-x1", "repo_id": 999, "title": "合成", "prompt": "合成任务"})
	if w := ddo(h, drq{method: "POST", host: localHost, remote: loopPeer, path: "/api/dispatch/tasks", body: string(body), cookie: cookieName, value: "pan"}); w.Code != 403 {
		t.Fatalf("未授权项目应 403：%d %s", w.Code, w.Body.String())
	}
	if w := ddo(h, drq{method: "POST", host: localHost, remote: loopPeer, path: "/api/dispatch/tasks", body: `{"client":"controller-local","cwd":"/etc"}`, cookie: cookieName, value: "pan"}); w.Code != 400 {
		t.Fatalf("客户端不能提交目录等额外字段：%d", w.Code)
	}
	// 派活台的审批不能走普通审批接口
	if err := st.Tx(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO approvals(id,kind,status,fingerprint,tool_name,handleable,created_at) VALUES('A-dispatch','permission','pending','fp','NativeCodexControl',1,'2026-10-31T00:00:00Z')`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/api/approvals/A-dispatch/decide", "/api/approvals/A-dispatch/dismiss"} {
		if w := ddo(h, drq{method: "POST", host: localHost, remote: loopPeer, path: p, body: `{"fingerprint":"fp","behavior":"allow"}`, cookie: cookieName, value: "pan"}); w.Code != 409 {
			t.Fatalf("%s 应 409：%d %s", p, w.Code, w.Body.String())
		}
	}
}
