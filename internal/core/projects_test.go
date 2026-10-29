package core

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
)

func TestProjectArchiveRestoresLedgerFilesAndHub(t *testing.T) {
	c, dir, _ := gateRepo(t, nil)
	ctx := context.Background()
	before, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	id := before.Repos[0].ID
	version := 0
	if err := c.St.R().QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := c.ArchiveProjects(ctx, []int64{id}, true); err != nil {
		t.Fatal(err)
	}
	s, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Repos) != 0 || len(s.Sessions) != 0 || len(s.WorkItems) != 0 || len(s.Approvals) != 0 || s.ArchivedProjects != 1 {
		t.Fatalf("archive leaked into live views: %+v", s)
	}
	sum, err := c.HubLocalSummary(ctx, "synthetic", "Test Mac", false)
	if err != nil || len(sum.Snapshot.Repos) != 0 || len(sum.Snapshot.WorkItems) != 0 {
		t.Fatal("hub still exports archived project", err)
	}
	projects, err := c.Projects(ctx)
	if err != nil || len(projects) != 1 || projects[0].ArchivedAt == "" || projects[0].OpenItems != 1 {
		t.Fatal("management lost archived entry", projects, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "b")); err == nil {
		t.Fatal("test baseline expected main without feature file")
	}
	if gitx.RevParse(ctx, dir, "feat/GT-1-x") == "" {
		t.Fatal("archive deleted source branch")
	}
	// Fresh hooks for the same repository cannot silently undo the user's archive.
	e := ev("archived-hook", event.KindPrompt, time.Now())
	e.Cwd = dir
	if _, err := c.Ingest(ctx, e); err != nil {
		t.Fatal(err)
	}
	s, _ = c.Snapshot(ctx)
	if len(s.Repos) != 0 {
		t.Fatal("hooks resurrected archive")
	}
	if err := c.ArchiveProjects(ctx, []int64{id}, false); err != nil {
		t.Fatal(err)
	}
	s, err = c.Snapshot(ctx)
	if err != nil || len(s.WorkItems) != 1 || s.WorkItems[0].Status != "review" || len(s.Sessions) != 2 {
		t.Fatal("restore lost records or accepted work", s, err)
	}
	var afterVersion int
	c.St.R().QueryRow(`PRAGMA user_version`).Scan(&afterVersion)
	if afterVersion != version {
		t.Fatal("archive changed schema version")
	}
}

func TestProjectArchiveBatchIsAtomicAndNotifies(t *testing.T) {
	c, _, _ := gateRepo(t, nil)
	ctx := context.Background()
	p, _ := c.Projects(ctx)
	id := p[0].ID
	ch, cancel := c.Subscribe()
	defer cancel()
	if err := c.ArchiveProjects(ctx, []int64{id, 99999}, true); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	p, _ = c.Projects(ctx)
	if p[0].ArchivedAt != "" {
		t.Fatal("partial batch archive")
	}
	if err := c.ArchiveProjects(ctx, []int64{id, id}, true); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ch:
	default:
		t.Fatal("archive did not notify SSE")
	}
	var status, decision string
	c.St.R().QueryRow(`SELECT status,decision FROM approvals WHERE kind='merge'`).Scan(&status, &decision)
	if status != "decided" || decision != "approve" {
		t.Fatal("archive changed approval", status, decision)
	}
}

func TestArchiveFiltersNotificationsAndKeepsExternalDependencyUnmet(t *testing.T) {
	c, _, _ := gateRepo(t, nil)
	ctx := context.Background()
	p, _ := c.Projects(ctx)
	id := p[0].ID
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "OTHER-1", Title: "another project"}); err != nil {
		t.Fatal(err)
	}
	if err := c.AddDep(ctx, "GT-1", "OTHER-1", "accepted"); err != nil {
		t.Fatal(err)
	}
	if err := c.ArchiveProjects(ctx, []int64{id}, true); err != nil {
		t.Fatal(err)
	}
	s, err := c.Snapshot(ctx)
	if err != nil || len(s.WorkItems) != 1 || s.WorkItems[0].Ready || len(s.WorkItems[0].Waiting) != 1 {
		t.Fatal("archiving falsely satisfied dependency", s, err)
	}
	alerts, err := c.visibleProjectAlerts(ctx, []Alert{{Link: "http://localhost/#item=GT-1"}, {Link: "http://localhost/#item=OTHER-1"}})
	if err != nil || len(alerts) != 1 || alerts[0].Link != "http://localhost/#item=OTHER-1" {
		t.Fatal("notification filter", alerts, err)
	}
}

func TestArchiveFollowsCanonicalRepositoryIdentity(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	root := t.TempDir()
	gitDir := filepath.Join(root, ".git")
	os.Mkdir(gitDir, 0700)
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO repos(id,name,common_dir,is_git,created_at) VALUES(1,'alias',?,0,?),(2,'canonical',?,1,?)`, "dir:"+root, c.St.NowTS(), gitDir, c.St.NowTS())
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := c.ArchiveProjects(ctx, []int64{1}, true); err != nil {
		t.Fatal(err)
	}
	if err := c.ReconcileRepos(ctx); err != nil {
		t.Fatal(err)
	}
	p, err := c.Projects(ctx)
	if err != nil || len(p) != 1 || p[0].ID != 2 || p[0].ArchivedAt == "" {
		t.Fatal("archive lost during canonicalization", p, err)
	}
	if err := c.ArchiveProjects(ctx, []int64{1}, false); err != nil {
		t.Fatal(err)
	}
	s, _ := c.Snapshot(ctx)
	if len(s.Repos) != 1 || s.Repos[0].ID != 2 {
		t.Fatal("alias restore", s)
	}
}
