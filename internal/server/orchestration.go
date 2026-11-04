package server

import (
	"encoding/json"
	"io"
	"net/http"

	"github.com/xoqiu09/session-steward/internal/core"
)

// All orchestration routes are local-user only, including GET. Hook and hub credentials cannot write.
func (s *Server) orchestrationRoutes(mux *http.ServeMux) {
	local := func(h http.HandlerFunc) http.HandlerFunc {
		return s.panel(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			if !localControlRequest(r) {
				fail(w, r, 403, "编排控制只在执行任务的这台电脑上可用")
				return
			}
			h(w, r)
		})
	}
	read := func(w http.ResponseWriter, r *http.Request, v any) bool {
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10))
		d.DisallowUnknownFields()
		if err := d.Decode(v); err != nil {
			fail(w, r, 400, "请求字段或内容不正确")
			return false
		}
		var extra any
		if err := d.Decode(&extra); err != io.EOF {
			fail(w, r, 400, "只接受一份完整请求")
			return false
		}
		return true
	}
	mux.HandleFunc("GET /api/orchestration", local(func(w http.ResponseWriter, r *http.Request) {
		v, err := s.Core.OrchestrationView(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, v)
	}))
	mux.HandleFunc("POST /api/orchestration/mode", local(func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Mode string `json:"mode"`
		}
		if !read(w, r, &b) {
			return
		}
		if err := s.Core.SetOrchestrationMode(r.Context(), b.Mode); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/orchestration/mandates", local(func(w http.ResponseWriter, r *http.Request) {
		var b core.OrchestrationGrant
		if !read(w, r, &b) {
			return
		}
		if err := s.Core.GrantOrchestration(r.Context(), b); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/orchestration/mandates/{item}/revoke", local(func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Revision string `json:"revision"`
		}
		if !read(w, r, &b) {
			return
		}
		if err := s.Core.RevokeOrchestration(r.Context(), r.PathValue("item"), b.Revision); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/orchestration/mandates/{item}/feedback", local(func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Revision   string `json:"revision"`
			Source     string `json:"source"`
			Input      string `json:"input"`
			StoreInput bool   `json:"store_input"`
		}
		if !read(w, r, &b) {
			return
		}
		if err := s.Core.OrchestrationFeedback(r.Context(), r.PathValue("item"), b.Revision, b.Source, b.Input, b.StoreInput); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/orchestration/findings/{id}/acknowledge", local(func(w http.ResponseWriter, r *http.Request) {
		if err := s.Core.AcknowledgeOrchestrationFinding(r.Context(), r.PathValue("id")); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/orchestration/deliveries/{id}/reconcile", local(func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Revision string `json:"revision"`
			Action   string `json:"action"`
		}
		if !read(w, r, &b) {
			return
		}
		if err := s.Core.ReconcileOrchestrationDelivery(r.Context(), r.PathValue("id"), b.Revision, b.Action); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))

}
