package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/xoqiu09/session-steward/internal/store"
)

const archivePrefix = "repo_archive:"

// Archiving is a reversible display preference. It never changes files, Git,
// work-item acceptance, or the event ledger; old binaries can still open the DB.
type ProjectInfo struct {
	Repo
	ArchivedAt         string `json:"archived_at"`
	TrashedAt          string `json:"trashed_at,omitempty"`
	TrashedFromArchive bool   `json:"trashed_from_archive,omitempty"`
	OpenItems          int    `json:"open_items"`
	Sessions           int    `json:"sessions"`
	Running            int    `json:"running"`
	Pending            int    `json:"pending"`
}

func (c *Core) Projects(ctx context.Context) ([]ProjectInfo, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT r.id,r.name,r.common_dir,r.is_git,r.target_ref,COALESCE(m.v,''),
	 (SELECT COUNT(*) FROM work_items w WHERE w.repo_id=r.id AND w.status NOT IN ('done','abandoned')),
	 (SELECT COUNT(*) FROM sessions s WHERE s.repo_id=r.id),
	 (SELECT COUNT(*) FROM sessions s WHERE s.repo_id=r.id AND s.data_source='live' AND s.state IN ('running','waiting_permission')),
	 (SELECT COUNT(*) FROM approvals a WHERE a.repo_id=r.id AND a.status='pending'), COALESCE(t.v,'')
	 FROM repos r LEFT JOIN meta m ON m.k='repo_archive:'||r.id
	 LEFT JOIN meta t ON t.k='repo_trash:'||r.id
	 WHERE r.id NOT IN (SELECT repo_id FROM repo_aliases) ORDER BY r.name,r.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProjectInfo{}
	for rows.Next() {
		var p ProjectInfo
		var raw string
		if err := rows.Scan(&p.ID, &p.Name, &p.CommonDir, &p.IsGit, &p.TargetRef, &p.ArchivedAt, &p.OpenItems, &p.Sessions, &p.Running, &p.Pending, &raw); err != nil {
			return nil, err
		}
		if raw != "" {
			var info projectTrash
			if json.Unmarshal([]byte(raw), &info) == nil && info.At != "" {
				p.TrashedAt, p.TrashedFromArchive = info.At, info.ArchivedAt != ""
			} else {
				p.TrashedAt = "unknown"
			}
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (c *Core) ArchiveProjects(ctx context.Context, ids []int64, archived bool) error {
	if len(ids) == 0 || len(ids) > 200 {
		return fmt.Errorf("%w: 请选择 1 至 200 个项目", ErrBadRequest)
	}
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		canonical := map[int64]bool{}
		for _, id := range ids {
			if id <= 0 {
				return ErrBadRequest
			}
			id, err := canonicalRepo(tx, id)
			if err != nil {
				return err
			}
			var exists int
			if err = tx.QueryRow(`SELECT 1 FROM repos WHERE id=?`, id).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			} else if err != nil {
				return err
			}
			canonical[id] = true
			if raw, err := projectMeta(tx, trashPrefix+strconv.FormatInt(id, 10)); err != nil {
				return err
			} else if raw != "" {
				return fmt.Errorf("%w: 项目在回收站，请先恢复", ErrConflict)
			}
		}
		for id := range canonical {
			key := archivePrefix + strconv.FormatInt(id, 10)
			if archived {
				if _, err := tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING`, key, now); err != nil {
					return err
				}
			} else if _, err := tx.Exec(`DELETE FROM meta WHERE k=?`, key); err != nil {
				return err
			}
			if err := store.Touch(tx, now, "project", strconv.FormatInt(id, 10)); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		c.notify()
	}
	return err
}

func archivedProjects(tx *sql.Tx) (map[int64]bool, error) {
	rows, err := tx.Query(`SELECT k FROM meta WHERE (k LIKE 'repo_archive:%' OR k LIKE 'repo_trash:%') AND v<>''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		id, err := strconv.ParseInt(strings.TrimPrefix(strings.TrimPrefix(key, archivePrefix), trashPrefix), 10, 64)
		if err == nil {
			out[id] = true
		}
	}
	return out, rows.Err()
}

func keepRows[T any](rows []T, keep func(T) bool) []T {
	out := rows[:0]
	for _, row := range rows {
		if keep(row) {
			out = append(out, row)
		}
	}
	return out
}

// All live views, menu counts and hub exports use the same projection. Historical
// APIs and the underlying records stay intact; restoration immediately reveals them.
func projectVisibility(tx *sql.Tx, s *Snapshot) error {
	hidden, err := archivedProjects(tx)
	if err != nil || len(hidden) == 0 {
		return err
	}
	s.ArchivedProjects = len(hidden)
	trash, err := trashedProjectIDs(tx)
	if err != nil {
		return err
	}
	s.TrashedProjects = len(trash)
	s.ArchivedProjects -= s.TrashedProjects
	items, sessions := map[string]bool{}, map[int64]bool{}
	repoHidden := func(id *int64) bool { return id != nil && hidden[*id] }
	for _, w := range s.WorkItems {
		if repoHidden(w.RepoID) {
			items[w.ID] = true
		}
	}
	for _, x := range s.Sessions {
		if repoHidden(x.RepoID) || items[x.WorkItemID] {
			sessions[x.ID] = true
		}
	}
	s.Repos = keepRows(s.Repos, func(r Repo) bool { return !hidden[r.ID] })
	s.WorkItems = keepRows(s.WorkItems, func(w WorkItem) bool { return !items[w.ID] })
	s.Sessions = keepRows(s.Sessions, func(x Session) bool { return !sessions[x.ID] })
	s.Runs = keepRows(s.Runs, func(r Run) bool { return !items[r.WorkItemID] && !sessions[r.SessionID] })
	s.Approvals = keepRows(s.Approvals, func(a Approval) bool {
		return !repoHidden(a.RepoID) && (a.WorkItemID == nil || !items[*a.WorkItemID]) && (a.SessionID == nil || !sessions[*a.SessionID])
	})
	s.Deps = keepRows(s.Deps, func(d Dep) bool { return !items[d.Upstream] && !items[d.Downstream] })
	s.Attributions = keepRows(s.Attributions, func(a Attribution) bool { return !sessions[a.SessionID] && !items[a.WorkItemID] })
	s.Features = keepRows(s.Features, func(f ProjectFeature) bool { return !hidden[f.RepoID] })
	s.Managed = keepRows(s.Managed, func(m ManagedSession) bool { return !hidden[m.RepoID] && !items[m.WorkItemID] })
	s.MergeJobs = keepRows(s.MergeJobs, func(m MergeJob) bool { return !hidden[m.RepoID] && !items[m.WorkItemID] })
	s.SessionUsage = keepRows(s.SessionUsage, func(u SessionUsage) bool { return !sessions[u.SessionID] })
	s.ItemUsage = keepRows(s.ItemUsage, func(u ItemUsage) bool { return !items[u.WorkItemID] })
	s.Handoffs = keepRows(s.Handoffs, func(h Handoff) bool { return !items[h.WorkItemID] })
	s.CheckedRepos = keepRows(s.CheckedRepos, func(id int64) bool { return !hidden[id] })
	s.SummaryRepos = keepRows(s.SummaryRepos, func(id int64) bool { return !hidden[id] })
	return nil
}
