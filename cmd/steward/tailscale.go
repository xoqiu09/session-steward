package main

import (
	"context"
	"encoding/json"
	"net"
	"net/url"
	"os/exec"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/config"
)

// remoteURL 是其他设备访问本机面板用的地址。
type remoteURL struct {
	URL    string // https://host 或 https://host:port
	Funnel bool   // 这个地址开了 Tailscale Funnel，公网可达
	Found  bool   // 在 tailscale serve 里找到了转发到本机 listen 的条目
}

// remoteBase 找出 tailscale serve 里转发到本机 listen 的 HTTPS 地址（带端口）。
// 443 被别的服务占用时，面板常挂在 8443 等端口；只用 remote_hosts 拼出的地址会指向别的服务，
// 登录链接和中心机密钥就会发错地方。找不到时退回 https://remote_hosts[0]。
func remoteBase(cfg config.Config) remoteURL {
	fallback := remoteURL{}
	if len(cfg.RemoteHosts) > 0 {
		fallback.URL = "https://" + cfg.RemoteHosts[0]
	}
	bin := tailscaleBinary()
	if bin == "" {
		return fallback
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "serve", "status", "--json").Output()
	if err != nil {
		return fallback
	}
	if r, ok := serveURL(out, cfg.Listen, cfg.RemoteHosts); ok {
		return r
	}
	return fallback
}

func tailscaleBinary() string {
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p
	}
	const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
	if _, err := exec.LookPath(app); err == nil {
		return app
	}
	return ""
}

// serveURL 从 `tailscale serve status --json` 里找主机名在 remote_hosts 内、
// "/" 转发到本机 listen 端口的条目。有多个时优先不开 Funnel 的。
func serveURL(status []byte, listen string, hosts []string) (remoteURL, bool) {
	var st struct {
		Web map[string]struct {
			Handlers map[string]struct {
				Proxy string `json:"Proxy"`
			} `json:"Handlers"`
		} `json:"Web"`
		AllowFunnel map[string]bool `json:"AllowFunnel"`
	}
	if json.Unmarshal(status, &st) != nil {
		return remoteURL{}, false
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil {
		return remoteURL{}, false
	}
	var best remoteURL
	found := false
	for hp, web := range st.Web {
		host, p, err := net.SplitHostPort(hp)
		if err != nil || !hostListed(host, hosts) || !proxiesTo(web.Handlers["/"].Proxy, port) {
			continue
		}
		r := remoteURL{URL: "https://" + host, Funnel: st.AllowFunnel[hp], Found: true}
		if p != "443" {
			r.URL += ":" + p
		}
		if !found || (best.Funnel && !r.Funnel) || (best.Funnel == r.Funnel && r.URL < best.URL) {
			best, found = r, true
		}
	}
	return best, found
}

func hostListed(host string, hosts []string) bool {
	for _, h := range hosts {
		if strings.EqualFold(h, host) {
			return true
		}
	}
	return false
}

// proxiesTo：转发目标是本机回环地址上的这个端口（tailscale 可能记成 http://127.0.0.1:7788 或 localhost:7788）。
func proxiesTo(proxy, port string) bool {
	if proxy == "" {
		return false
	}
	if !strings.Contains(proxy, "://") {
		proxy = "http://" + proxy
	}
	u, err := url.Parse(proxy)
	if err != nil || u.Port() != port {
		return false
	}
	switch u.Hostname() {
	case "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}
