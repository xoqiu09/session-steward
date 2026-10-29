package notify

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNativeAppSharedServiceFindsBundledHelper(t *testing.T) {
	dir := t.TempDir()
	apps := filepath.Join(dir, "Applications")
	helper := filepath.Join(apps, "Session Steward.app", "Contents", "MacOS", "Session Steward.app")
	writeHelper(t, helper)
	if got := NativeApp(filepath.Join(dir, "data", "bin", "steward"), []string{apps}); got != helper {
		t.Fatalf("shared launchd service lost its clickable notifications: %q", got)
	}
}

func TestNativeAppPrefersSiblingAndRejectsIncompleteApp(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "native", "steward")
	sibling := filepath.Join(filepath.Dir(executable), "Session Steward.app")
	if err := os.MkdirAll(sibling, 0700); err != nil {
		t.Fatal(err)
	}
	if got := NativeApp(executable, nil); got != "" {
		t.Fatalf("incomplete helper: %q", got)
	}
	writeHelper(t, sibling)
	if got := NativeApp(executable, []string{filepath.Join(dir, "Applications")}); got != sibling {
		t.Fatalf("App-owned backend should use its own helper: %q", got)
	}
}

func writeHelper(t *testing.T, app string) {
	t.Helper()
	bin := filepath.Join(app, "Contents", "MacOS", "StewardNotifications")
	if err := os.MkdirAll(filepath.Dir(bin), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("synthetic executable fixture"), 0700); err != nil {
		t.Fatal(err)
	}
}
