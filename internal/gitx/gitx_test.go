package gitx

import (
	"context"
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
