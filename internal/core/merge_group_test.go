package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
)

func groupFixture(t *testing.T) *Core {
	t.Helper()
	c := newCore(t, nil)
	now := c.St.NowTS()
	err := c.St.Tx(context.Background(), func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO repos(id,name,common_dir,created_at) VALUES(1,'synthetic','/one/.git',?),(2,'synthetic','/two/.git',?)`, now, now); err != nil {
			return err
		}
		for _, id := range []string{"A-1", "A-2", "B-1"} {
			repo := 1
			if id == "B-1" {
				repo = 2
			}
			if _, err := tx.Exec(`INSERT INTO work_items(id,repo_id,title,status,branch,needs_merge,created_at,updated_at) VALUES(?,?,'synthetic','review','feat/shared',1,?,?)`, id, repo, now, now); err != nil {
				return err
			}
			b, _ := json.Marshal(MergeBinding{RepoID: int64(repo), SourceRef: "feat/shared", SourceHeadSHA: "source-sha", TargetRef: "main", TargetBaseSHA: "target-sha"})
			if _, err := tx.Exec(`INSERT INTO approvals(id,kind,status,work_item_id,repo_id,payload,created_at) VALUES(?,'merge','pending',?,?,?,?)`, id, id, repo, string(b), now); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSharedMergeApprovalIsAtomicAndDoesNotAcceptWork(t *testing.T) {
	c := groupFixture(t)
	ctx := context.Background()
	if err := c.ApproveMerge(ctx, "A-1", "wrong-sha", "target-sha"); err == nil {
		t.Fatal("wrong candidate accepted")
	}
	if err := c.ApproveMerge(ctx, "A-1", "source-sha", "target-sha"); err != nil {
		t.Fatal(err)
	}
	var decided, review, other int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE status='decided'`).Scan(&decided)
	c.St.R().QueryRow(`SELECT COUNT(*) FROM work_items WHERE status='review'`).Scan(&review)
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE id='B-1' AND status='pending'`).Scan(&other)
	if decided != 2 || review != 3 || other != 1 {
		t.Fatal("wrong scope or automatic acceptance", decided, review, other)
	}
	text, err := c.MergeInstruction(ctx, "A-1")
	if err != nil || !strings.Contains(text, "A-1、A-2") {
		t.Fatal(text, err)
	}
	if err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE work_items SET status='done' WHERE id='A-2'`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err = c.RejectMerge(ctx, "A-2", "withdrawn"); err != nil {
		t.Fatal(err)
	}
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE status='cancelled'`).Scan(&decided)
	if decided != 2 {
		t.Fatal("group rejection incomplete", decided)
	}
	var status string
	if err = c.St.R().QueryRow(`SELECT status FROM work_items WHERE id='A-2'`).Scan(&status); err != nil || status != "done" {
		t.Fatal("merge rejection revoked a user's acceptance", status, err)
	}
}

func TestSharedMergeWithStaleMemberDoesNotPartiallyApprove(t *testing.T) {
	c := groupFixture(t)
	ctx := context.Background()
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE approvals SET payload=json_set(payload,'$.stale','target_moved') WHERE id='A-2'`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.ApproveMerge(ctx, "A-1", "source-sha", "target-sha"); err == nil {
		t.Fatal("stale group accepted")
	}
	var count int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE status='decided'`).Scan(&count)
	if count != 0 {
		t.Fatal("partial group approval", count)
	}
}
