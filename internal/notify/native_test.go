package notify

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xoqiu09/session-steward/internal/core"
)

func TestNativeNoticeEnqueuesWithoutDialogOrAction(t *testing.T) {
	dir := t.TempDir()
	var name string
	m := &MacOS{AppPath: "/synthetic/Session Steward.app", SpoolDir: dir}
	m.Run = func(_ context.Context, cmd string, args ...string) ([]byte, error) {
		if cmd != "/usr/bin/open" || len(args) != 7 || args[0] != "-g" || args[1] != "-a" || args[2] != m.AppPath || args[4] != "--args" || args[5] != "--steward-home" || args[6] != filepath.Dir(dir) {
			t.Fatalf("unexpected command: %s %q", cmd, args)
		}
		name = args[3]
		info, err := os.Stat(name)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm() != 0600 || filepath.Dir(name) != dir {
			t.Fatal("request is not private", name, info.Mode())
		}
		b, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		var n nativeNotice
		if err = json.Unmarshal(b, &n); err != nil {
			t.Fatal(err)
		}
		if len(n.ID) != 64 || n.Link != "http://127.0.0.1:7788/#item=SYN-1" || n.Title != "合成通知" {
			t.Fatalf("wrong notification: %+v", n)
		}
		return nil, os.WriteFile(name+".result", []byte(`{"status":"queued"}`), 0600)
	}
	if err := m.Send(context.Background(), core.Alert{Key: "synthetic-notice", Title: "合成通知", Body: "只打开工作项", Link: "http://127.0.0.1:7788/#item=SYN-1"}); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{name, name + ".result"} {
		if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("request not cleaned up", file, err)
		}
	}
}

func TestNativeNoticeRejectsUnsafeLinks(t *testing.T) {
	for _, link := range []string{"file:///tmp/test", "https://evil.invalid/#item=SYN-1", "http://127.0.0.1.evil.invalid/#item=SYN-1", "http://user:secret@localhost/#item=SYN-1", "http://localhost/?token=secret#item=SYN-1", "http://localhost/api/work-items/SYN-1#item=SYN-1", "http://localhost/#item=", "http://localhost/#item=SYN-1&session=1"} {
		if validNoticeLink(link) {
			t.Fatal("unsafe notification link", link)
		}
	}
	for _, link := range []string{"http://127.0.0.1:7788/#item=SYN-1", "http://localhost:7788/#approval=synthetic", "http://[::1]:7788/#session=1"} {
		if !validNoticeLink(link) {
			t.Fatal("valid link rejected", link)
		}
	}
}

func TestNativeNoticeDeniedDoesNotOpenBrowserOrUseDialog(t *testing.T) {
	m := &MacOS{AppPath: "/synthetic/Session Steward.app", SpoolDir: t.TempDir()}
	calls := 0
	m.Run = func(_ context.Context, cmd string, args ...string) ([]byte, error) {
		calls++
		if cmd != "/usr/bin/open" || args[0] != "-g" {
			t.Fatal(cmd, args)
		}
		return nil, os.WriteFile(args[3]+".result", []byte(`{"status":"permission_denied"}`), 0600)
	}
	err := m.Send(context.Background(), core.Alert{Key: "denied", Link: "http://localhost:7788/#item=SYN-1"})
	if err == nil || !strings.Contains(err.Error(), "permission_denied") || calls != 1 {
		t.Fatal(err, calls)
	}
}

// Opt-in desktop check. No database/event writes and no approval/acceptance action.
func TestNativeNotificationLive(t *testing.T) {
	app := os.Getenv("STEWARD_NOTIFICATION_TEST_APP")
	if app == "" {
		t.Skip("set STEWARD_NOTIFICATION_TEST_APP to run the explicitly requested desktop probe")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	m := &MacOS{AppPath: app, SpoolDir: filepath.Join(home, ".steward", "notifications")}
	err = m.Send(context.Background(), core.Alert{Key: "read-only-desktop-check", Title: "通知跳转测试（只读）", Body: "点击只打开 STW-001 记录，不会更改审批或验收状态。", Link: "http://127.0.0.1:7788/#item=STW-001"})
	if err != nil {
		t.Fatal(err)
	}
}
