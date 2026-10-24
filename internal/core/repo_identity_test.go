package core

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestRepositoryIdentityReconciliationKeepsLedgerAndAcceptance(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	root := filepath.Join(t.TempDir(), "project")
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(t.TempDir(), "compat")
	if err := os.Symlink(root, link); err != nil {
		t.Fatal(err)
	}
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		statements := []struct {
			q    string
			args []any
		}{
			{`INSERT INTO repos(id,name,common_dir,is_git,created_at) VALUES(1,'project',?,0,?),(2,'project',?,1,?),(3,'project','/different-clone/.git',1,?)`, []any{"dir:" + link, now, filepath.Join(root, ".git"), now, now}},
			{`INSERT INTO work_items(id,repo_id,title,status,created_at,updated_at) VALUES('FIX-1',1,'synthetic','review',?,?)`, []any{now, now}},
			{`INSERT INTO sessions(id,host_id,provider,provider_session_id,repo_id,first_seen_at) VALUES(1,'synthetic','codex','s',1,?)`, []any{now}},
			{`INSERT INTO runs(id,session_id,work_item_id,attempt,binding,started_at) VALUES(1,1,'FIX-1',1,'tag',?)`, []any{now}},
			{`INSERT INTO project_features(repo_id,feature_id,title,scope_basis,scope_status,created_at) VALUES(1,'feature','Synthetic feature','spec','documented',?)`, []any{now}},
			{`INSERT INTO feature_reports(repo_id,feature_id,event_id,session_id,run_id,work_item_id,body,at,received_at) VALUES(1,'feature','event-1',1,1,'FIX-1','{"id":"feature","candidate":"synthetic-sha","implementation":"implemented","validation":"passed","evidence":"synthetic test"}',?,?)`, []any{now, now}},
			{`INSERT INTO events(event_id,kind,occurred_at,received_at,body) VALUES('original','synthetic',?,?,'original audit body')`, []any{now, now}},
		}
		for _, s := range statements {
			if _, err := tx.Exec(s.q, s.args...); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	snap, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f := snap.Features[0]
	if err = c.AcceptFeature(ctx, 1, f.ID, f.Candidate, f.Revision, "accepted"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err = c.ReconcileRepos(ctx); err != nil {
			t.Fatal(err)
		}
	}
	snap, err = c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Repos) != 2 || len(snap.WorkItems) != 1 || len(snap.Runs) != 1 || len(snap.Features) != 1 || !snap.Features[0].Accepted || snap.Features[0].RepoID != 2 || *snap.WorkItems[0].RepoID != 2 || *snap.Sessions[0].RepoID != 2 || snap.WorkItems[0].Status != "review" {
		t.Fatalf("ledger/state lost: %+v", snap)
	}
	var count int
	var audit string
	if err = c.St.R().QueryRow(`SELECT COUNT(*) FROM repos`).Scan(&count); err != nil || count != 3 {
		t.Fatalf("old repo rows deleted: %d %v", count, err)
	}
	if err = c.St.R().QueryRow(`SELECT body FROM events WHERE event_id='original'`).Scan(&audit); err != nil || audit != "original audit body" {
		t.Fatal("audit changed", err)
	}
	if err = c.St.R().QueryRow(`SELECT COUNT(*) FROM pragma_foreign_key_check`).Scan(&count); err != nil || count != 0 {
		t.Fatal("foreign keys", count, err)
	}
	if err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		id, err := ensureRepo(tx, &locInfo{commonDir: "dir:" + link, repoName: "project"}, now)
		if err == nil && id != 2 {
			t.Errorf("alias rebound: %d", id)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestDirectoryPromotesWithoutAnotherRepoAndScopesDoNotOverwrite(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	now := c.St.NowTS()
	root := t.TempDir()
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		old, err := ensureRepo(tx, &locInfo{commonDir: "dir:" + root, repoName: "project"}, now)
		if err != nil {
			return err
		}
		current, err := ensureRepo(tx, &locInfo{isGit: true, commonDir: filepath.Join(root, ".git"), worktree: root, repoName: "project"}, now)
		if err == nil && old != current {
			t.Errorf("created duplicate %d %d", old, current)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := c.St.R().QueryRow(`SELECT COUNT(*) FROM repos`).Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
	// Different scopes for the same feature ID are deliberately retained for review.
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO repos(id,name,common_dir,is_git,created_at) VALUES(2,'project',?,0,?)`, "dir:"+root, now)
		if err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT INTO project_features(repo_id,feature_id,title,created_at) VALUES(1,'overlap','one',?),(2,'overlap','different',?)`, now, now)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.ReconcileRepos(ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.St.R().QueryRow(`SELECT COUNT(*) FROM repo_aliases`).Scan(&count); err != nil || count != 0 {
		t.Fatal("conflicting scopes merged", count, err)
	}
}
