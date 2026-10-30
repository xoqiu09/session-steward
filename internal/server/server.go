// Package server 提供 HTTP 接口：hook 采集（采集 token）与面板 API（面板凭据），以及 SSE 推送。
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/install"
)

type Server struct {
	BuildCommit    string
	ReportingHints bool
	Core           *core.Core
	IngestToken    string
	PanelToken     string
	PermWait       time.Duration
	Static         fs.FS // 前端构建产物，可为 nil
	Listen         string
	// 远程访问（默认关闭）：允许的反向代理 HTTPS 主机名，以及远程设备 token。
	RemoteHosts []string
	RemoteToken string
	// 多设备合并（默认 nil，关闭）。
	Hub *Hub
	// 只读 hooks 覆盖情况；版本命令由独立 Monitor 限时和缓存。
	HookCoverage func(context.Context) []install.Coverage
}

func (s *Server) remoteHost(host string) bool {
	for _, h := range s.RemoteHosts {
		if h != "" && strings.EqualFold(h, host) {
			return true
		}
	}
	return false
}

func hostOnly(h string) string {
	if i := strings.LastIndex(h, ":"); i >= 0 && !strings.HasSuffix(h, "]") {
		h = h[:i]
	}
	return strings.Trim(h, "[]")
}

// remoteBlocked：远程全局只读。新增 API 默认不能从远程写入；终端画面也仅本机可见。
func remoteBlocked(method, path string) bool {
	if strings.HasPrefix(path, "/api/managed") || strings.HasSuffix(path, "/conversation") {
		return true // 包括只读终端画面：终端可能显示敏感内容
	}
	return method != http.MethodGet && method != http.MethodHead
}

