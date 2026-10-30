package nativecontrol

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
)

type HTTP struct {
	Manager    *Manager
	Token      string
	PanelToken string
	Hosts      []string
}

func host(h string) string {
	if a, _, err := net.SplitHostPort(h); err == nil {
		return a
	}
	return strings.Trim(h, "[]")
}
func loopback(h string) bool { return h == "localhost" || h == "127.0.0.1" || h == "::1" }
func (h *HTTP) Handler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/native/") {
			// Native approvals require the scoped controller lease and full transient details.
			if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/approvals/") && (strings.HasSuffix(r.URL.Path, "/decide") || strings.HasSuffix(r.URL.Path, "/dismiss")) {
				id := strings.TrimPrefix(r.URL.Path, "/api/approvals/")
				id = strings.TrimSuffix(strings.TrimSuffix(id, "/decide"), "/dismiss")
				if h.Manager.OwnsApproval(id) {
					nativeJSON(w, 409, map[string]string{"error": "请在受限原生控制页查看操作内容并处理"})
					return
				}
			}
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		allowed := loopback(host(r.Host))
		for _, v := range h.Hosts {
			if v != "" && strings.EqualFold(host(r.Host), v) {
				allowed = true
			}
		}
		if !allowed {
			nativeJSON(w, 403, map[string]string{"error": "forbidden host"})
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
				nativeJSON(w, 403, map[string]string{"error": "bad origin"})
				return
			}
		}
		if r.Method == "POST" && r.Header.Get("X-Steward-Native") != "1" {
			nativeJSON(w, 403, map[string]string{"error": "missing native header"})
			return
		}
		token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if h.Token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(h.Token)) != 1 {
			nativeJSON(w, 401, map[string]string{"error": "需要此项目的控制配对"})
			return
		}
		if r.URL.Path == "/native/local-pair" && r.Method == "POST" {
			addr, _, _ := net.SplitHostPort(r.RemoteAddr)
			ip := net.ParseIP(addr)
			if !loopback(host(r.Host)) || ip == nil || !ip.IsLoopback() {
				nativeJSON(w, 403, map[string]string{"error": "手机配对需由本机提供项目控制密钥"})
				return
			}
			if h.PanelToken != "" {
				http.SetCookie(w, &http.Cookie{Name: "steward_panel", Value: h.PanelToken, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
			}
			nativeJSON(w, 200, map[string]bool{"paired": true})
			return
		}
		if r.URL.Path == "/native/api/state" && r.Method == "GET" {
			nativeJSON(w, 200, h.Manager.Snapshot())
			return
		}
		if r.Method != "POST" {
			nativeJSON(w, 404, map[string]string{"error": "not found"})
			return
		}
		var b struct {
			Client      string `json:"client"`
			Epoch       int    `json:"epoch"`
			Operation   string `json:"operation"`
			Title       string `json:"title"`
			Prompt      string `json:"prompt"`
			Approval    string `json:"approval"`
			Fingerprint string `json:"fingerprint"`
			Decision    string `json:"decision"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 32768)
		d := json.NewDecoder(r.Body)
		d.DisallowUnknownFields()
		if err := d.Decode(&b); err != nil {
			nativeJSON(w, 400, map[string]string{"error": "invalid request"})
			return
		}
		var state State
		var err error
		switch r.URL.Path {
		case "/native/api/acquire":
			state, err = h.Manager.Acquire(b.Client)
		case "/native/api/start":
			state, err = h.Manager.Start(b.Client, b.Epoch, b.Operation, b.Title, b.Prompt)
		case "/native/api/resume":
			state, err = h.Manager.Resume(b.Client, b.Epoch)
		case "/native/api/interrupt":
			err = h.Manager.Interrupt(b.Client, b.Epoch)
			state = h.Manager.Snapshot()
		case "/native/api/handoff":
			err = h.Manager.Handoff(b.Client, b.Epoch)
			state = h.Manager.Snapshot()
		case "/native/api/decide":
			err = h.Manager.Decide(b.Client, b.Epoch, b.Approval, b.Fingerprint, b.Decision)
			state = h.Manager.Snapshot()
		default:
			nativeJSON(w, 404, map[string]string{"error": "not found"})
			return
		}
		if err != nil {
			code := 400
			if errors.Is(err, ErrLease) || errors.Is(err, ErrState) {
				code = 409
			}
			nativeJSON(w, code, map[string]string{"error": err.Error()})
			return
		}
		nativeJSON(w, 200, state)
	})
}
func nativeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
