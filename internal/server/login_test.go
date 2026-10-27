package server

import (
	"net/http/httptest"
	"testing"
)

// App 登录后直接打开小镇：只跳本站路径，外站、协议相对地址和换行一律回首页。
func TestLoginNext(t *testing.T) {
	h := remoteServer(t, nil)
	for next, want := range map[string]string{
		"/?view=town&world=1": "/?view=town&world=1",
		"":                    "/",
		"https://evil.test/":  "/",
		"//evil.test/":        "/",
		"/\\evil.test":        "/",
		"/ok\r\nSet-Cookie":   "/",
	} {
		r := httptest.NewRequest("GET", "http://127.0.0.1:7788/login?t=pan&next="+urlQuery(next), nil)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 303 || w.Header().Get("Location") != want {
			t.Fatalf("next=%q → %d %q", next, w.Code, w.Header().Get("Location"))
		}
	}
}

func urlQuery(s string) string {
	r := httptest.NewRequest("GET", "http://x/", nil)
	q := r.URL.Query()
	q.Set("n", s)
	return q.Encode()[2:]
}
