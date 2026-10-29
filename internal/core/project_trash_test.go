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

func TestProjectTrashRestoresOriginalScopeWithoutDeletingFiles(t *testing.T) {
	for _, archived := range []bool{false, true} {
		t.Run(map[bool]string{false: "active", true: "archived"}[archived], func(t *testing.T) {
			c, dir, _ := gateRepo(t, nil)
			ctx := context.Background()
			before, _ := c.Snapshot(ctx)
			id := before.Repos[0].ID
			var schema int
			c.St.R().QueryRow(`PRAGMA user_version`).Scan(&schema)
			head := gitx.RevParse(ctx, dir, "main")
			keep := filepath.Join(dir, "keep-local.txt")
			os.WriteFile(keep, []byte("synthetic local changes"), 0600)
			if archived {
				if err := c.ArchiveProjects(ctx, []int64{id}, true); err != nil {
					t.Fatal(err)
				}
			}
			p, _ := c.Projects(ctx)
			original := p[0].ArchivedAt
			if err := c.TrashProjects(ctx, []int64{id, id}, true); err != nil {
				t.Fatal(err)
			}
			p, _ = c.Projects(ctx)
			firstTrash := p[0].TrashedAt
			if firstTrash == "" || p[0].TrashedFromArchive != archived {
				t.Fatal(p)
			}
			if err := c.TrashProjects(ctx, []int64{id}, true); err != nil {
				t.Fatal(err)
			}
			p, _ = c.Projects(ctx)
			if p[0].TrashedAt != firstTrash {
				t.Fatal("repeated deletion changed recovery record")
			}
			s, _ := c.Snapshot(ctx)
			if len(s.Repos) != 0 || len(s.WorkItems) != 0 || s.TrashedProjects != 1 || s.ArchivedProjects != 0 {
				t.Fatal("trash leaked into live projection", s)
			}
			sum, err := c.HubLocalSummary(ctx, "synthetic", "Test Mac", false)
			if err != nil || len(sum.Snapshot.Repos) != 0 {
				t.Fatal("trash leaked into hub", err)
			}
			e := ev("trash-fresh-hook", event.KindPrompt, time.Now())
			e.Cwd = dir
			if _, err = c.Ingest(ctx, e); err != nil {
				t.Fatal(err)
			}
			s, _ = c.Snapshot(ctx)
			if len(s.Repos) != 0 {
				t.Fatal("new event resurrected deleted project")
			}
			if err = c.ArchiveProjects(ctx, []int64{id}, false); !errors.Is(err, ErrConflict) {
				t.Fatal("ordinary restore bypassed trash", err)
			}
			if err = c.TrashProjects(ctx, []int64{id}, false); err != nil {
				t.Fatal(err)
			}
			if err = c.TrashProjects(ctx, []int64{id}, false); err != nil {
				t.Fatal(err)
			}
			p, _ = c.Projects(ctx)
			if p[0].TrashedAt != "" || p[0].ArchivedAt != original {
				t.Fatal("restore lost original scope", p)
			}
			s, _ = c.Snapshot(ctx)
			if (len(s.Repos) == 0) != archived || s.TrashedProjects != 0 {
				t.Fatal("wrong restoration visibility", s)
			}
			var status, decision string
			c.St.R().QueryRow(`SELECT status FROM work_items WHERE id='GT-1'`).Scan(&status)
			c.St.R().QueryRow(`SELECT decision FROM approvals WHERE kind='merge'`).Scan(&decision)
			if status != "review" || decision != "approve" {
				t.Fatal("trash changed acceptance or decision", status, decision)
			}
			var after int
			c.St.R().QueryRow(`PRAGMA user_version`).Scan(&after)
			data, err := os.ReadFile(keep)
			if after != schema || err != nil || string(data) != "synthetic local changes" || gitx.RevParse(ctx, dir, "main") != head {
				t.Fatal("trash changed files, Git or schema")
			}
		})
	}
}

func TestProjectTrashBatchAtomicAndSSE(t *testing.T) {
	c, _, _ := gateRepo(t, nil)
	ctx := context.Background()
	p, _ := c.Projects(ctx)
	id := p[0].ID
	for _, ids := range [][]int64{nil, {0}, make([]int64, 201), {id, 99999}} {
		if err := c.TrashProjects(ctx, ids, true); err == nil {
			t.Fatal("invalid batch accepted", ids)
		}
	}
	p, _ = c.Projects(ctx)
	if p[0].TrashedAt != "" || p[0].ArchivedAt != "" {
		t.Fatal("failed batch partially applied")
	}
	ch, cancel := c.Subscribe()
	defer cancel()
	if err := c.TrashProjects(ctx, []int64{id}, true); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ch:
	default:
		t.Fatal("trash did not notify state consumers")
	}
	if err := c.TrashProjects(ctx, []int64{id, 99999}, false); !errors.Is(err, ErrNotFound) {
		t.Fatal(err)
	}
	p, _ = c.Projects(ctx)
	if p[0].TrashedAt == "" {
		t.Fatal("failed restore partially applied")
	}
}

func TestProjectTrashSurvivesAliasReconciliation(t *testing.T) {
	for _, winnerArchived := range []bool{false, true} {
		t.Run(map[bool]string{false: "active-winner", true: "archived-winner"}[winnerArchived], func(t *testing.T) {
			c, dir, _ := gateRepo(t, nil)
			ctx := context.Background()
			p, _ := c.Projects(ctx)
			id := p[0].ID
			if winnerArchived {
				if err := c.ArchiveProjects(ctx, []int64{id}, true); err != nil {
					t.Fatal(err)
				}
			}
			p, _ = c.Projects(ctx)
			original := p[0].ArchivedAt
			var alias int64
			if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
				r, err := tx.Exec(`INSERT INTO repos(name,common_dir,is_git,created_at) VALUES('Synthetic alias',?,0,?)`, "dir:"+dir, c.St.NowTS())
				if err != nil {
					return err
				}
				alias, err = r.LastInsertId()
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if err := c.TrashProjects(ctx, []int64{alias}, true); err != nil {
				t.Fatal(err)
			}
			if err := c.ReconcileRepos(ctx); err != nil {
				t.Fatal(err)
			}
			p, _ = c.Projects(ctx)
			if len(p) != 1 || p[0].ID != id || p[0].TrashedAt == "" {
				t.Fatal("alias reconciliation lost trash state", p)
			}
			if err := c.TrashProjects(ctx, []int64{alias}, false); err != nil {
				t.Fatal(err)
			}
			p, _ = c.Projects(ctx)
			if p[0].ArchivedAt != original || p[0].TrashedAt != "" {
				t.Fatal("alias restore lost original archive", p)
			}
		})
	}
}
