package core

import (
	"context"
	"database/sql"

	"github.com/xoqiu09/session-steward/internal/scan"
	"github.com/xoqiu09/session-steward/internal/store"
)

// RefreshTitles only annotates already discovered sessions. Titles never bind
// work items, change activity timestamps, or revive an ended session.
func (c *Core) RefreshTitles(ctx context.Context, hostID string, titles []scan.Title) error {
	changed := false
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		for _, title := range titles {
			if title.Text == "" {
				continue
			}
			result, err := tx.Exec(`INSERT INTO session_titles(session_id,title,source,updated_at)
				SELECT id,?,?,? FROM sessions WHERE host_id=? AND provider=? AND provider_session_id=?
				ON CONFLICT(session_id) DO UPDATE SET title=excluded.title,source=excluded.source,updated_at=excluded.updated_at
				WHERE excluded.updated_at >= session_titles.updated_at AND (excluded.title<>session_titles.title OR excluded.source<>session_titles.source OR excluded.updated_at<>session_titles.updated_at)`,
				title.Text, title.Source, store.TS(title.UpdatedAt), hostID, title.Provider, title.SessionID)
			if err != nil {
				return err
			}
			n, err := result.RowsAffected()
			if err != nil {
				return err
			}
			changed = changed || n > 0
		}
		if changed {
			return store.Touch(tx, c.St.NowTS(), "session", "titles")
		}
		return nil
	})
	if err == nil && changed {
		c.notify()
	}
	return err
}
