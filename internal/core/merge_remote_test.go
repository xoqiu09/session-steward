package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMergeStatusRetiresOldFailureWithoutRewritingHistory(t *testing.T) {
	c, _, _ := gateRepo(t, nil)
	ctx := context.Background()
	s, _ := c.Snapshot(ctx)
	id := s.Repos[0].ID
	b, _ := json.Marshal(MergeSyncStatus{RepoID: id, State: "failed", Error: "old authentication error", PRNote: "old PR note", CheckedAt: c.St.NowTS()})
	if err := c.St.SetMeta(ctx, remoteMergeKey(id), string(b)); err != nil {
		t.Fatal(err)
	}
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE work_items SET merge_state='merged' WHERE id='GT-1'`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	statuses, err := c.MergeSyncStatuses(ctx)
	if err != nil || len(statuses) != 1 || statuses[0].State != "idle" || statuses[0].Error != "" || statuses[0].PRNote != "" || statuses[0].PendingItems != 0 {
		t.Fatal(statuses, err)
	}
	raw, _ := c.St.Meta(ctx, remoteMergeKey(id))
	if raw != string(b) {
		t.Fatal("old diagnostic history overwritten")
	}
}

func TestMissingProjectIsQuietAndRetriedAfterRestore(t *testing.T) {
	c, dir, _ := gateRepo(t, nil)
	ctx := context.Background()
	moved := dir + "-moved"
	if err := os.Rename(dir, moved); err != nil {
		t.Fatal(err)
	}
	if err := c.SyncMerges(ctx, true); err != nil {
		t.Fatal(err)
	}
	statuses, err := c.MergeSyncStatuses(ctx)
	if err != nil || len(statuses) != 1 || statuses[0].State != "missing" || statuses[0].Error != "" {
		t.Fatal(statuses, err)
	}
	old := statuses[0].CheckedAt
	c.St.Now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if err := c.SyncMerges(ctx, false); err != nil {
		t.Fatal(err)
	}
	statuses, _ = c.MergeSyncStatuses(ctx)
	if statuses[0].CheckedAt != old {
		t.Fatal("missing directory retried every tick")
	}
	if err := os.Rename(moved, dir); err != nil {
		t.Fatal(err)
	}
	if err := c.SyncMerges(ctx, false); err != nil {
		t.Fatal(err)
	}
	statuses, _ = c.MergeSyncStatuses(ctx)
	if statuses[0].State == "missing" || statuses[0].CheckedAt == old {
		t.Fatal("restored directory not retried", statuses)
	}
}

func TestExternalMergeSyncDoesNotPullOrAccept(t *testing.T) {
	for _, deleted := range []bool{false, true} {
		t.Run(map[bool]string{false: "branch-present", true: "branch-deleted"}[deleted], func(t *testing.T) {
			c, dir, approval := gateRepo(t, nil)
			ctx := context.Background()
			before := strings.TrimSpace(git(t, dir, "rev-parse", "main"))
			remote := filepath.Join(t.TempDir(), "origin.git")
			git(t, dir, "clone", "-q", "--bare", dir, remote)
			git(t, dir, "remote", "add", "origin", remote)
			other := filepath.Join(t.TempDir(), "other")
			git(t, dir, "clone", "-q", remote, other)
			git(t, other, "merge", "-q", "--no-edit", "origin/feat/GT-1-x")
			git(t, other, "push", "-q", "origin", "main")
			if deleted {
				git(t, dir, "branch", "-D", "feat/GT-1-x")
			} else if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
				if _, err := tx.Exec(`UPDATE approvals SET status='pending',decision='',decided_at='' WHERE id=?`, approval); err != nil {
					return err
				}
				_, err := tx.Exec(`UPDATE work_items SET merge_state='awaiting' WHERE id='GT-1'`)
				return err
			}); err != nil {
				t.Fatal(err)
			}
			if err := c.SyncMerges(ctx, true); err != nil {
				t.Fatal(err)
			}
			if got := strings.TrimSpace(git(t, dir, "rev-parse", "main")); got != before {
				t.Fatal("status check updated local main", got, before)
			}
			if _, err := os.Stat(filepath.Join(dir, "b")); err == nil {
				t.Fatal("status check updated working files")
			}
			s, err := c.Snapshot(ctx)
			if err != nil {
				t.Fatal(err)
			}
			w := s.WorkItems[0]
			if w.MergeState != "merged" || w.Status != "review" || w.MergeEvidence == nil || w.MergeEvidence.Method != "remote_git" {
				t.Fatal("external merge not reconciled independently of acceptance", w)
			}
			var status, decision string
			c.St.R().QueryRow(`SELECT status,decision FROM approvals WHERE id=?`, approval).Scan(&status, &decision)
			wantDecision := ""
			if deleted {
				wantDecision = "approve"
			}
			if status != "confirmed" || decision != wantDecision {
				t.Fatal("approval not closed or rewritten", status, decision)
			}
			statuses, err := c.MergeSyncStatuses(ctx)
			if err != nil || len(statuses) != 1 || statuses[0].Error != "" || statuses[0].TargetSHA == "" {
				t.Fatal(statuses, err)
			}
		})
	}
}

func TestCachedRemoteProofWithStaleLocalMain(t *testing.T) {
	c, dir, _ := gateRepo(t, nil)
	ctx := context.Background()
	before := strings.TrimSpace(git(t, dir, "rev-parse", "main"))
	git(t, dir, "branch", "cached-merged")
	git(t, dir, "checkout", "-q", "cached-merged")
	git(t, dir, "merge", "-q", "--no-edit", "feat/GT-1-x")
	merged := strings.TrimSpace(git(t, dir, "rev-parse", "HEAD"))
	git(t, dir, "checkout", "-q", "main")
	git(t, dir, "remote", "add", "origin", filepath.Join(t.TempDir(), "offline.git"))
	git(t, dir, "update-ref", "refs/remotes/origin/main", merged)
	git(t, dir, "branch", "--set-upstream-to=origin/main", "main")
	if err := c.ScanMerges(ctx); err != nil {
		t.Fatal(err)
	}
	s, err := c.Snapshot(ctx)
	if err != nil || s.WorkItems[0].MergeState != "merged" || s.WorkItems[0].MergeEvidence.Method != "remote_cached" {
		t.Fatal(s, err)
	}
	if strings.TrimSpace(git(t, dir, "rev-parse", "main")) != before {
		t.Fatal("local main moved")
	}
}

func TestRemoteFailureDoesNotInventMergeAndArchiveSkipsFetch(t *testing.T) {
	c, dir, _ := gateRepo(t, nil)
	ctx := context.Background()
	git(t, dir, "remote", "add", "origin", filepath.Join(t.TempDir(), "missing.git"))
	if err := c.SyncMerges(ctx, true); err != nil {
		t.Fatal(err)
	}
	s, _ := c.Snapshot(ctx)
	if s.WorkItems[0].MergeState != "approved" {
		t.Fatal("failed fetch changed merge state")
	}
	statuses, _ := c.MergeSyncStatuses(ctx)
	if len(statuses) != 1 || statuses[0].Error == "" {
		t.Fatal("failed fetch hidden", statuses)
	}
	if err := c.ArchiveProjects(ctx, []int64{s.Repos[0].ID}, true); err != nil {
		t.Fatal(err)
	}
	if err := c.SyncMerges(ctx, true); err != nil {
		t.Fatal(err)
	}
	statuses, _ = c.MergeSyncStatuses(ctx)
	if len(statuses) != 0 {
		t.Fatal("archived repo still in sync list")
	}
}

func TestSquashProofRequiresExactSourceAndTarget(t *testing.T) {
	c, dir, _ := gateRepo(t, nil)
	ctx := context.Background()
	_ = c
	src := strings.TrimSpace(git(t, dir, "rev-parse", "feat/GT-1-x"))
	git(t, dir, "merge", "--squash", "feat/GT-1-x")
	git(t, dir, "commit", "-qm", "squashed feature")
	target := strings.TrimSpace(git(t, dir, "rev-parse", "main"))
	for _, test := range []struct {
		name, sha, base, merge string
		want                   bool
	}{
		{"exact", src, "main", target, true}, {"head-moved", "different", "main", target, false}, {"other-base", src, "release", target, false}, {"uncontained-merge", src, "main", "0000000000000000000000000000000000000000", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			b, _ := json.Marshal([]any{map[string]any{"headRefOid": test.sha, "headRefName": "feat/GT-1-x", "baseRefName": test.base, "mergeCommit": map[string]string{"oid": test.merge}, "url": "https://github.com/synthetic/project/pull/1"}})
			proof := verifiedPRProof(ctx, dir, b, "feat/GT-1-x", "main", src, target)
			if (proof != nil) != test.want {
				t.Fatalf("proof=%+v", proof)
			}
		})
	}
}

// 没有配置远端的仓库只按本地分支判断，核对状态是“仅本地”，不算失败，也不累计失败次数。
func TestLocalOnlyRepoIsNotAFailedCheck(t *testing.T) {
	c, _, _ := gateRepo(t, nil)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := c.SyncMerges(ctx, true); err != nil {
			t.Fatal(err)
		}
	}
	statuses, _ := c.MergeSyncStatuses(ctx)
	if len(statuses) != 1 || statuses[0].State != "local" || statuses[0].Error != "" || statuses[0].Failures != 0 {
		t.Fatalf("local-only repository reported as a failure: %+v", statuses)
	}
}
