package server

import (
	"net/http"
	"net/url"

	"github.com/xoqiu09/session-steward/internal/core"
)

// 直播展示：OBS 浏览器源用展示令牌登录，只能读已脱敏的小镇快照和说明文字。
// 展示令牌与面板令牌分开；展示 cookie 不能访问任何其他 /api/*。只给本机，远程一律拒绝。

const liveCookie = "steward_live"

// liveAuthed：带着有效展示 cookie 的本机请求。
func (s *Server) liveAuthed(r *http.Request) bool {
	if s.LiveToken == "" || s.isRemote(r) {
		return false
	}
	c, err := r.Cookie(liveCookie)
	return err == nil && eq(c.Value, s.LiveToken)
}

// liveLocal：展示相关接口只给本机，且需要已配置展示令牌。
func (s *Server) liveLocal(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.isRemote(r) {
			fail(w, r, http.StatusForbidden, "直播展示只允许本机访问")
			return
		}
		if s.LiveToken == "" {
			fail(w, r, http.StatusNotFound, "直播展示未启用")
			return
		}
		h(w, r)
	}
}

// liveRead：展示 cookie 或面板 cookie 都能读。
func (s *Server) liveRead(h http.HandlerFunc) http.HandlerFunc {
	return s.liveLocal(func(w http.ResponseWriter, r *http.Request) {
		if !s.liveAuthed(r) && !s.panelAuthed(r) {
			fail(w, r, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	})
}

func (s *Server) liveRoutes(mux *http.ServeMux) {
	// Drafts and playback controls are owner-only; the display receives the approved subset in /note.
	mux.HandleFunc("GET /api/live/content", s.liveLocal(s.panel(func(w http.ResponseWriter, r *http.Request) {
		out, err := s.Core.LiveContent(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, out)
	})))
	mux.HandleFunc("PUT /api/live/content", s.liveLocal(s.panel(func(w http.ResponseWriter, r *http.Request) {
		var in core.LiveContentUpdate
		if err := readJSON(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		out, err := s.Core.SetLiveContent(r.Context(), in)
		if err != nil {
			writeErr(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, out)
	})))
	mux.HandleFunc("GET /live", s.liveLocal(s.handleLiveLogin))
	mux.HandleFunc("GET /api/live/snapshot", s.liveRead(func(w http.ResponseWriter, r *http.Request) {
		snap, err := s.Core.Snapshot(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, core.LiveSnapshot(snap, []byte("steward-live\x00"+s.LiveToken)))
	}))
	mux.HandleFunc("GET /api/live/note", s.liveRead(func(w http.ResponseWriter, r *http.Request) {
		n, err := s.Core.LiveNote(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, n)
	}))
	// 写说明和取展示地址只给已登录的本机面板（panel 包装里有同源与 X-Steward 检查）。
	mux.HandleFunc("PUT /api/live/note", s.liveLocal(s.panel(func(w http.ResponseWriter, r *http.Request) {
		var in core.LiveNote
		if err := readJSON(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		n, err := s.Core.SetLiveNote(r.Context(), in)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, n)
	})))
	mux.HandleFunc("GET /api/live/link", s.liveLocal(s.panel(func(w http.ResponseWriter, r *http.Request) {
		u := url.URL{Scheme: "http", Host: r.Host, Path: "/live", RawQuery: url.Values{"k": {s.LiveToken}}.Encode()}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, map[string]string{"url": u.String(), "view": "/?view=town&live=1"})
	})))
	// Only the local owner can trigger one of three visual gestures. Display cookies stay read-only.
	mux.HandleFunc("PUT /api/live/residents", s.liveLocal(s.panel(func(w http.ResponseWriter, r *http.Request) {
		var in core.LiveResidents
		if err := readJSON(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		out, err := s.Core.SetLiveResidents(r.Context(), in)
		if err != nil {
			writeErr(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, out)
	})))
	mux.HandleFunc("POST /api/live/companion", s.liveLocal(s.panel(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Kind string `json:"kind"`
		}
		if err := readJSON(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		a, err := s.Core.SetLiveCompanion(r.Context(), in.Kind)
		if err != nil {
			writeErr(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, 200, a)
	})))
}

func (s *Server) handleLiveLogin(w http.ResponseWriter, r *http.Request) {
	if !eq(r.URL.Query().Get("k"), s.LiveToken) {
		fail(w, r, http.StatusUnauthorized, "unauthorized")
		return
	}
	// Lax：OBS 等直接打开地址时也能带上；这个 cookie 只能读脱敏后的展示数据。
	http.SetCookie(w, &http.Cookie{Name: liveCookie, Value: s.LiveToken, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: 365 * 24 * 3600})
	http.Redirect(w, r, "/?view=town&live=1", http.StatusSeeOther)
}

// liveIndex：展示 cookie 只能在 URL 带 live=1 时拿到首页。
func (s *Server) liveIndex(r *http.Request) bool {
	return r.URL.Path == "/" && r.URL.Query().Get("live") == "1" && s.liveAuthed(r)
}
