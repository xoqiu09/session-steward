package core

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/install"
)

func TestHookMonitorUsesLatestRecordedClaudeVersion(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	now := time.Now()
	for i, version := range []string{"2.1.33", "2.1.83"} {
		e := ev(version, event.KindSessionStart, now.Add(time.Duration(i)*time.Second))
		e.Source.Version = version
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	target := install.ClaudeTarget(t.TempDir())
	monitor := &install.Monitor{Targets: []install.Target{target}, ClaudeVersion: c.LatestClaudeVersion, Probe: func(context.Context, string) (string, error) {
		t.Fatal("有已记录版本时不应执行 PATH CLI")
		return "", nil
	}}
	row := monitor.Snapshot(ctx)[0]
	if row.Version != "2.1.83" || len(row.Missing) != 16 || len(row.Skipped) != 1 || row.Skipped[0] != "PermissionDenied" {
		t.Fatalf("coverage=%+v", row)
	}
	installer := &install.Installer{StateDir: filepath.Join(t.TempDir(), "install"), HookBinary: "/synthetic/steward-hook", PermWait: 60}
	if _, err := installer.Install(install.ForVersion(target, row.Version).Target); err != nil {
		t.Fatal(err)
	}
	if got := monitor.Snapshot(ctx)[0]; len(got.Installed) != 16 || len(got.Missing) != 0 {
		t.Fatalf("记录版本不能安装对应新事件：%+v", got)
	}
}