// isRemote：请求经由允许的远程主机名到达（反向代理保留原 Host）。
func (s *Server) isRemote(r *http.Request) bool { return s.remoteHost(hostOnly(r.Host)) }

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	// 采集接口：只接受采集 token
	mux.HandleFunc("POST /hook/event", s.ingest(s.handleEvent))
	mux.HandleFunc("POST /hook/permission", s.ingest(s.handlePermission))
	mux.HandleFunc("POST /hook/permission/{id}/delivered", s.ingest(s.handleDelivered))
	mux.HandleFunc("POST /hook/agent-action", s.ingest(s.handleAgentAction))
	mux.HandleFunc("POST /hook/features/list", s.ingest(func(w http.ResponseWriter, r *http.Request) {
		var b struct {
			Provider string `json:"provider"`
			Session  string `json:"session"`
			Host     string `json:"host"`
			Cwd      string `json:"cwd"`
		}
		if err := readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		prov, sid, err := s.Core.ResolveSession(r.Context(), b.Host, b.Provider, b.Session, b.Cwd)
		if err != nil {
			writeErr(w, err)
			return
		}
		item, err := s.Core.SessionItemAt(r.Context(), b.Host, prov, sid, time.Now().UTC())
		if err != nil {
			writeErr(w, err)
			return
		}
		snap, err := s.Core.Snapshot(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		var repo int64
		for _, w := range snap.WorkItems {
			if w.ID == item && w.RepoID != nil {
				repo = *w.RepoID
			}
		}
		if repo == 0 {
			writeErr(w, fmt.Errorf("%w: 请先关联本项目工作项", core.ErrBadRequest))
			return
		}
		fs := []core.ProjectFeature{}
		for _, f := range snap.Features {
			if f.RepoID == repo {
				fs = append(fs, f)
			}
		}
		writeJSON(w, 200, fs)
	}))
	mux.HandleFunc("GET /hook/ping", s.ingest(func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]bool{"ok": true}) }))

	// 面板接口：只接受面板凭据
	mux.HandleFunc("GET /api/version", s.panel(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]string{"commit": s.BuildCommit})
	}))
	mux.HandleFunc("GET /api/snapshot", s.panel(s.handleSnapshot))
	mux.HandleFunc("GET /api/hooks/status", s.panel(func(w http.ResponseWriter, r *http.Request) {
		if s.HookCoverage == nil {
			writeJSON(w, 200, []install.Coverage{})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		writeJSON(w, 200, s.HookCoverage(ctx))
	}))
	mux.HandleFunc("POST /api/features/{repo}/{id}/confirm-scope", s.panel(func(w http.ResponseWriter, r *http.Request) {
		repo, err := pathInt(r, "repo")
		if err != nil {
			writeErr(w, err)
			return
		}
		var b struct {
			Revision string `json:"revision"`
		}
		if err = readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		if err = s.Core.ConfirmFeatureScope(r.Context(), repo, r.PathValue("id"), b.Revision); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/features/{repo}/{id}/accept", s.panel(func(w http.ResponseWriter, r *http.Request) {
		repo, err := pathInt(r, "repo")
		if err != nil {
			writeErr(w, err)
			return
		}
		var b struct {
			Candidate string `json:"candidate"`
			Revision  string `json:"revision"`
			Decision  string `json:"decision"`
		}
		if err = readJSON(r, &b); err != nil {
			writeErr(w, err)
			return
		}
		if err = s.Core.AcceptFeature(r.Context(), repo, r.PathValue("id"), b.Candidate, b.Revision, b.Decision); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/attributions/reconcile", s.panel(func(w http.ResponseWriter, r *http.Request) {
		n, err := s.Core.ReconcileAttributions(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]int{"changed": n})
	}))
	mux.HandleFunc("POST /api/attributions/decide", s.panel(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Decisions []core.AttributionDecision `json:"decisions"`
		}
		if err := readJSON(r, &body); err != nil {
			writeErr(w, err)
			return
		}
		if err := s.Core.DecideAttributions(r.Context(), body.Decisions); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/stream", s.panel(s.handleStream))
	mux.HandleFunc("GET /api/sessions/{id}/events", s.panel(s.handleSessionEvents))
	mux.HandleFunc("GET /api/sessions/{id}/usage", s.panel(s.handleSessionUsage))
	mux.HandleFunc("GET /api/sessions/{id}/conversation", s.panel(s.handleConversation))
	mux.HandleFunc("GET /api/history", s.panel(s.handleHistory))
	// 多设备：推送和取回只认共享密钥（中心机经 Tailscale 被其他设备访问）；面板用的两个接口仍要面板登录。
	mux.HandleFunc("POST /api/hub/push", s.handleHubPush)
	mux.HandleFunc("GET /api/hub/pull", s.handleHubPull)
	mux.HandleFunc("GET /api/hub/snapshot", s.panel(s.handleHubSnapshot))
	mux.HandleFunc("GET /api/hub/status", s.panel(s.handleHubStatus))
	mux.HandleFunc("GET /api/history/day", s.panel(s.handleHistoryDay))
	mux.HandleFunc("POST /api/sessions/{id}/bind", s.panel(s.handleBind))
	mux.HandleFunc("POST /api/sessions/{id}/unbind", s.panel(s.handleUnbind))
	mux.HandleFunc("POST /api/work-items", s.panel(s.handleCreateItem))
	mux.HandleFunc("PATCH /api/work-items/{id}", s.panel(s.handlePatchItem))
	mux.HandleFunc("POST /api/work-items/{id}/brief", s.panel(s.handleEditBrief))
	mux.HandleFunc("GET /api/work-items/{id}/brief/history", s.panel(func(w http.ResponseWriter, r *http.Request) {
		h, err := s.Core.BriefHistory(r.Context(), r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, h)
	}))
	mux.HandleFunc("POST /api/deps", s.panel(s.handleAddDep))
	mux.HandleFunc("DELETE /api/deps", s.panel(s.handleRemoveDep))
	mux.HandleFunc("POST /api/runs/{id}/outcome", s.panel(s.handleRunOutcome))
	mux.HandleFunc("POST /api/approvals/{id}/decide", s.panel(s.handleDecide))
	mux.HandleFunc("POST /api/approvals/{id}/dismiss", s.panel(s.handleDismiss))
	mux.HandleFunc("POST /api/approvals/{id}/approve-merge", s.panel(s.handleApproveMerge))
	mux.HandleFunc("POST /api/approvals/{id}/reject-merge", s.panel(s.handleRejectMerge))
	mux.HandleFunc("POST /api/approvals/{id}/merge-instruction", s.panel(s.handleMergeInstruction))
	mux.HandleFunc("POST /api/approvals/{id}/checked-merge", s.panel(func(w http.ResponseWriter, r *http.Request) {
		j, err := s.Core.StartMergeGate(r.Context(), r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, j)
	}))
	mux.HandleFunc("POST /api/scan/merges", s.panel(func(w http.ResponseWriter, r *http.Request) {
		if err := s.Core.SyncMerges(r.Context(), true); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/merge-sync", s.panel(func(w http.ResponseWriter, r *http.Request) {
		statuses, err := s.Core.MergeSyncStatuses(r.Context())
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, statuses)
	}))
	s.managedRoutes(mux)
	s.projectRoutes(mux)
	mux.HandleFunc("GET /login", s.handleLogin)

	if s.Static != nil {
		files := http.FileServerFS(s.Static)
		mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				if _, err := fs.Stat(s.Static, strings.TrimPrefix(r.URL.Path, "/")); err == nil {
					files.ServeHTTP(w, r)
					return
				}
			}
			if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/hook/") {
				// 未注册的接口不能回落到 index.html，否则前端会把 HTML 当作接口响应
				fail(w, r, http.StatusNotFound, "not found")
				return
			}
			if !s.panelAuthed(r) {
				fail(w, r, http.StatusUnauthorized, "请通过 steward open 打开面板（需要登录链接）")
				return
			}
			b, err := fs.ReadFile(s.Static, "index.html")
			if err != nil {
				fail(w, r, 500, "前端未构建")
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(b)
		})
	}
	return s.guard(mux)
}

