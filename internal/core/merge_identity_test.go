package core

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
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

func TestMoveWorkItemClearsOldProjectMergeProof(t *testing.T) {
	c, original, _ := gateRepo(t, nil)
	ctx := context.Background()
	git(t, original, "merge", "-q", "--no-edit", "feat/GT-1-x")
	if err := c.ScanMerges(ctx); err != nil {
		t.Fatal(err)
	}
	item := func() WorkItem {
		t.Helper()
		snap, err := c.Snapshot(ctx)
		if err != nil || len(snap.WorkItems) != 1 {
			t.Fatalf("load work item: %v", err)
		}
		return snap.WorkItems[0]
	}
	before := item()
	if before.RepoID == nil || before.MergeState != "merged" || before.MergeEvidence == nil {
		t.Fatalf("original project must have a verified merge: %+v", before)
	}
	proof, err := json.Marshal(before.MergeEvidence)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.St.SetMeta(ctx, "merge_pr:"+before.ID, string(proof)); err != nil {
		t.Fatal(err)
	}
	title := "修改标题，项目不变"
	if err := c.UpdatePanelWorkItem(ctx, before.ID, WorkItemPatch{Title: &title, RepoID: before.RepoID}); err != nil {
		t.Fatal(err)
	}
	if w := item(); w.MergeState != "merged" || w.MergeEvidence == nil || *w.MergeEvidence != *before.MergeEvidence {
		t.Fatalf("same project must keep the proof: %+v", w)
	}

	destination := gitInit(t)
	git(t, destination, "checkout", "-qb", before.Branch)
	commit(t, destination, "unrelated-destination-candidate")
	git(t, destination, "checkout", "-q", "main")
	git(t, destination, "merge", "-q", "--no-edit", before.Branch)
	src := before.MergeEvidence.SourceSHA
	if other := gitx.RevParse(ctx, destination, before.Branch); other == "" || !gitx.IsAncestor(ctx, destination, other, "main") || gitx.RevParse(ctx, destination, src) != "" {
		t.Fatal("destination must contain its merged same-name branch but not the original candidate")
	}
	e := ev("destination", event.KindSessionStart, c.St.Now())
	e.Cwd = destination
	mustIngest(t, c, e)
	var destID int64
	if err := c.St.R().QueryRow(`SELECT id FROM repos WHERE common_dir=?`, filepath.Join(destination, ".git")).Scan(&destID); err != nil {
		t.Fatal(err)
	}
	if err := c.UpdatePanelWorkItem(ctx, before.ID, WorkItemPatch{RepoID: &destID}); err != nil {
		t.Fatal(err)
	}
	var oldProofs int
	if err := c.St.R().QueryRow(`SELECT COUNT(*) FROM meta WHERE k IN (?,?)`, "merge_verified:"+before.ID, "merge_pr:"+before.ID).Scan(&oldProofs); err != nil {
		t.Fatal(err)
	}
	if oldProofs != 0 {
		t.Errorf("old project proof rows after moving: want 0, got %d", oldProofs)
	}
	candidates, err := c.mergeItems(ctx, destID)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.ScanMerges(ctx); err != nil {
		t.Fatal(err)
	}
	w := item()
	if w.RepoID == nil || *w.RepoID != destID || w.MergeState != "not_ready" || w.MergeEvidence != nil || len(candidates) != 1 || candidates[0].id != before.ID {
		t.Fatalf("destination with same-name branch: want not_ready, no proof and 1 scan candidate; got %s, proof=%t and %d candidates", w.MergeState, w.MergeEvidence != nil, len(candidates))
	}

	git(t, destination, "fetch", "-q", original, src)
	git(t, destination, "merge", "-q", "--no-edit", "--allow-unrelated-histories", "FETCH_HEAD")
	if err := c.ScanMerges(ctx); err != nil {
		t.Fatal(err)
	}
	if w := item(); w.MergeState != "merged" || w.MergeEvidence == nil || w.MergeEvidence.SourceSHA != src {
		t.Fatalf("destination must verify the original candidate after it is merged: %s, %+v", w.MergeState, w.MergeEvidence)
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
