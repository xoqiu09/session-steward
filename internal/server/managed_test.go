package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/store"
	"github.com/xoqiu09/session-steward/internal/tmux"
)

// 使用真实 tmux（独立 socket）与合成 Git 仓库，覆盖 面板 → tmux → SSE 画面。
func startManaged(t *testing.T) (*httptest.Server, *core.Core, int64) {
	t.Helper()
	bin := tmux.Find("")
	if bin == "" {
		t.Skip("tmux 未安装")
	}
	repo := filepath.Join(t.TempDir(), "synthetic")
	for _, a := range [][]string{{"init", "-q", "-b", "main", repo}, {"-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"}} {
		if out, err := exec.Command("git", a...).CombinedOutput(); err != nil {
			t.Fatal(string(out))
		}
	}
	st, err := store.Open(filepath.Join(t.TempDir(), "s.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := core.New(st, gitx.NewLocator())
	tm := &tmux.Tmux{Bin: bin, Socket: fmt.Sprintf("steward-srv-test-%d", os.Getpid())}
	t.Cleanup(func() { exec.Command(bin, "-L", tm.Socket, "kill-server").Run() })
	c.Term = tm
	c.WorktreeRoot = filepath.Join(t.TempDir(), "wt")
	// 合成 Agent：打印就绪后回显输入，代替真实 claude/codex
	agent := []string{"/bin/sh", "-c", "echo synthetic-agent-ready; while read l; do echo echo:$l; done"}
	c.Agents = map[string]core.AgentSpec{"claude": {Argv: agent, Hooks: true}, "codex": {Argv: agent, Hooks: true}}
	e := &event.Event{EventID: "seed", SchemaVersion: 1, OccurredAt: time.Now(), Source: event.Source{Provider: "claude", HostID: "h"}, Kind: event.KindSessionStart, SessionID: "seed", Cwd: repo}
	if _, err := c.Ingest(context.Background(), e); err != nil {
		t.Fatal(err)
	}
	var id int64
	st.R().QueryRow(`SELECT id FROM repos`).Scan(&id)
	s := &Server{Core: c, IngestToken: "ing", PanelToken: "pan", PermWait: 5 * time.Second}
	ts := httptest.NewUnstartedServer(s.Handler())
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	ts.Listener = l
	ts.Start()
	t.Cleanup(ts.Close)
	return ts, c, id
}

func TestManagedEndpointsRequirePanelAuth(t *testing.T) {
	ts, _, repo := startManaged(t)
	body := fmt.Sprintf(`{"repo_id":%d,"agent":"claude","title":"x"}`, repo)
	cases := []struct {
		name   string
		mutate func(*http.Request)
		want   int
	}{
		{"无凭据", func(r *http.Request) {}, 401},
		{"采集 token", func(r *http.Request) { r.Header.Set("Authorization", "Bearer ing") }, 401},
		{"缺 X-Steward", func(r *http.Request) { r.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"}) }, 403},
		{"外部 Origin", func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
			r.Header.Set("X-Steward", "1")
			r.Header.Set("Origin", "https://evil.example")
		}, 403},
	}
	for _, tc := range cases {
		for _, path := range []string{"/api/managed", "/api/managed/x/input", "/api/managed/x/takeover", "/api/managed/x/stop", "/api/managed/x/archive"} {
			req, _ := http.NewRequest("POST", ts.URL+path, strings.NewReader(body))
			tc.mutate(req)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Fatalf("%s %s: %d", tc.name, path, resp.StatusCode)
			}
		}
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/managed/x/terminal", nil)
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Fatalf("终端流需要面板凭据: %d", resp.StatusCode)
	}
	// 非回环 Host 拒绝
	req, _ = http.NewRequest("GET", ts.URL+"/api/managed/x/terminal", nil)
	req.Host = "evil.example"
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	resp, _ = http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("Host 校验: %d", resp.StatusCode)
	}
}

func readScreen(t *testing.T, sc *bufio.Scanner, want string, within time.Duration) map[string]any {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) && sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var m map[string]any
		json.Unmarshal([]byte(line[6:]), &m)
		if strings.Contains(fmt.Sprint(m["text"]), want) {
			return m
		}
	}
	t.Fatalf("%v 内未看到 %q", within, want)
	return nil
}