// guard 拒绝非回环 Host，防止 DNS rebinding。
func (s *Server) guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := hostOnly(r.Host)
		remote := s.remoteHost(host)
		if host != "127.0.0.1" && host != "localhost" && host != "::1" && !remote {
			fail(w, r, http.StatusForbidden, "forbidden host")
			return
		}
		if remote {
			// 远程只开放面板接口；采集接口只给本机 hooks
			if strings.HasPrefix(r.URL.Path, "/hook/") {
				fail(w, r, http.StatusForbidden, "forbidden")
				return
			}
			w.Header().Set("Strict-Transport-Security", "max-age=31536000")
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

func eq(a, b string) bool {
	return a != "" && b != "" && subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

func (s *Server) ingest(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !eq(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), s.IngestToken) {
			fail(w, r, http.StatusUnauthorized, "unauthorized")
			return
		}
		h(w, r)
	}
}

const cookieName = "steward_panel"

const remoteCookie = "steward_remote"

// panelAuthed：本机用面板 token；远程主机只接受远程设备 token（本机 token 在远程无效，反之亦然）。
func (s *Server) panelAuthed(r *http.Request) bool {
	if s.isRemote(r) {
		c, err := r.Cookie(remoteCookie)
		return err == nil && eq(c.Value, s.RemoteToken)
	}
	if c, err := r.Cookie(cookieName); err == nil && eq(c.Value, s.PanelToken) {
		return true
	}
	return false
}

func (s *Server) originOK(r *http.Request) bool {
	return requestOriginOK(r, s.isRemote(r))
}

func (s *Server) panel(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.panelAuthed(r) {
			fail(w, r, http.StatusUnauthorized, "unauthorized")
			return
		}
		// 写操作要求同源，配合 SameSite=Strict cookie 防 CSRF
		if s.isRemote(r) && remoteBlocked(r.Method, r.URL.Path) {
			fail(w, r, http.StatusForbidden, "远程访问不允许此操作，请在本机面板进行")
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if !s.originOK(r) {
				fail(w, r, http.StatusForbidden, "bad origin")
				return
			}
			if r.Header.Get("X-Steward") != "1" {
				fail(w, r, http.StatusForbidden, "missing X-Steward header")
				return
			}
		}
		r = r.WithContext(core.PanelSignalContext(r.Context(), r.Pattern, r.PathValue("id")))
		h(w, r)
	}
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if s.isRemote(r) {
		if !eq(r.URL.Query().Get("t"), s.RemoteToken) {
			fail(w, r, http.StatusUnauthorized, "unauthorized")
			return
		}
		http.SetCookie(w, &http.Cookie{Name: remoteCookie, Value: s.RemoteToken, Path: "/", HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode, MaxAge: 30 * 24 * 3600})
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	if !eq(r.URL.Query().Get("t"), s.PanelToken) {
		fail(w, r, http.StatusUnauthorized, "unauthorized")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: s.PanelToken, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: 30 * 24 * 3600})
	http.Redirect(w, r, loginNext(r.URL.Query().Get("next")), http.StatusSeeOther)
}

