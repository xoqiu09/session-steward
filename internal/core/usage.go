package core

import (
	"context"
	"database/sql"
	"time"

	"github.com/xoqiu09/session-steward/internal/store"
	"github.com/xoqiu09/session-steward/internal/usage"
)

// UsageSource 按会话返回累计 token 用量；找不到时 ok=false。
type UsageSource interface {
	Totals(provider, sessionID string) (usage.Totals, bool)
}

type SessionUsage struct {
	SessionID  int64  `json:"session_id"`
	Input      int64  `json:"input"`
	Output     int64  `json:"output"`
	CacheRead  int64  `json:"cache_read"`
	CacheWrite int64  `json:"cache_write"`
	UpdatedAt  string `json:"updated_at"`
}

// ItemUsage 是工作项的用量：关联会话的累计之和。Shared 为同时关联过其他工作项的会话数，
// 这些会话的用量无法按工作项拆分，会在各工作项中重复计入，界面需说明。
type ItemUsage struct {
	WorkItemID string `json:"work_item_id"`
	Input      int64  `json:"input"`
	Output     int64  `json:"output"`
	CacheRead  int64  `json:"cache_read"`
	CacheWrite int64  `json:"cache_write"`
	Sessions   int    `json:"sessions"`
	Shared     int    `json:"shared"`
}

// RefreshUsage 更新近期实时会话的用量。只写数字，不保存 transcript 内容或路径。
func (c *Core) RefreshUsage(ctx context.Context, src UsageSource, since time.Duration) (int, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT id,provider,provider_session_id FROM sessions
		WHERE provider IN ('claude','codex') AND subagent_id='' AND last_activity_at > ?`, store.TS(c.St.Now().Add(-since)))
	if err != nil {
		return 0, err
	}
	type row struct {
		id       int64
		provider string
		sid      string
	}
	var list []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.provider, &r.sid); err != nil {
			rows.Close()
			return 0, err
		}
		list = append(list, r)
	}
	rows.Close()
	changed := 0
	detail, _ := src.(DetailSource)
	for _, r := range list {
		t, ok := src.Totals(r.provider, r.sid)
		if !ok || t.Zero() {
			continue
		}
		// 按天归档：总数变了，或这个会话还没有归档过时才重读明细。
		if detail != nil {
			var n int
			_ = c.St.R().QueryRowContext(ctx, `SELECT COUNT(*) FROM usage_daily WHERE session_id=?`, r.id).Scan(&n)
			var old usage.Totals
			_ = c.St.R().QueryRowContext(ctx, `SELECT input,output,cache_read,cache_write FROM session_usage WHERE session_id=?`, r.id).Scan(&old.Input, &old.Output, &old.CacheRead, &old.CacheWrite)
			if n == 0 || old != t {
				if ch, err := c.archiveDaily(ctx, detail, r.id, r.provider, r.sid); err != nil {
					return changed, err
				} else if ch && old == t {
					changed++
				}
			}
		}
		now := c.St.NowTS()
		err := c.St.Tx(ctx, func(tx *sql.Tx) error {
			res, err := tx.Exec(`INSERT INTO session_usage(session_id,input,output,cache_read,cache_write,updated_at) VALUES(?,?,?,?,?,?)
				ON CONFLICT(session_id) DO UPDATE SET input=excluded.input,output=excluded.output,cache_read=excluded.cache_read,cache_write=excluded.cache_write,updated_at=excluded.updated_at
				WHERE input<>excluded.input OR output<>excluded.output OR cache_read<>excluded.cache_read OR cache_write<>excluded.cache_write`,
				r.id, t.Input, t.Output, t.CacheRead, t.CacheWrite, now)
			if err != nil {
				return err
			}
			if n, _ := res.RowsAffected(); n > 0 {
				changed++
				return store.Touch(tx, now, "usage", "")
			}
			return nil
		})
		if err != nil {
			return changed, err
		}
	}
	if changed > 0 {
		c.notify()
	}
	return changed, nil
}

func (c *Core) readUsage(tx *sql.Tx) ([]SessionUsage, []ItemUsage, error) {
	rows, err := tx.Query(`SELECT session_id,input,output,cache_read,cache_write,updated_at FROM session_usage`)
	if err != nil {
		return nil, nil, err
	}
	var sessions []SessionUsage
	for rows.Next() {
		var u SessionUsage
		if err := rows.Scan(&u.SessionID, &u.Input, &u.Output, &u.CacheRead, &u.CacheWrite, &u.UpdatedAt); err != nil {
			rows.Close()
			return nil, nil, err
		}
		sessions = append(sessions, u)
	}
	rows.Close()
	rows, err = tx.Query(`SELECT r.work_item_id, SUM(u.input), SUM(u.output), SUM(u.cache_read), SUM(u.cache_write), COUNT(1),
		SUM(CASE WHEN (SELECT COUNT(DISTINCT r2.work_item_id) FROM runs r2 WHERE r2.session_id=u.session_id AND r2.outcome<>'attribution_reverted')>1 THEN 1 ELSE 0 END)
		FROM (SELECT DISTINCT work_item_id, session_id FROM runs WHERE outcome<>'attribution_reverted') r
		JOIN session_usage u ON u.session_id=r.session_id GROUP BY r.work_item_id`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var items []ItemUsage
	for rows.Next() {
		var u ItemUsage
		if err := rows.Scan(&u.WorkItemID, &u.Input, &u.Output, &u.CacheRead, &u.CacheWrite, &u.Sessions, &u.Shared); err != nil {
			return nil, nil, err
		}
		items = append(items, u)
	}
	return sessions, items, rows.Err()
}
