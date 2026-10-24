package tmux

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// 使用本机真实 tmux（独立 socket），未安装时跳过。
func TestRealTmuxLifecycle(t *testing.T) {
	bin := Find("")
	if bin == "" {
		t.Skip("tmux 未安装")
	}
	tm := &Tmux{Bin: bin, Socket: fmt.Sprintf("steward-test-%d", os.Getpid())}
	ctx := context.Background()
	t.Cleanup(func() { tm.run(context.Background(), "kill-server") })
	dir := t.TempDir()
	if err := tm.Start(ctx, "steward-a", dir, []string{"SYNTH=合成"}, []string{"/bin/sh", "-c", "echo ready $SYNTH; read x; echo got $x; exit 4"}); err != nil {
		t.Fatal(err)
	}
	wait := func(want string) string {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			s, _ := tm.Capture(ctx, "steward-a", 100)
			if strings.Contains(s, want) {
				return s
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("画面未出现 %q", want)
		return ""
	}
	wait("ready 合成")
	// 精确匹配：前缀不能命中
	if _, err := tm.Capture(ctx, "steward-", 10); err != ErrNoSession {
		t.Fatalf("前缀不应匹配: %v", err)
	}
	if err := tm.SendText(ctx, "steward-a", "hi; echo injected"); err != nil {
		t.Fatal(err)
	}
	tm.SendKey(ctx, "steward-a", "Enter")
	wait("got hi; echo injected")
	deadline := time.Now().Add(3 * time.Second)
	for {
		m, err := tm.List(ctx, "steward-")
		if err != nil {
			t.Fatal(err)
		}
		if p := m["steward-a"]; p.Dead {
			// Ubuntu 24.04 的 tmux 3.4 在 respawn-pane 后不提供 pane_dead_status
			if p.HasExitCode && p.ExitCode != 4 {
				t.Fatalf("exit=%d", p.ExitCode)
			}
			if !p.HasExitCode {
				t.Log("当前 tmux 未提供退出码，只验证已退出")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("未观察到退出")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := tm.Kill(ctx, "steward-a"); err != nil {
		t.Fatal(err)
	}
	if err := tm.Kill(ctx, "steward-a"); err != nil {
		t.Fatal("重复结束应幂等")
	}
	if m, _ := tm.List(ctx, "steward-"); len(m) != 0 {
		t.Fatal(m)
	}
}
