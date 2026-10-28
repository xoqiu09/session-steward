package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

func hubCore(t *testing.T, name string) *core.Core {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), name+".sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return core.New(st, nil)
}

const hubSecret = "synthetic-hub-secret-0123456789"

// 中心机收摘要、合并；其他设备推送并经本机取回合并视图。密钥不对一律拒绝，其余接口的远程只读不受影响。
func TestHubPushPullAndMerge(t *testing.T) {
	hubC := hubCore(t, "hub")
	hubSrv := &Server{Core: hubC, IngestToken: "ing", PanelToken: "pan", RemoteToken: "rem", RemoteHosts: []string{rh}, PermWait: time.Second,
		Hub: &Hub{Role: "hub", Secret: hubSecret, SelfID: "dev-hub", SelfName: "台式机"}}
	ts := httptest.NewServer(hubSrv.Handler())
	defer ts.Close()

	agentC := hubCore(t, "agent")
	ctx := context.Background()
	agentC.CreateWorkItem(ctx, core.WorkItemInput{ID: "NB-1", Title: "笔记本上的活"})
	e := event.Event{EventID: "ev-1", Source: event.Source{Provider: "claude"}, Kind: event.KindPrompt, SessionID: "nb-s1", OccurredAt: time.Now(), Cwd: "/secret/path", Preview: "不该带走的命令"}
	if _, err := agentC.Ingest(ctx, &e); err != nil {
		t.Fatal(err)
	}
	agent := &Hub{Role: "agent", URL: ts.URL, Secret: hubSecret, SelfID: "dev-nb", SelfName: "笔记本"}
	if err := agent.Push(ctx, agentC); err != nil {
		t.Fatal(err)
	}
	wrong := &Hub{Role: "agent", URL: ts.URL, Secret: "wrong-secret-0123456789", SelfID: "dev-x", SelfName: "x"}
	if err := wrong.Push(ctx, agentC); err == nil {
		t.Fatal("密钥不对应被拒绝")
	}

	// 中心机经 Tailscale 主机名被访问：pull 只认密钥
	req := httptest.NewRequest("GET", "http://"+rh+"/api/hub/pull", nil)
	req.Host = rh
	w := httptest.NewRecorder()
	hubSrv.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("没带密钥应拒绝：%d", w.Code)
	}
	req.Header.Set("Authorization", "Bearer "+hubSecret)
	w = httptest.NewRecorder()
	hubSrv.Handler().ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("pull %d %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if strings.Contains(body, "/secret/path") || strings.Contains(body, "不该带走的命令") {
		t.Fatal("摘要里不应有目录和命令")
	}
	var snap core.Snapshot
	json.Unmarshal(w.Body.Bytes(), &snap)
	if len(snap.Devices) != 2 || !snap.Devices[0].Self || snap.Devices[1].Name != "笔记本" || !snap.Devices[1].Online {
		t.Fatalf("设备列表 %+v", snap.Devices)
	}
	found := false
	for _, it := range snap.WorkItems {
		if it.ID == "笔记本:NB-1" {
			found = true
		}
	}
	if !found {
		t.Fatalf("其他设备的工作项应带设备前缀：%+v", snap.WorkItems)
	}

	// 其他设备的面板经本机取回合并视图
	agentSrv := &Server{Core: agentC, IngestToken: "ing", PanelToken: "pan", PermWait: time.Second, Hub: agent}
	r := httptest.NewRequest("GET", "http://127.0.0.1:7788/api/hub/snapshot", nil)
	r.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	w = httptest.NewRecorder()
	agentSrv.Handler().ServeHTTP(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "笔记本:NB-1") {
		t.Fatalf("agent 取回 %d %s", w.Code, w.Body.String()[:min(200, len(w.Body.String()))])
	}
}

// hub.url 指到别的服务（例如 443 上的其他程序）时，即使返回 200 也不算推送成功。
func TestHubPushRejectsOtherService(t *testing.T) {
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("<html>hello</html>")) }))
	defer other.Close()
	agent := &Hub{Role: "agent", URL: other.URL, Secret: hubSecret, SelfID: "dev-nb", SelfName: "笔记本"}
	if err := agent.Push(context.Background(), hubCore(t, "agent")); err == nil || !strings.Contains(err.Error(), "hub.url") {
		t.Fatalf("应提示检查 hub.url：%v", err)
	}
}
