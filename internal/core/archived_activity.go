package core

import (
	"context"
	"database/sql"
	"fmt"
	"strconv"

	"github.com/xoqiu09/session-steward/internal/store"
)

// 归档只是收起显示，新的 hooks 不会自动恢复项目。归档以后（或上次选“继续收起”以后）
// 又有新会话活动的项目，在面板上提示一次，由你决定恢复还是继续收起。回收站里的项目不提示。
const archiveSeenPrefix = "repo_archive_seen:"

type ArchivedActivity struct {
	RepoID         int64  `json:"repo_id"`
	Name           string `json:"name"`
	CommonDir      string `json:"common_dir"`
	ArchivedAt     string `json:"archived_at"`
	LastActivityAt string `json:"last_activity_at"`
}

func archivedActivity(q querier) ([]ArchivedActivity, error) {
	rows, err := q.Query(`SELECT r.id, r.name, r.common_dir, a.v, MAX(s.last_activity_at)
	 FROM repos r JOIN meta a ON a.k='repo_archive:'||r.id AND a.v<>''
	 JOIN sessions s ON s.repo_id=r.id
	 LEFT JOIN meta seen ON seen.k='` + archiveSeenPrefix + `'||r.id
	 WHERE r.id NOT IN (SELECT repo_id FROM repo_aliases)
	   AND NOT EXISTS (SELECT 1 FROM meta t WHERE t.k='repo_trash:'||r.id AND t.v<>'')
	 GROUP BY r.id
	 HAVING MAX(s.last_activity_at) > MAX(a.v, COALESCE(MAX(seen.v),''))
	 ORDER BY MAX(s.last_activity_at) DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ArchivedActivity{}
	for rows.Next() {
		var a ArchivedActivity
		if err := rows.Scan(&a.RepoID, &a.Name, &a.CommonDir, &a.ArchivedAt, &a.LastActivityAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// KeepArchived 记下“继续收起”：这次的活动不再提示，之后再有新活动时再提示。
func (c *Core) KeepArchived(ctx context.Context, ids []int64) error {
	if len(ids) == 0 || len(ids) > 200 {
		return fmt.Errorf("%w: 请选择 1 至 200 个项目", ErrBadRequest)
	}
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		for _, id := range ids {
			if _, err := tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, archiveSeenPrefix+strconv.FormatInt(id, 10), now); err != nil {
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
