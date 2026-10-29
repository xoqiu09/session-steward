package server

import (
	"net/http"
)

func (s *Server) projectRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects", s.panel(func(w http.ResponseWriter, r *http.Request) {
		projects, err := s.Core.Projects(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, projects)
	}))
	mux.HandleFunc("POST /api/projects/archive", s.panel(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			IDs      []int64 `json:"ids"`
			Archived *bool   `json:"archived"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		if body.Archived == nil {
			fail(w, r, 400, "请选择归档或恢复")
			return
		}
		if err := s.Core.ArchiveProjects(r.Context(), body.IDs, *body.Archived); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
}
