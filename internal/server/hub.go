package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
)

// Hub 多设备合并（默认关闭）。中心机（hub）接收各设备推来的摘要；其他设备（agent）每 15 秒推一次，
// 并从中心取回合并视图。推送和取回只认共享密钥，不认面板 cookie；其余接口的远程只读规则不变。
type Hub struct {
	Role     string // "hub" | "agent"
	Secret   string
	URL      string // agent：中心机地址
	SelfID   string
	SelfName string
	Client   *http.Client

	mu      sync.Mutex
	lastAt  string
	lastErr string
}

func (h *Hub) record(err error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.lastAt = time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		h.lastErr = err.Error()
	} else {
		h.lastErr = ""
	}
}

func (h *Hub) client() *http.Client {
	if h.Client != nil {
		return h.Client
	}
	return &http.Client{Timeout: 10 * time.Second}
}

// Push 把本机摘要推给中心（agent 用）。
func (h *Hub) Push(ctx context.Context, c *core.Core) error {
	sum, err := c.HubLocalSummary(ctx, h.SelfID, h.SelfName, true)
	if err != nil {
		h.record(err)
		return err
	}
	b, _ := json.Marshal(sum)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(h.URL, "/")+"/api/hub/push", bytes.NewReader(b))
	if err != nil {
		h.record(err)
		return err
	}
	req.Header.Set("Authorization", "Bearer "+h.Secret)
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.client().Do(req)
	if err == nil {
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			err = fmt.Errorf("中心机返回 %d", resp.StatusCode)
		}
	}
	h.record(err)
	return err
}

func (s *Server) hubAuth(r *http.Request) bool {
	if s.Hub == nil || s.Hub.Role != "hub" {
		return false
	}
	return eq(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), s.Hub.Secret)
}

func (s *Server) handleHubPush(w http.ResponseWriter, r *http.Request) {
	if !s.hubAuth(r) {
		fail(w, r, http.StatusUnauthorized, "unauthorized")
		return
	}
	var sum core.HubSummary
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20)).Decode(&sum); err != nil {
		writeErr(w, fmt.Errorf("%w: %v", core.ErrBadRequest, err))
		return
	}
	if sum.DeviceID == s.Hub.SelfID {
		writeErr(w, fmt.Errorf("%w: 设备编号与中心机相同", core.ErrBadRequest))
		return
	}
	if err := s.Core.HubStore(r.Context(), sum); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) handleHubPull(w http.ResponseWriter, r *http.Request) {
	if !s.hubAuth(r) {
		fail(w, r, http.StatusUnauthorized, "unauthorized")
		return
	}
	snap, err := s.Core.HubMerged(r.Context(), s.Hub.SelfID, s.Hub.SelfName)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, 200, snap)
}

// handleHubSnapshot：面板的“全部设备”视图。中心机就地合并；其他设备向中心取回。
func (s *Server) handleHubSnapshot(w http.ResponseWriter, r *http.Request) {
	switch {
	case s.Hub == nil || s.Hub.Role == "":
		fail(w, r, http.StatusNotFound, "没有开启多设备")
	case s.Hub.Role == "hub":
		snap, err := s.Core.HubMerged(r.Context(), s.Hub.SelfID, s.Hub.SelfName)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, snap)
	default:
		req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, strings.TrimRight(s.Hub.URL, "/")+"/api/hub/pull", nil)
		if err != nil {
			writeErr(w, err)
			return
		}
		req.Header.Set("Authorization", "Bearer "+s.Hub.Secret)
		resp, err := s.Hub.client().Do(req)
		if err != nil {
			fail(w, r, http.StatusBadGateway, "连不上中心机："+err.Error())
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			fail(w, r, http.StatusBadGateway, fmt.Sprintf("中心机返回 %d", resp.StatusCode))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		io.Copy(w, io.LimitReader(resp.Body, 64<<20))
	}
}

// handleHubStatus：这台设备的多设备设置和最近一次推送结果，不含密钥。
func (s *Server) handleHubStatus(w http.ResponseWriter, r *http.Request) {
	out := map[string]any{"role": ""}
	if s.Hub != nil && s.Hub.Role != "" {
		s.Hub.mu.Lock()
		out = map[string]any{"role": s.Hub.Role, "device": s.Hub.SelfName, "device_id": s.Hub.SelfID, "url": s.Hub.URL, "last_push_at": s.Hub.lastAt, "last_error": s.Hub.lastErr}
		s.Hub.mu.Unlock()
	}
	writeJSON(w, 200, out)
}
