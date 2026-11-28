package core

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/store"
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

func TestLateToolEventKeepsCurrentSessionLocation(t *testing.T) {
	c := newCore(t, mixedLocator{})
	ctx := context.Background()
	at := time.Date(2026, 11, 28, 10, 0, 0, 0, time.UTC)
	start := ev("s1", event.KindSessionStart, at)
	start.Cwd, start.Branch = "/repo-a", "branch-a"
	mustIngest(t, c, start)
	moved := ev("s1", event.KindCwdChanged, at.Add(5*time.Minute))
	moved.Cwd, moved.Branch = "/repo-b", "branch-b"
	mustIngest(t, c, moved)
	late := ev("s1", event.KindToolPost, at.Add(time.Minute))
	late.Cwd, late.Branch = start.Cwd, start.Branch
	mustIngest(t, c, late)

	snap, err := c.Snapshot(ctx)
	if err != nil || len(snap.Sessions) != 1 {
		t.Fatalf("应有一个会话，得到 %+v，错误 %v", snap, err)
	}
	session := snap.Sessions[0]
	var repoDir string
	for _, repo := range snap.Repos {
		if session.RepoID != nil && repo.ID == *session.RepoID {
			repoDir = repo.CommonDir
		}
	}
	if session.Cwd != moved.Cwd || session.Worktree != moved.Cwd || session.Branch != moved.Branch || repoDir != moved.Cwd+"/.git" || session.LastActivityAt != store.TS(moved.OccurredAt) {
		t.Errorf("迟到工具记录后的会话 = 项目 %q，目录 %q，工作树 %q，分支 %q，最近活动 %s，应仍在乙项目", repoDir, session.Cwd, session.Worktree, session.Branch, session.LastActivityAt)
	}
	history, err := c.SessionEvents(ctx, session.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range history {
		var saved event.Event
		if err := json.Unmarshal(body, &saved); err != nil {
			t.Fatal(err)
		}
		if saved.EventID == late.EventID && saved.Kind == late.Kind && saved.Cwd == late.Cwd && saved.Branch == late.Branch {
			return
		}
	}
	t.Fatal("会话历史应保留甲项目的工具记录")
}

func TestLateToolEventUpdatesLocationAfterStopWithoutDirectory(t *testing.T) {
	c := newCore(t, mixedLocator{})
	ctx := context.Background()
	at := time.Date(2026, 11, 28, 10, 0, 0, 0, time.UTC)
	start := ev("s1", event.KindSessionStart, at)
	start.Cwd, start.Branch = "/repo-a", "branch-a"
	mustIngest(t, c, start)
	stop := ev("s1", event.KindStop, at.Add(5*time.Minute))
	stop.Cwd = ""
	mustIngest(t, c, stop)
	late := ev("s1", event.KindToolPost, at.Add(4*time.Minute))
	late.Cwd, late.Branch = "/repo-b", "branch-b"
	mustIngest(t, c, late)

	snap, err := c.Snapshot(ctx)
	if err != nil || len(snap.Sessions) != 1 {
		t.Fatalf("应有一个会话，得到 %+v，错误 %v", snap, err)
	}
	session := snap.Sessions[0]
	if session.Cwd != late.Cwd || session.Worktree != late.Cwd || session.Branch != late.Branch {
		t.Errorf("目录、工作树和分支应更新到乙，实际为 %q、%q、%q", session.Cwd, session.Worktree, session.Branch)
	}
	var project string
	for _, repo := range snap.Repos {
		if session.RepoID != nil && repo.ID == *session.RepoID {
			project = repo.CommonDir
		}
	}
	if project != late.Cwd+"/.git" {
		t.Errorf("当前项目应为乙，实际为 %q", project)
	}
	if session.LastActivityAt != store.TS(stop.OccurredAt) || session.State != "idle" {
		t.Errorf("最近活动和状态应仍来自停止消息，实际为 %s、%s", session.LastActivityAt, session.State)
	}
	history, err := c.SessionEvents(ctx, session.ID, 10)
	if err != nil {
		t.Fatal(err)
	}
	for _, body := range history {
		var saved event.Event
		if err := json.Unmarshal(body, &saved); err != nil {
			t.Fatal(err)
		}
		if saved.EventID == late.EventID && saved.Kind == late.Kind && saved.Cwd == late.Cwd {
			return
		}
	}
	t.Fatal("会话历史应保留乙项目的工具记录")
}
