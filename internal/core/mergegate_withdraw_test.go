package core

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 在 Git 真正更新目标之前暂停；撤回不得先返回成功、随后却仍发生合并。
func TestWithdrawalCannotAcknowledgeBeforeDelayedGitMerge(t *testing.T) {
	c, dir, a := gateRepo(t, [][]string{{"true"}})
	before := git(t, dir, "rev-parse", "main")
	bin := t.TempDir()
	ready, release := filepath.Join(bin, "ready"), filepath.Join(bin, "release")
	real, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	quoted := "'" + strings.ReplaceAll(real, "'", "'\"'\"'") + "'"
	script := `#!/bin/sh
for arg do
 if [ "$arg" = "--ff-only" ]; then
  printf ready > "$STEWARD_TEST_MERGE_READY"
  while [ ! -e "$STEWARD_TEST_MERGE_RELEASE" ]; do sleep 0.01; done
 fi
done
exec ` + quoted + ` "$@"
`
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("STEWARD_TEST_MERGE_READY", ready)
	t.Setenv("STEWARD_TEST_MERGE_RELEASE", release)
	defer os.WriteFile(release, nil, 0600)
	j, err := c.StartMergeGate(context.Background(), a)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(4 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("did not reach delayed Git update")
		}
		time.Sleep(time.Millisecond)
	}
	rejected := make(chan error, 1)
	go func() { rejected <- c.RejectMerge(context.Background(), a, "withdraw concurrently") }()
	time.Sleep(50 * time.Millisecond)
	os.WriteFile(release, nil, 0600)
	c.WaitJobs()
	select {
	case err := <-rejected:
		if !errors.Is(err, ErrConflict) {
			t.Fatalf("merge already committed; withdrawal must report conflict, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("withdrawal did not finish")
	}
	j, _ = c.MergeJob(context.Background(), j.ID)
	if j.State != "merged" || git(t, dir, "rev-parse", "main") == before {
		t.Fatalf("delayed merge did not complete: %+v", j)
	}
}
