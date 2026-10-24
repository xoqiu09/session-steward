package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOriginRequiresExactAuthority(t *testing.T) {
	for _, tc := range []struct {
		origin string
		want   bool
	}{
		{"", true}, {"http://127.0.0.1:7788", true},
		{"http://127.0.0.1.evil.example:7788", false},
		{"http://127.0.0.1:7789", false}, {"http://localhost:7788", false},
		{"http://evil.example/http://127.0.0.1", false},
		{"http://user@127.0.0.1:7788", false}, {"http://127.0.0.1:7788/path", false},
		{"https://127.0.0.1:7788", false}, {"null", false},
	} {
		r := httptest.NewRequest("POST", "http://127.0.0.1:7788/api/managed", nil)
		r.Header.Set("Origin", tc.origin)
		if got := requestOriginOK(r, false); got != tc.want {
			t.Errorf("%q: %v", tc.origin, got)
		}
		// Exercise the actual panel wrapper, not only the parser.
		s := &Server{PanelToken: "pan"}
		r.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
		r.Header.Set("X-Steward", "1")
		w := httptest.NewRecorder()
		s.panel(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })(w, r)
		want := 403
		if tc.want {
			want = 204
		}
		if w.Code != want {
			t.Errorf("panel %q: %d", tc.origin, w.Code)
		}
	}
}
