package core

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
)

// mixedLocator: /repo-* are Git repositories, everything else is a plain directory.
type mixedLocator struct{}

func (mixedLocator) Locate(_ context.Context, cwd string) gitx.Location {
	if strings.HasPrefix(cwd, "/repo-") {
		return gitx.Location{IsGit: true, CommonDir: cwd + "/.git", Worktree: cwd, Branch: "main", RepoName: cwd[1:]}
	}
	return gitx.Location{CommonDir: "dir:" + cwd, Worktree: cwd, RepoName: cwd[strings.LastIndex(cwd, "/")+1:]}
}

func TestToolEventsInPlainDirectoriesDoNotRegisterProjects(t *testing.T) {
	c := newCore(t, mixedLocator{})
	ctx := context.Background()
	at := time.Now().UTC()
	send := func(kind event.Kind, cwd string, offset int) {
		t.Helper()
		e := ev("synthetic", kind, at.Add(time.Duration(offset)*time.Second))
		e.Source.Provider = "codex"
		e.Cwd = cwd
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	repos := func() map[string]bool {
		t.Helper()
		out := map[string]bool{}
		rows, err := c.St.R().Query(`SELECT common_dir FROM repos`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var dir string
			rows.Scan(&dir)
			out[dir] = true
		}
		return out
	}
	sessionCwd := func() string {
		t.Helper()
		var cwd string
		if err := c.St.R().QueryRow(`SELECT cwd FROM sessions WHERE provider_session_id='synthetic'`).Scan(&cwd); err != nil {
			t.Fatal(err)
		}
		return cwd
	}
	send(event.KindSessionStart, "/repo-main", 0)
	// A receipt directory touched by a command: no new project, session stays put.
	send(event.KindToolPre, "/synthetic/tasks/receipt", 1)
	send(event.KindToolPost, "/synthetic/tasks/receipt", 2)
	send(event.KindPermission, "/synthetic/tasks/receipt", 3)
	if got := repos(); len(got) != 1 || !got["/repo-main/.git"] {
		t.Fatalf("command directory became a project: %v", got)
	}
	if cwd := sessionCwd(); cwd != "/repo-main" {
		t.Fatalf("session moved to a command directory: %s", cwd)
	}
	// Commands in another Git repository still attribute the session there.
	send(event.KindToolPre, "/repo-other", 4)
	if got := repos(); !got["/repo-other/.git"] || sessionCwd() != "/repo-other" {
		t.Fatalf("Git repository reached through a command was ignored: %v", got)
	}
	// A plain directory the user starts a session in is still a project, and
	// later commands there keep attributing to it.
	send(event.KindPrompt, "/synthetic/notes", 5)
	send(event.KindToolPost, "/synthetic/notes", 6)
	if got := repos(); !got["dir:/synthetic/notes"] || sessionCwd() != "/synthetic/notes" {
		t.Fatalf("session-level plain directory was not registered: %v", got)
	}
	send(event.KindToolPre, "/synthetic/tasks/receipt", 7)
	if got := repos(); got["dir:/synthetic/tasks/receipt"] || sessionCwd() != "/synthetic/notes" {
		t.Fatalf("receipt directory registered after a known plain project: %v", got)
	}
}
