package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/xoqiu09/session-steward/internal/store"
)

func canonicalPath(p string) string {
	if real, err := filepath.EvalSymlinks(p); err == nil {
		p = real
	}
	return filepath.Clean(p)
}

func canonicalIdentity(identity string) string {
	if strings.HasPrefix(identity, "dir:") {
		return "dir:" + canonicalPath(strings.TrimPrefix(identity, "dir:"))
	}
	return canonicalPath(identity)
}

func canonicalRepo(tx *sql.Tx, id int64) (int64, error) {
	for depth := 0; depth < 32; depth++ {
		var next int64
		err := tx.QueryRow(`SELECT canonical_id FROM repo_aliases WHERE repo_id=?`, id).Scan(&next)
		if errors.Is(err, sql.ErrNoRows) {
			return id, nil
		}
		if err != nil {
			return 0, err
		}
		id = next
	}
	return 0, fmt.Errorf("repository alias cycle")
}

// ReconcileRepos promotes directory identities and symlink aliases. Repository names
// and remote URLs are never identity evidence. Original rows/IDs remain in the ledger.
func (c *Core) ReconcileRepos(ctx context.Context) error {
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		type entry struct {
			id            int64
			identity, key string
			git           bool
		}
		rows, err := tx.Query(`SELECT id,common_dir,is_git FROM repos WHERE id NOT IN (SELECT repo_id FROM repo_aliases) ORDER BY id`)
		if err != nil {
			return err
		}
		var entries []entry
		gitRoots := map[string]string{}
		for rows.Next() {
			var e entry
			if err = rows.Scan(&e.id, &e.identity, &e.git); err != nil {
				rows.Close()
				return err
			}
			e.key = canonicalIdentity(e.identity)
			entries = append(entries, e)
			if e.git && filepath.Base(e.key) == ".git" {
				if info, statErr := os.Stat(e.key); statErr == nil && info.IsDir() {
					gitRoots[filepath.Dir(e.key)] = e.key
				}
			}
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		groups := map[string][]entry{}
		for _, e := range entries {
			if root, ok := gitRoots[strings.TrimPrefix(e.key, "dir:")]; !e.git && ok {
				e.key = root
			}
			groups[e.key] = append(groups[e.key], e)
		}
		for key, group := range groups {
			winner := group[0]
			for _, e := range group {
				if (e.git && !winner.git) || (e.git == winner.git && e.identity == key) {
					winner = e
				}
			}
			// Overlapping feature definitions require reconciliation; do not overwrite either scope.
			for _, e := range group {
				if e.id == winner.id {
					continue
				}
				var collisions int
				if err = tx.QueryRow(`SELECT COUNT(*) FROM project_features a JOIN project_features b ON a.feature_id=b.feature_id WHERE a.repo_id=? AND b.repo_id=?`, e.id, winner.id).Scan(&collisions); err != nil {
					return err
				}
				if collisions > 0 {
					continue
				}
				if _, err = tx.Exec(`PRAGMA defer_foreign_keys=ON`); err != nil {
					return err
				}
				for _, table := range []string{"work_items", "sessions", "approvals", "project_features", "feature_reports", "feature_acceptances", "feature_scope_decisions", "managed_sessions", "merge_jobs"} {
					if _, err = tx.Exec(`UPDATE `+table+` SET repo_id=? WHERE repo_id=?`, winner.id, e.id); err != nil {
						return err
					}
				}
				// Approval payloads are live bindings; raw source events remain unchanged.
				if _, err = tx.Exec(`UPDATE approvals SET payload=json_set(payload,'$.repo_id',?) WHERE kind='merge' AND json_valid(payload) AND json_extract(payload,'$.repo_id')=?`, winner.id, e.id); err != nil {
					return err
				}
				if _, err = tx.Exec(`INSERT INTO repo_aliases(repo_id,canonical_id) VALUES(?,?)`, e.id, winner.id); err != nil {
					return err
				}
				if _, err = tx.Exec(`UPDATE repo_aliases SET canonical_id=? WHERE canonical_id=?`, winner.id, e.id); err != nil {
					return err
				}
				if _, err = tx.Exec(`UPDATE repo_identities SET repo_id=? WHERE repo_id=?`, winner.id, e.id); err != nil {
					return err
				}
				if _, err = tx.Exec(`INSERT INTO repo_identities(identity,repo_id) VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET repo_id=excluded.repo_id`, e.identity, winner.id); err != nil {
					return err
				}
			}
			if winner.identity != key {
				if _, err = tx.Exec(`INSERT INTO repo_identities(identity,repo_id) VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET repo_id=excluded.repo_id`, winner.identity, winner.id); err != nil {
					return err
				}
				if _, err = tx.Exec(`UPDATE repos SET common_dir=? WHERE id=?`, key, winner.id); err != nil {
					return err
				}
			}
		}
		return store.Touch(tx, c.St.NowTS(), "repo", "")
	})
}
