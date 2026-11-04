package server

import (
	"net/http"
	"strconv"

	"github.com/xoqiu09/session-steward/internal/core"
)

func (s *Server) projectRoutes(mux *http.ServeMux) {
	// 工作目录会动到磁盘，只在项目所在的这台电脑上提供；远程浏览和多设备都不能触发。
	worktrees := func(h func(w http.ResponseWriter, r *http.Request, repo int64)) http.HandlerFunc {
		return s.panel(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			if !localControlRequest(r) {
				fail(w, r, http.StatusForbidden, "工作目录只能在项目所在的电脑上管理")
				return
			}
			repo, err := strconv.ParseInt(r.PathValue("repo"), 10, 64)
			if err != nil || repo <= 0 {
				writeErr(w, core.ErrBadRequest)
				return
			}
			h(w, r, repo)
		})
	}
	mux.HandleFunc("GET /api/projects/{repo}/worktrees", worktrees(func(w http.ResponseWriter, r *http.Request, repo int64) {
		list, err := s.Core.ProjectWorktrees(r.Context(), repo)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"worktrees": list, "trash_available": s.Core.TrashPath != nil})
	}))
	mux.HandleFunc("POST /api/projects/{repo}/worktrees/remove", worktrees(func(w http.ResponseWriter, r *http.Request, repo int64) {
		var body struct {
			Path string `json:"path"`
		}
		if err := readJSON(r, &body); err != nil || body.Path == "" {
			writeErr(w, core.ErrBadRequest)
			return
		}
		if err := s.Core.RemoveWorktree(r.Context(), repo, body.Path); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
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
	mux.HandleFunc("POST /api/projects/trash", s.panel(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			IDs     []int64 `json:"ids"`
			Trashed *bool   `json:"trashed"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		if body.Trashed == nil {
			fail(w, r, 400, "请选择移入回收站或恢复")
			return
		}
		if err := s.Core.TrashProjects(r.Context(), body.IDs, *body.Trashed); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
}
