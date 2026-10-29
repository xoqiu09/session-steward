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

func TestMergeFetchUsesExistingAccountPerRepoWithoutGlobalSwitch(t *testing.T) {
	for _, saved := range []string{"", "collaborator", "unavailable"} {
		t.Run("saved-"+saved, func(t *testing.T) {
			c, dir, _ := gateRepo(t, nil)
			ctx := context.Background()
			realGit, err := exec.LookPath("git")
			if err != nil {
				t.Fatal(err)
			}
			git(t, dir, "remote", "add", "origin", "https://github.com/synthetic/private.git")
			repos, err := c.repos(ctx)
			if err != nil {
				t.Fatal(err)
			}
			r := repos[0]
			if saved != "" {
				b, _ := json.Marshal(repoGitHubAccount{Repository: "synthetic/private", Login: saved})
				if err := c.St.SetMeta(ctx, githubAccountKey(r.id), string(b)); err != nil {
					t.Fatal(err)
				}
			}
			fixture := t.TempDir()
			log := filepath.Join(fixture, "calls")
			t.Setenv("FIXTURE_GIT", realGit)
			t.Setenv("FIXTURE_CALLS", log)
			// This fake helper never sees real keychain data and never reaches a network.
			gh := `#!/bin/sh
printf '%s\n' "$*" >> "$FIXTURE_CALLS"
case "$1 $2" in
 'auth status') printf '%s' '{"hosts":{"github.com":[{"state":"success","active":true,"login":"personal"},{"state":"success","active":false,"login":"collaborator"}]}}';;
 'auth token') case "$6" in collaborator) printf fixture-ok;; personal) printf fixture-denied;; *) exit 1;; esac;;
 'pr list') test "$GH_TOKEN" = fixture-ok || exit 1; printf '[]';;
 *) exit 80;;
esac
`
			gitScript := `#!/bin/sh
for a in "$@"; do
 if test "$a" = fetch; then
  if test "$GH_TOKEN" != fixture-ok; then printf 'repository not found\n' >&2; exit 128; fi
  for last in "$@"; do :; done
  ref=${last#*:}
  exec "$FIXTURE_GIT" -C "$2" update-ref "$ref" main
 fi
done
exec "$FIXTURE_GIT" "$@"
`
			for name, body := range map[string]string{"gh": gh, "git": gitScript} {
				if err := os.WriteFile(filepath.Join(fixture, name), []byte(body), 0700); err != nil {
					t.Fatal(err)
				}
			}
			t.Setenv("PATH", fixture+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("GH_TOKEN", "")
			before := strings.TrimSpace(git(t, dir, "config", "--local", "--list"))
			for i := 0; i < 2; i++ {
				account, err := c.fetchMergeRemote(ctx, r, "origin", "https://github.com/synthetic/private.git", "refs/heads/main")
				if err != nil || account != "collaborator" {
					t.Fatal(account, err)
				}
			}
			after := strings.TrimSpace(git(t, dir, "config", "--local", "--list"))
			if after != before {
				t.Fatal("Git config modified")
			}
			raw, err := c.St.Meta(ctx, githubAccountKey(r.id))
			if err != nil || strings.Contains(raw, "fixture-") {
				t.Fatal("token persisted", err)
			}
			var selected repoGitHubAccount
			if json.Unmarshal([]byte(raw), &selected) != nil || selected.Login != "collaborator" {
				t.Fatal(raw)
			}
			calls, err := os.ReadFile(log)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(calls), "switch") || strings.Contains(string(calls), "login ") || strings.Contains(string(calls), "fixture-") {
				t.Fatal("unexpected auth mutation/token leak", string(calls))
			}
			if saved == "collaborator" && strings.Contains(string(calls), "auth status") {
				t.Fatal("cached account was rediscovered")
			}
			if _, note := githubMergeProof(ctx, dir, "synthetic/private", "feat/GT-1-x", "main", "source", "target", "collaborator"); note != "" {
				t.Fatal("PR query lost repo-specific account", note)
			}
		})
	}
}

func TestAuthFailureDetectionDoesNotTreatNetworkAsAccountFailure(t *testing.T) {
	for _, v := range []string{"repository not found", "Authentication failed", "could not read Username", "The requested URL returned error: 403"} {
		if !gitAuthFailure(&fixtureError{v}) {
			t.Fatal(v)
		}
	}
	for _, v := range []string{"TLS connection timeout", "connection reset", "fatal: not a git repository"} {
		if gitAuthFailure(&fixtureError{v}) {
			t.Fatal(v)
		}
	}
}

type fixtureError struct{ text string }

func (e *fixtureError) Error() string { return e.text }