func TestManagedTerminalStreamAndTakeover(t *testing.T) {
	TerminalInterval = 200 * time.Millisecond
	ts, c, repo := startManaged(t)
	code, b := panelReq(t, ts, "POST", "/api/managed", map[string]any{"repo_id": repo, "agent": "codex", "title": "合成任务"})
	if code != 200 {
		t.Fatalf("%d %s", code, b)
	}
	var m core.ManagedSession
	json.Unmarshal(b, &m)
	if m.State != "running" || !strings.HasPrefix(m.Branch, "steward/") {
		t.Fatalf("%+v", m)
	}
	req, _ := http.NewRequest("GET", ts.URL+"/api/managed/"+m.ID+"/terminal", nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	resp, err := http.DefaultClient.Do(req.WithContext(ctx))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	sc := bufio.NewScanner(resp.Body)
	readScreen(t, sc, "synthetic-agent-ready", 3*time.Second)
	// 默认只读
	if code, _ := panelReq(t, ts, "POST", "/api/managed/"+m.ID+"/input", map[string]string{"text": "hi"}); code != 409 {
		t.Fatalf("只读时输入应被拒绝: %d", code)
	}
	panelReq(t, ts, "POST", "/api/managed/"+m.ID+"/takeover", map[string]bool{"on": true})
	// A permission change must emit a frame even when the terminal text has not changed.
	resp.Body.Close()
	req2, _ := http.NewRequest("GET", ts.URL+"/api/managed/"+m.ID+"/terminal", nil)
	req2.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	frameCtx, frameCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer frameCancel()
	resp2, err := http.DefaultClient.Do(req2.WithContext(frameCtx))
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	sc = bufio.NewScanner(resp2.Body)
	readScreen(t, sc, "synthetic-agent-ready", time.Second)
	panelReq(t, ts, "POST", "/api/managed/"+m.ID+"/takeover", map[string]bool{"on": false})
	frame := readScreen(t, sc, "synthetic-agent-ready", 2*time.Second)
	if frame["takeover"] != false {
		t.Fatalf("unchanged terminal must publish takeover off: %v", frame)
	}
	panelReq(t, ts, "POST", "/api/managed/"+m.ID+"/takeover", map[string]bool{"on": true})
	panelReq(t, ts, "POST", "/api/managed/"+m.ID+"/input", map[string]string{"text": "ping-1"})
	start := time.Now()
	panelReq(t, ts, "POST", "/api/managed/"+m.ID+"/input", map[string]string{"key": "Enter"})
	readScreen(t, sc, "echo:ping-1", 2*time.Second)
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("画面延迟 %v", d)
	}
	// 停止后工作项状态不变
	if code, b := panelReq(t, ts, "POST", "/api/managed/"+m.ID+"/stop", nil); code != 200 {
		t.Fatalf("%d %s", code, b)
	}
	var status string
	c.St.R().QueryRow(`SELECT status FROM work_items WHERE id=?`, m.WorkItemID).Scan(&status)
	if status == "done" || status == "review" {
		t.Fatal(status)
	}
	code, b = panelReq(t, ts, "POST", "/api/managed/"+m.ID+"/archive", nil)
	if code != 200 {
		t.Fatalf("%d %s", code, b)
	}
	code, b = panelReq(t, ts, "GET", "/api/managed/"+m.ID+"/audit", nil)
	if code != 200 || !strings.Contains(string(b), "takeover_on") || strings.Contains(string(b), "ping-1") {
		t.Fatalf("审计: %s", b)
	}
}
