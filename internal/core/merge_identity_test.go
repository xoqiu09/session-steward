package core

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGitHubSSHOverHTTPSIdentity(t *testing.T) {
	for _, raw := range []string{
		"git@ssh.github.com:synthetic/project.git",
		"ssh://git@ssh.github.com:443/synthetic/project.git",
	} {
		if got := githubRepository(raw); got != "synthetic/project" {
			t.Errorf("%s: got %q", raw, got)
		}
	}
	for _, raw := range []string{"https://ssh.github.com/synthetic/project.git", "ssh://git@ssh.github.com.evil.invalid:443/synthetic/project.git"} {
		if got := githubRepository(raw); got != "" {
			t.Errorf("unverified host accepted: %s => %s", raw, got)
		}
	}
}

func TestExternalSquashMergeThroughGitHub443Alias(t *testing.T) {
	c, dir, _ := gateRepo(t, nil)
	ctx := context.Background()
	const alias = "git@synthetic-personal:synthetic/project.git"
	source := strings.TrimSpace(git(t, dir, "rev-parse", "feat/GT-1-x"))
	before := strings.TrimSpace(git(t, dir, "rev-parse", "main"))
	remote := filepath.Join(t.TempDir(), "origin.git")
	git(t, dir, "clone", "-q", "--bare", dir, remote)
	git(t, dir, "remote", "add", "origin", alias)
	// This repository-local rewrite makes the entire test offline.
	git(t, dir, "config", "url."+remote+".insteadOf", alias)
	other := filepath.Join(t.TempDir(), "other")
	git(t, dir, "clone", "-q", remote, other)
	git(t, other, "merge", "--squash", "origin/feat/GT-1-x")
	git(t, other, "commit", "-qm", "synthetic squash")
	git(t, other, "push", "-q", "origin", "main")
	merged := strings.TrimSpace(git(t, other, "rev-parse", "HEAD"))
	raw, _ := json.Marshal([]any{map[string]any{"headRefOid": source, "headRefName": "feat/GT-1-x", "baseRefName": "main", "mergeCommit": map[string]string{"oid": merged}, "url": "https://github.com/synthetic/project/pull/1"}})
	bin := t.TempDir()
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	// Preserve the synthetic SSH identity while the real Git transport uses the local fixture.
	gitRelay := "#!/bin/sh\nif [ \"$3\" = remote ] && [ \"$4\" = get-url ]; then printf '%s\\n' '" + alias + "'; exit 0; fi\nexec '" + strings.ReplaceAll(realGit, "'", "'\\''") + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(bin, "git"), []byte(gitRelay), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte("#!/bin/sh\nprintf 'hostname ssh.github.com\\nport 443\\n'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "gh"), []byte("#!/bin/sh\n[ \"$1\" = pr ] || exit 1\nprintf '%s\\n' '"+string(raw)+"'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := c.SyncMerges(ctx, true); err != nil {
		t.Fatal(err)
	}
	s, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	w := s.WorkItems[0]
	if w.MergeState != "merged" || w.MergeEvidence == nil || w.MergeEvidence.Method != "github_pr" || w.Status != "review" {
		t.Fatalf("external squash was not reconciled independently of acceptance: %+v", w)
	}
	if local := strings.TrimSpace(git(t, dir, "rev-parse", "main")); local != before {
		t.Fatal("observing external merge changed local main")
	}
}

func TestGitHubAliasResolvedToPort443Host(t *testing.T) {
	bin := t.TempDir()
	// The synthetic SSH config lookup never reads the user's config or contacts a server.
	script := "#!/bin/sh\ncase \"$2\" in\n synthetic-personal) printf 'hostname ssh.github.com\\nport 443\\n' ;;\n synthetic-normal) printf 'hostname github.com\\n' ;;\n *) printf 'hostname git.example.invalid\\n' ;;\nesac\n"
	if err := os.WriteFile(filepath.Join(bin, "ssh"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	for _, tc := range []struct{ raw, want string }{
		{"git@synthetic-personal:synthetic/project.git", "synthetic/project"},
		{"git@synthetic-normal:synthetic/project.git", "synthetic/project"},
		{"git@synthetic-unrelated:synthetic/project.git", ""},
	} {
		if got := resolvedGithubRepository(context.Background(), tc.raw); got != tc.want {
			t.Errorf("%s: got %q want %q", tc.raw, got, tc.want)
		}
	}
}
