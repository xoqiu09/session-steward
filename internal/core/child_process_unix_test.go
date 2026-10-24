//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package core

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestServiceCancellationKillsCheckDescendants(t *testing.T) {
	marker, started := filepath.Join(t.TempDir(), "orphan"), filepath.Join(t.TempDir(), "started")
	c, _, a := gateRepo(t, [][]string{{"sh", "-c", `(sleep 0.6; printf orphan > "$1") & printf ready > "$2"; wait`, "check", marker, started}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.JobContext = ctx
	j, err := c.StartMergeGate(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("check did not start")
		}
		time.Sleep(time.Millisecond)
	}
	cancel()
	c.CloseJobs()
	time.Sleep(700 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("orphaned check child continued after cancellation")
	}
	j, _ = c.MergeJob(context.Background(), j.ID)
	if j.State != "aborted" {
		t.Fatal(j.State)
	}
}
