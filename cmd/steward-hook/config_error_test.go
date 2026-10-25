package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

// 配置校验失败（listen 非回环）时，hook 不能带着 ingest token 向该地址发请求，也不写暂存，并以 0 退出。
func TestHookExitsQuietlyOnConfigError(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	home := t.TempDir()
	t.Setenv("STEWARD_HOME", home)
	// 0.0.0.0:<port> 在本机仍能连到测试服务，可以证明请求确实没有发出
	os.WriteFile(filepath.Join(home, "config.json"), []byte(`{"listen":"0.0.0.0:`+u.Port()+`"}`), 0o600)
	os.WriteFile(filepath.Join(home, "ingest.token"), []byte("synthetic-token\n"), 0o600)
	for _, args := range [][]string{{"claude", "Stop"}, {"codex", "PermissionRequest"}, {"claim", "SYN-1", "--session", "s", "--provider", "codex"}, {"flush"}} {
		var out bytes.Buffer
		stdin := strings.NewReader(`{"session_id":"s","hook_event_name":"Stop"}`)
		if code := run(args, stdin, &out); code != 0 {
			t.Fatalf("%v: exit=%d", args, code)
		}
		if out.Len() != 0 {
			t.Fatalf("%v: 不应向 Agent 输出: %q", args, out.String())
		}
		if stdin.Len() != 0 && args[0] != "claim" && args[0] != "flush" {
			t.Fatalf("%v: hooks 模式应读完 stdin", args)
		}
	}
	if n := calls.Load(); n != 0 {
		t.Fatalf("配置错误时仍发出 %d 个请求", n)
	}
	if _, err := os.Stat(filepath.Join(home, "spool")); !os.IsNotExist(err) {
		t.Fatal("配置错误时不应写暂存")
	}
}
