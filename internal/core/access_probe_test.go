package core

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestProtectedRoot(t *testing.T) {
	home := "/Users/synthetic"
	for path, want := range map[string]string{
		"/Volumes/Data/Projects/app/.git":       "/Volumes/Data",
		"dir:/Volumes/Data/notes":               "/Volumes/Data",
		"/Users/synthetic/Documents/app/.git":   "/Users/synthetic/Documents",
		"/Users/synthetic/Desktop":              "/Users/synthetic/Desktop",
		"/Users/synthetic/WorkSpace/app/.git":   "",
		"/opt/synthetic/app/.git":               "",
		"/Users/synthetic/DocumentsArchive/app": "",
	} {
		if got := protectedRoot(path, home); got != want {
			t.Fatalf("%s: got %q want %q", path, got, want)
		}
	}
}

func TestAccessProbeReportsStuckLocationUntilItOpens(t *testing.T) {
	c := newCore(t, cwdLocator{})
	ctx := context.Background()
	e := ev("synthetic", event.KindSessionStart, time.Now().UTC())
	e.Cwd = "/Volumes/Synthetic/app"
	if _, err := c.Ingest(ctx, e); err != nil {
		t.Fatal(err)
	}
	old := AccessProbeTimeout
	AccessProbeTimeout = 20 * time.Millisecond
	t.Cleanup(func() { AccessProbeTimeout = old })
	release := make(chan struct{})
	var calls atomic.Int32
	c.access.open = func(path string) error {
		calls.Add(1)
		if path != "/Volumes/Synthetic" {
			t.Errorf("unexpected probe path %s", path)
		}
		<-release
		return nil
	}
	if err := c.ProbeAccess(ctx); err != nil {
		t.Fatal(err)
	}
	if issues := c.AccessIssues(); len(issues) != 1 || issues[0].Path != "/Volumes/Synthetic" {
		t.Fatalf("stuck volume not reported: %+v", issues)
	}
	snap, _ := c.Snapshot(ctx)
	if len(snap.AccessIssues) != 1 {
		t.Fatal("snapshot does not carry the access issue")
	}
	// A second probe while the first is still waiting must not pile up more blocked reads.
	if err := c.ProbeAccess(ctx); err != nil || calls.Load() != 1 {
		t.Fatal("probe repeated while still waiting", calls.Load(), err)
	}
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for len(c.AccessIssues()) > 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if len(c.AccessIssues()) != 0 {
		t.Fatal("issue not cleared after the location became readable")
	}
}