// loginNext：登录后跳回本站的哪一页（App 用它直接打开小镇）。只接受本站路径，不接受外站或协议相对地址。
func loginNext(next string) string {
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.ContainsAny(next, "\\\r\n") {
		return "/"
	}
	return next
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// fail 返回错误。/api/ 与 /hook/ 等程序调用的接口一律返回 JSON {"error": ...}，前端和 hook 都按 JSON 解析；
// 浏览器直接打开的页面（/、/login 等）返回纯文本，便于阅读。
func fail(w http.ResponseWriter, r *http.Request, code int, msg string) {
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/hook/") {
		writeJSON(w, code, map[string]string{"error": msg})
		return
	}
	http.Error(w, msg, code)
}

func writeErr(w http.ResponseWriter, err error) {
	code := 500
	switch {
	case errors.Is(err, core.ErrNotFound):
		code = 404
	case errors.Is(err, core.ErrConflict), errors.Is(err, core.ErrMismatch):
		code = 409
	case errors.Is(err, core.ErrCycle), errors.Is(err, core.ErrBadRequest):
		code = 400
	}
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func readJSON(r *http.Request, v any) error {
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		return err
	}
	if len(b) == 0 {
		return nil
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("%w: %v", core.ErrBadRequest, err)
	}
	return nil
}

// ---- 采集 ----

func (s *Server) handleEvent(w http.ResponseWriter, r *http.Request) {
	var batch []event.Event
	b, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		writeErr(w, err)
		return
	}
	trim := strings.TrimSpace(string(b))
	if strings.HasPrefix(trim, "[") {
		err = json.Unmarshal(b, &batch)
	} else {
		var e event.Event
		err = json.Unmarshal(b, &e)
		batch = []event.Event{e}
	}
	if err != nil {
		writeJSON(w, 400, map[string]string{"error": err.Error()})
		return
	}
	// 批次先核对来源再逐条写入，避免非法来源返回 200 或前半批已改变信号。
	for i := range batch {
		if err := core.ValidateIngestChannel(batch[i].Source.Channel); err != nil {
			writeErr(w, err)
			return
		}
	}
	acked := make([]string, 0, len(batch))
	var rejected []map[string]string
	for i := range batch {
		e := &batch[i]
		if e.Kind == event.KindPermission {
			// 异步路径不处理权限请求；只记为观察条目（例如暂存重放）
			e.Kind = event.KindNotifyPerm
		}
		if _, err := s.Core.Ingest(r.Context(), e); err != nil {
			rejected = append(rejected, map[string]string{"event_id": e.EventID, "error": err.Error()})
			if errors.Is(err, context.Canceled) {
				break
			}
			continue
		}
		acked = append(acked, e.EventID)
	}
	response := map[string]any{"acked": acked, "rejected": rejected}
	if s.ReportingHints && len(batch) == 1 && len(acked) == 1 && (batch[0].Kind == event.KindSessionStart || batch[0].Kind == event.KindPrompt) {
		e := batch[0]
		item, show, err := s.Core.ReportingHint(r.Context(), e.Source.HostID, e.Source.Provider, e.SessionID, e.Kind == event.KindSessionStart)
		if err == nil && show {
			response["reporting_hints"] = true
			response["work_item_id"] = item
			if item == "" {
				if previous, err := s.Core.ReportingPreviousItem(r.Context(), e.Source.HostID, e.Source.Provider, e.SessionID); err == nil {
					response["previous_work_item_id"] = previous
				}
			}
		}
	}
	writeJSON(w, 200, response)
}

