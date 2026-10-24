package core

import (
	"context"
	"database/sql"
	"errors"
	"os"

	"github.com/xoqiu09/session-steward/internal/scan"
	"github.com/xoqiu09/session-steward/internal/store"
)

// ImportHistory 把冷启动扫描到的会话登记为“仅历史发现”。
// 已存在的会话（包括实时采集中的）不会被覆盖状态，只补全缺失的位置信息。
func (c *Core) ImportHistory(ctx context.Context, hostID string, found []scan.Found) (added int, err error) {
	type located struct {
		f   scan.Found
		loc *locInfo
	}
	var list []located
	for _, f := range found {
		var l *locInfo
		if c.Loc != nil && f.Cwd != "" {
			if _, statErr := statDir(f.Cwd); statErr == nil {
				g := c.Loc.Locate(ctx, f.Cwd)
				l = &locInfo{g.IsGit, g.CommonDir, g.Worktree, g.Branch, g.RepoName}
			}
		}
		list = append(list, located{f, l})
	}
	now := c.St.NowTS()
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		for _, it := range list {
			f := it.f
			var id int64
			e := tx.QueryRow(`SELECT id FROM sessions WHERE host_id=? AND provider=? AND provider_session_id=?`, hostID, f.Provider, f.SessionID).Scan(&id)
			if e == nil {
				continue
			}
			if !errors.Is(e, sql.ErrNoRows) {
				return e
			}
			var repoID int64
			wt := ""
			branch := f.Branch
			if it.loc != nil {
				if repoID, e = ensureRepo(tx, it.loc, now); e != nil {
					return e
				}
				wt = it.loc.worktree
			}
			first := f.FirstAt
			if first.IsZero() {
				first = f.LastAt
			}
			client := f.Client
			if client == "" {
				client = "unknown"
			}
			if _, e = tx.Exec(`INSERT INTO sessions(host_id, provider, provider_session_id, client, version, cwd, worktree, branch, repo_id,
				state, state_at, data_source, first_seen_at, last_activity_at) VALUES (?,?,?,?,?,?,?,?,?,'unknown','', 'history', ?, ?)`,
				hostID, f.Provider, f.SessionID, client, f.Version, f.Cwd, wt, branch, nullInt(repoID),
				store.TS(first), store.TS(f.LastAt)); e != nil {
				return e
			}
			added++
		}
		if added > 0 {
			return store.Touch(tx, now, "session", "")
		}
		return nil
	})
	c.notify()
	return added, err
}

func statDir(p string) (os.FileInfo, error) { return os.Stat(p) }
