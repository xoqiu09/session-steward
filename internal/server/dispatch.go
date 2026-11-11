package server

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/nativecontrol"
)

// Project identity is panel-only. Use the same stored Git common directory as
// Core.launch; deriving a root from the display name would confuse same-name clones.
type dispatchProjectView struct {
	core.DispatchProject
	CommonDir string `json:"common_dir"`
}

type dispatchPanelView struct {
	nativecontrol.DeskView
	Projects []dispatchProjectView `json:"projects"`
}

func (s *Server) dispatchView(ctx context.Context, v nativecontrol.DeskView) (dispatchPanelView, error) {
	out := dispatchPanelView{DeskView: v, Projects: make([]dispatchProjectView, 0, len(v.Projects))}
	rows, err := s.Core.St.R().QueryContext(ctx, `SELECT d.repo_id,r.common_dir FROM dispatch_projects d JOIN repos r ON r.id=d.repo_id`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	paths := map[int64]string{}
	for rows.Next() {
		var id int64
		var path string
		if err := rows.Scan(&id, &path); err != nil {
			return out, err
		}
		paths[id] = path
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	for _, p := range v.Projects {
		out.Projects = append(out.Projects, dispatchProjectView{DispatchProject: p, CommonDir: paths[p.RepoID]})
	}
	return out, nil
}

// localControlRequest：派活路由只给本机用。对端和访问的主机名都必须是回环地址，且不带任何转发标记；
// 经 Tailscale Serve 等反向代理进来的请求即使来自 127.0.0.1 也一律拒绝。7790/8444 的远程派活留给 K3。
func localControlRequest(r *http.Request) bool {
	addr, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(addr)
	h := hostOnly(r.Host)
	if err != nil || ip == nil || !ip.IsLoopback() || (h != "localhost" && h != "127.0.0.1" && h != "::1") {
		return false
	}
	for name := range r.Header {
		name = strings.ToLower(name)
		if name == "forwarded" || strings.HasPrefix(name, "x-forwarded-") || strings.HasPrefix(name, "tailscale-") {
			return false
		}
	}
	return true
}

func (s *Server) dispatchRoutes(mux *http.ServeMux) {
	local := func(h func(w http.ResponseWriter, r *http.Request, d *nativecontrol.Desk)) http.HandlerFunc {
		return s.panel(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			if !localControlRequest(r) {
				fail(w, r, http.StatusForbidden, "派活台只能在执行任务的这台电脑上打开")
				return
			}
			if s.Dispatch == nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{"available": false, "error": dispatchUnavailable(s.DispatchUnavailable)})
				return
			}
			h(w, r, s.Dispatch)
		})
	}
	type body struct {
		Client      string `json:"client"`
		Epoch       int    `json:"epoch"`
		Force       bool   `json:"force"`
		Operation   string `json:"operation"`
		RepoID      int64  `json:"repo_id"`
		Allowed     bool   `json:"allowed"`
		Title       string `json:"title"`
		Prompt      string `json:"prompt"`
		Approval    string `json:"approval"`
		Fingerprint string `json:"fingerprint"`
		Decision    string `json:"decision"`
	}
	read := func(w http.ResponseWriter, r *http.Request) (body, bool) {
		var b body
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		d.DisallowUnknownFields()
		if err := d.Decode(&b); err != nil {
			fail(w, r, http.StatusBadRequest, "请求格式不对")
			return b, false
		}
		return b, true
	}
	reply := func(w http.ResponseWriter, v any, err error) {
		if errors.Is(err, nativecontrol.ErrLease) || errors.Is(err, nativecontrol.ErrState) {
			body := map[string]any{"error": err.Error()}
			// 被拒时带上任务的最新样子，页面不用再查一次；没有任务就不带。
			if t, ok := v.(nativecontrol.TaskView); ok && t.ID != "" {
				body["task"] = t
			}
			writeJSON(w, http.StatusConflict, body)
			return
		}
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	}
	deskReply := func(w http.ResponseWriter, r *http.Request, v nativecontrol.DeskView, err error) {
		if err != nil {
			reply(w, nil, err)
			return
		}
		panel, err := s.dispatchView(r.Context(), v)
		reply(w, panel, err)
	}
	const device = nativecontrol.LocalDevice

	mux.HandleFunc("GET /api/dispatch", local(func(w http.ResponseWriter, r *http.Request, d *nativecontrol.Desk) {
		deskReply(w, r, d.View(), nil)
	}))
	mux.HandleFunc("GET /api/dispatch/tasks/{id}", local(func(w http.ResponseWriter, r *http.Request, d *nativecontrol.Desk) {
		v, err := d.Task(r.PathValue("id"))
		reply(w, v, err)
	}))
	mux.HandleFunc("POST /api/dispatch/acquire", local(func(w http.ResponseWriter, r *http.Request, d *nativecontrol.Desk) {
		if b, ok := read(w, r); ok {
			v, err := d.Acquire(b.Client, device, b.Force)
			deskReply(w, r, v, err)
		}
	}))
	mux.HandleFunc("POST /api/dispatch/release-background", local(func(w http.ResponseWriter, r *http.Request, d *nativecontrol.Desk) {
		if b, ok := read(w, r); ok {
			if err := d.ReleaseBackground(b.Client, b.Epoch, device); err != nil {
				reply(w, nil, err)
				return
			}
			deskReply(w, r, d.View(), nil)
		}
	}))
	mux.HandleFunc("POST /api/dispatch/projects", local(func(w http.ResponseWriter, r *http.Request, d *nativecontrol.Desk) {
		if b, ok := read(w, r); ok {
			if err := s.Core.SetDispatchProject(r.Context(), b.RepoID, b.Allowed); err != nil {
				writeErr(w, err)
				return
			}
			deskReply(w, r, d.View(), nil)
		}
	}))
	mux.HandleFunc("POST /api/dispatch/tasks", local(func(w http.ResponseWriter, r *http.Request, d *nativecontrol.Desk) {
		if b, ok := read(w, r); ok {
			v, err := d.Create(b.Client, b.Epoch, device, b.Operation, b.RepoID, b.Title, b.Prompt)
			reply(w, v, err)
		}
	}))
	mux.HandleFunc("POST /api/dispatch/tasks/{id}/{action}", local(func(w http.ResponseWriter, r *http.Request, d *nativecontrol.Desk) {
		b, ok := read(w, r)
		if !ok {
			return
		}
		id := r.PathValue("id")
		var v nativecontrol.TaskView
		var err error
		switch r.PathValue("action") {
		case "start":
			v, err = d.Start(b.Client, b.Epoch, device, id, b.Operation, b.Prompt)
		case "resume":
			v, err = d.Resume(b.Client, b.Epoch, device, id)
		case "interrupt":
			v, err = d.Interrupt(b.Client, b.Epoch, device, id)
		case "handoff":
			v, err = d.Handoff(b.Client, b.Epoch, device, id)
		case "decide":
			v, err = d.Decide(b.Client, b.Epoch, device, id, b.Approval, b.Fingerprint, b.Decision)
		default:
			fail(w, r, http.StatusNotFound, "not found")
			return
		}
		reply(w, v, err)
	}))
}

// dispatchApproval：派活台的审批必须在派活台看完命令再处理，普通审批接口不能绕过控制租约。
func (s *Server) dispatchApproval(w http.ResponseWriter, r *http.Request) bool {
	if s.Dispatch != nil && s.Dispatch.OwnsApproval(r.PathValue("id")) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "这是派活台的请求，请在派活台查看命令后处理"})
		return true
	}
	return false
}

func dispatchUnavailable(reason string) string {
	if reason == "" {
		return "这台电脑没有找到 Codex，派活台不可用"
	}
	return reason
}