// handleAgentAction 处理 steward-hook claim/ask/deliver。与普通事件不同，失败要明确告诉 Agent。
func (s *Server) handleAgentAction(w http.ResponseWriter, r *http.Request) {
	var e event.Event
	if err := readJSON(r, &e); err != nil {
		writeErr(w, err)
		return
	}
	if err := core.ValidateIngestChannel(e.Source.Channel); err != nil {
		writeErr(w, err)
		return
	}
	switch e.Kind {
	case event.KindClaim, event.KindAsk, event.KindDeliver, event.KindReport, event.KindBegin, event.KindFeatures:
	default:
		writeErr(w, fmt.Errorf("%w: 不支持的动作", core.ErrBadRequest))
		return
	}
	prov, sid, err := s.Core.ResolveSession(r.Context(), e.Source.HostID, e.Source.Provider, e.SessionID, e.Cwd)
	if err != nil {
		writeJSON(w, 200, map[string]any{"acked": []string{}, "rejected": []map[string]string{{"event_id": e.EventID, "error": err.Error()}}})
		return
	}
	e.Source.Provider, e.SessionID = prov, sid
	if e.Kind == event.KindReport || e.Kind == event.KindDeliver || e.Kind == event.KindFeatures {
		// report 只写入已关联工作项的简报；未关联时明确拒绝，避免回报静默丢失
		item, err := s.Core.SessionItemAt(r.Context(), e.Source.HostID, prov, sid, e.OccurredAt)
		if err != nil {
			writeErr(w, err)
			return
		}
		if item == "" {
			writeJSON(w, 200, map[string]any{"acked": []string{}, "rejected": []map[string]string{{"event_id": e.EventID, "error": "当前会话尚未关联工作项，请先 steward-hook claim ABC-123"}}})
			return
		}
	}
	if e.Kind == event.KindClaim && !s.Core.WorkItemExists(r.Context(), e.WorkTag) {
		writeJSON(w, 200, map[string]any{"acked": []string{}, "rejected": []map[string]string{{"event_id": e.EventID, "error": "工作项 " + e.WorkTag + " 不存在"}}})
		return
	}
	result, err := s.Core.Ingest(r.Context(), &e)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"acked": []string{e.EventID}, "work_item_id": result.WorkItemID})
}

func (s *Server) handlePermission(w http.ResponseWriter, r *http.Request) {
	var e event.Event
	if err := readJSON(r, &e); err != nil {
		writeErr(w, err)
		return
	}
	wait := s.PermWait
	if v, err := strconv.Atoi(r.URL.Query().Get("wait")); err == nil && v > 0 && time.Duration(v)*time.Second < wait {
		wait = time.Duration(v) * time.Second
	}
	id, d, ok, err := s.Core.RequestPermission(r.Context(), &e, wait)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !ok {
		writeJSON(w, 200, map[string]any{"approval_id": id, "decision": nil})
		return
	}
	writeJSON(w, 200, map[string]any{"approval_id": id, "decision": d})
}

func (s *Server) handleDelivered(w http.ResponseWriter, r *http.Request) {
	if err := s.Core.AckDelivered(r.Context(), r.PathValue("id")); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

// ---- 面板 ----

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	// ?at=RFC3339：回放过去某一时刻（只读，小镇时间条用）。
	if v := r.URL.Query().Get("at"); v != "" {
		at, err := core.ReplayParse(v)
		if err != nil {
			writeErr(w, err)
			return
		}
		snap, err := s.Core.SnapshotAt(r.Context(), at)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, snap)
		return
	}
	snap, err := s.Core.Snapshot(r.Context())
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, snap)
}

// handleStream 推送变更游标。客户端带 ?cursor= 或 Last-Event-ID 续传；
// 收到 reset 事件时应重新拉取快照。数据本身通过 /api/snapshot 获取。
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		fail(w, r, 500, "stream unsupported")
		return
	}
	cursor, _ := strconv.ParseInt(r.URL.Query().Get("cursor"), 10, 64)
	if v := r.Header.Get("Last-Event-ID"); v != "" {
		cursor, _ = strconv.ParseInt(v, 10, 64)
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	ch, cancel := s.Core.Subscribe()
	defer cancel()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()

	send := func() bool {
		changes, reset, err := s.Core.St.ChangesSince(r.Context(), cursor, 500)
		if err != nil {
			return false
		}
		if reset {
			latest, _ := s.Core.St.LatestSeq(r.Context())
			cursor = latest
			fmt.Fprintf(w, "id: %d\nevent: reset\ndata: {}\n\n", cursor)
			fl.Flush()
			return true
		}
		if len(changes) == 0 {
			return true
		}
		cursor = changes[len(changes)-1].Seq
		b, _ := json.Marshal(changes)
		fmt.Fprintf(w, "id: %d\nevent: changes\ndata: %s\n\n", cursor, b)
		fl.Flush()
		return true
	}
	fmt.Fprintf(w, "retry: 2000\n\n")
	if !send() {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ch:
			if !send() {
				return
			}
		case <-ping.C:
			fmt.Fprintf(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func pathInt(r *http.Request, k string) (int64, error) {
	v, err := strconv.ParseInt(r.PathValue(k), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%w: id", core.ErrBadRequest)
	}
	return v, nil
}

func (s *Server) handleSessionEvents(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	evs, err := s.Core.SessionEvents(r.Context(), id, 200)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, evs)
}

// handleSessionUsage：会话的 token 明细（按模型、按轮）和子 Agent。用量统计关闭时 enabled=false。
func (s *Server) handleSessionUsage(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	d, err := s.Core.SessionUsage(r.Context(), id)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, d)
}

// handleHistory：历史日历，最近 days 天每天的活动、交付、验收和 token。
func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	days, _ := strconv.Atoi(r.URL.Query().Get("days"))
	h, err := s.Core.History(r.Context(), days, s.Core.UsageDetail != nil)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, h)
}

