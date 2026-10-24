package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
)

// TerminalInterval 是终端画面轮询间隔；画面无变化时不推送。
var TerminalInterval = 500 * time.Millisecond

func (s *Server) managedRoutes(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/managed", s.panel(func(w http.ResponseWriter, r *http.Request) {
		var in core.LaunchInput
		if err := readJSON(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		m, err := s.Core.LaunchManaged(r.Context(), in)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, m)
	}))
	mux.HandleFunc("POST /api/managed/{id}/stop", s.panel(func(w http.ResponseWriter, r *http.Request) {
		if err := s.Core.StopManaged(r.Context(), r.PathValue("id")); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/managed/{id}/archive", s.panel(func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Force bool `json:"force"`
		}
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		dirty, err := s.Core.ArchiveManaged(r.Context(), r.PathValue("id"), b.Force)
		if err != nil {
			if len(dirty) > 0 {
				if len(dirty) > 50 {
					dirty = dirty[:50]
				}
				writeJSON(w, 409, map[string]any{"error": err.Error(), "dirty": dirty})
				return
			}
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/managed/{id}/takeover", s.panel(func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			On bool `json:"on"`
		}
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		if err := s.Core.SetTakeover(r.Context(), r.PathValue("id"), b.On); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/managed/{id}/input", s.panel(func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Text string `json:"text"`
			Key  string `json:"key"`
		}
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		if err := s.Core.SendManagedInput(r.Context(), r.PathValue("id"), b.Text, b.Key); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/managed/{id}/audit", s.panel(func(w http.ResponseWriter, r *http.Request) {
		a, err := s.Core.ManagedAudit(r.Context(), r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, a)
	}))
	mux.HandleFunc("GET /api/managed/{id}/terminal", s.panel(s.handleTerminal))
	mux.HandleFunc("GET /api/review", s.panel(func(w http.ResponseWriter, r *http.Request) {
		days, _ := strconv.Atoi(r.URL.Query().Get("days"))
		rv, err := s.Core.AgentReview(r.Context(), days)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, rv)
	}))
	mux.HandleFunc("GET /api/work-items/{id}/summary", s.panel(func(w http.ResponseWriter, r *http.Request) {
		sm, err := s.Core.LatestSummary(r.Context(), r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"summary": sm})
	}))
	mux.HandleFunc("POST /api/work-items/{id}/summary", s.panel(func(w http.ResponseWriter, r *http.Request) {
		sm, err := s.Core.GenerateSummary(r.Context(), r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"summary": sm})
	}))
	mux.HandleFunc("POST /api/work-items/{id}/handoff/preview", s.panel(func(w http.ResponseWriter, r *http.Request) {
		var in core.HandoffInput
		if err := readJSON(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		in.WorkItemID = r.PathValue("id")
		text, h, err := s.Core.BuildHandoff(r.Context(), in)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"package": text, "source_branch": h.SourceBranch, "source_sha": h.SourceSHA})
	}))
	mux.HandleFunc("POST /api/work-items/{id}/handoff", s.panel(func(w http.ResponseWriter, r *http.Request) {
		var in core.HandoffInput
		if err := readJSON(r, &in); err != nil {
			writeErr(w, err)
			return
		}
		in.WorkItemID = r.PathValue("id")
		h, m, err := s.Core.StartHandoff(r.Context(), in)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"handoff": h, "managed": m})
	}))
}

// handleTerminal 以 SSE 推送托管会话的终端画面（只读）。断线后浏览器自动重连，
// 服务重启后仍在运行的 tmux 会话可以重新接上。
func (s *Server) handleTerminal(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "stream unsupported", 500)
		return
	}
	id := r.PathValue("id")
	text, m, err := s.Core.CaptureManaged(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	fmt.Fprintf(w, "retry: 1000\n\n")
	last, lastState := "\x00", ""
	lastTakeover := false
	send := func(text string, m *core.ManagedSession) {
		if text == last && m.State == lastState && m.Takeover == lastTakeover {
			return
		}
		last, lastState = text, m.State
		lastTakeover = m.Takeover
		b, _ := json.Marshal(map[string]any{"text": text, "state": m.State, "takeover": m.Takeover, "at": time.Now().UTC().Format(time.RFC3339Nano)})
		fmt.Fprintf(w, "event: screen\ndata: %s\n\n", b)
		fl.Flush()
	}
	send(text, m)
	t := time.NewTicker(TerminalInterval)
	defer t.Stop()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			fmt.Fprintf(w, ": ping\n\n")
			fl.Flush()
		case <-t.C:
			text, m, err := s.Core.CaptureManaged(r.Context(), id)
			if err != nil {
				return
			}
			send(text, m)
		}
	}
}
