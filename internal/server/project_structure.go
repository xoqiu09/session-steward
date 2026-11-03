package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/projectstructure"
)

type structureRequest struct {
	Provider     string          `json:"provider,omitempty"`
	Session      string          `json:"session,omitempty"`
	Host         string          `json:"host,omitempty"`
	Cwd          string          `json:"cwd,omitempty"`
	BaseRevision string          `json:"base_revision"`
	Document     json.RawMessage `json:"document"`
	Origin       string          `json:"origin,omitempty"` // panel import may identify an Agent-authored suggestion
}

func readStructureRequest(w http.ResponseWriter, r *http.Request, b *structureRequest) error {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, projectstructure.MaxBytes+4096))
	dec.DisallowUnknownFields()
	if err := dec.Decode(b); err != nil {
		return fmt.Errorf("%w: %v", core.ErrBadRequest, err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("%w: 只接受一份请求", core.ErrBadRequest)
	}
	return nil
}

func (s *Server) structureRepo(r *http.Request, b structureRequest) (int64, error) {
	provider, session, err := s.Core.ResolveSession(r.Context(), b.Host, b.Provider, b.Session, b.Cwd)
	if err != nil {
		return 0, err
	}
	item, err := s.Core.SessionItemAt(r.Context(), b.Host, provider, session, time.Now().UTC())
	if err != nil {
		return 0, err
	}
	var repo int64
	if err = s.Core.St.R().QueryRowContext(r.Context(), `SELECT COALESCE(repo_id,0) FROM work_items WHERE id=?`, item).Scan(&repo); err != nil || repo == 0 {
		return 0, fmt.Errorf("%w: 请先关联本项目工作项", core.ErrBadRequest)
	}
	return repo, nil
}

func (s *Server) projectStructureRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/projects/{repo}/structure", s.panel(func(w http.ResponseWriter, r *http.Request) {
		repo, err := strconv.ParseInt(r.PathValue("repo"), 10, 64)
		if err != nil || repo <= 0 {
			writeErr(w, core.ErrBadRequest)
			return
		}
		p, err := s.Core.ProjectStructure(r.Context(), repo)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"structure": p})
	}))
	mux.HandleFunc("PUT /api/projects/{repo}/structure", s.panel(func(w http.ResponseWriter, r *http.Request) {
		repo, err := strconv.ParseInt(r.PathValue("repo"), 10, 64)
		if err != nil || repo <= 0 {
			writeErr(w, core.ErrBadRequest)
			return
		}
		var b structureRequest
		if err = readStructureRequest(w, r, &b); err != nil {
			writeErr(w, err)
			return
		}
		author := b.Origin
		if author == "" {
			author = "user"
		}
		if author != "user" && author != "agent" {
			writeErr(w, core.ErrBadRequest)
			return
		}
		p, err := s.Core.SaveProjectStructure(r.Context(), repo, b.Document, b.BaseRevision, author)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"structure": p})
	}))
	for _, action := range []string{"read", "write"} {
		mux.HandleFunc("POST /hook/structure/"+action, s.ingest(func(w http.ResponseWriter, r *http.Request) {
			var b structureRequest
			if err := readStructureRequest(w, r, &b); err != nil {
				writeErr(w, err)
				return
			}
			if b.Origin != "" {
				writeErr(w, core.ErrBadRequest)
				return
			}
			repo, err := s.structureRepo(r, b)
			if err != nil {
				writeErr(w, err)
				return
			}
			var p *core.ProjectStructure
			if action == "read" {
				p, err = s.Core.ProjectStructure(r.Context(), repo)
			} else {
				p, err = s.Core.SaveProjectStructure(r.Context(), repo, b.Document, b.BaseRevision, "agent")
			}
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, map[string]any{"structure": p})
		}))
	}
}