// handleHistoryDay：某一天的小结，date=YYYY-MM-DD（本机时区）。
func (s *Server) handleHistoryDay(w http.ResponseWriter, r *http.Request) {
	d, err := s.Core.HistoryDay(r.Context(), r.URL.Query().Get("date"), s.Core.UsageDetail != nil)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, d)
}

func (s *Server) handleBind(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		WorkItemID string `json:"work_item_id"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Core.BindManual(r.Context(), id, strings.ToUpper(body.WorkItemID)); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleUnbind(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var body struct {
		Outcome string `json:"outcome"`
	}
	readJSON(r, &body)
	if err := s.Core.Unbind(r.Context(), id, body.Outcome); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleCreateItem(w http.ResponseWriter, r *http.Request) {
	var in core.WorkItemInput
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Core.CreateWorkItem(r.Context(), in); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 201, map[string]string{"id": strings.ToUpper(in.ID)})
}

func (s *Server) handlePatchItem(w http.ResponseWriter, r *http.Request) {
	var p core.WorkItemPatch
	if err := readJSON(r, &p); err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Core.UpdateWorkItem(r.Context(), r.PathValue("id"), p); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

type depBody struct {
	Upstream   string `json:"upstream"`
	Downstream string `json:"downstream"`
	Cond       string `json:"cond"`
}

func (s *Server) handleAddDep(w http.ResponseWriter, r *http.Request) {
	var b depBody
	if err := readJSON(r, &b); err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Core.AddDep(r.Context(), b.Upstream, b.Downstream, b.Cond); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleRemoveDep(w http.ResponseWriter, r *http.Request) {
	var b depBody
	if err := readJSON(r, &b); err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Core.RemoveDep(r.Context(), b.Upstream, b.Downstream); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleRunOutcome(w http.ResponseWriter, r *http.Request) {
	id, err := pathInt(r, "id")
	if err != nil {
		writeErr(w, err)
		return
	}
	var b struct {
		Outcome string `json:"outcome"`
	}
	readJSON(r, &b)
	if err := s.Core.SetRunOutcome(r.Context(), id, b.Outcome); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleDecide(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Fingerprint string `json:"fingerprint"`
		Behavior    string `json:"behavior"`
	}
	if err := readJSON(r, &b); err != nil {
		writeErr(w, err)
		return
	}
	d := core.Decision{Behavior: b.Behavior}
	if b.Behavior == "deny" {
		d.Message = "已在 Session Steward 面板拒绝"
	}
	if err := s.Core.Decide(r.Context(), r.PathValue("id"), b.Fingerprint, d); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleDismiss(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Reason string `json:"reason"`
	}
	readJSON(r, &b)
	if err := s.Core.Dismiss(r.Context(), r.PathValue("id"), b.Reason); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleApproveMerge(w http.ResponseWriter, r *http.Request) {
	var b struct {
		SourceSHA string `json:"source_head_sha"`
		TargetSHA string `json:"target_base_sha"`
	}
	if err := readJSON(r, &b); err != nil {
		writeErr(w, err)
		return
	}
	if err := s.Core.ApproveMerge(r.Context(), r.PathValue("id"), b.SourceSHA, b.TargetSHA); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleRejectMerge(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Reason string `json:"reason"`
	}
	readJSON(r, &b)
	if err := s.Core.RejectMerge(r.Context(), r.PathValue("id"), b.Reason); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleMergeInstruction(w http.ResponseWriter, r *http.Request) {
	text, err := s.Core.MergeInstruction(r.Context(), r.PathValue("id"))
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]string{"text": text})
}

func (s *Server) handleEditBrief(w http.ResponseWriter, r *http.Request) {
	var b core.BriefEdit
	if err := readJSON(r, &b); err != nil {
		writeErr(w, err)
		return
	}
	id, err := s.Core.EditBrief(r.Context(), r.PathValue("id"), b)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "entry_id": id})
}
