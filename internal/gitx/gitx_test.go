package gitx

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestUnbornRepositoryKeepsGitIdentity(t *testing.T) {
	dir := t.TempDir()
	if out, err := exec.Command("git", "init", "-b", "main", dir).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	loc := Locate(context.Background(), dir)
	if !loc.IsGit || loc.CommonDir != canon(filepath.Join(dir, ".git")) || loc.Branch != "main" {
		t.Fatalf("%+v", loc)
	}
}

func TestRunRetainsFailureWithoutStderr(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte("#!/bin/sh\nexit 7\n"), 0755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	_, err := Run(context.Background(), dir, "rev-parse", "HEAD")
	if err == nil || err.Error() == "" {
		t.Fatal("underlying Git execution failure was discarded")
	}
}
