package core

import (
	"context"
	"net/url"
)

func (c *Core) visibleProjectAlerts(ctx context.Context, alerts []Alert) ([]Alert, error) {
	rows, err := c.St.R().QueryContext(ctx, `WITH archived AS (
	 SELECT r.id FROM repos r JOIN meta m ON m.k='repo_archive:'||r.id AND m.v<>''
	), wi AS (SELECT id FROM work_items WHERE repo_id IN (SELECT id FROM archived)),
	ss AS (SELECT s.id FROM sessions s WHERE s.repo_id IN (SELECT id FROM archived)
	 OR EXISTS (SELECT 1 FROM runs r WHERE r.session_id=s.id AND r.ended_at='' AND r.work_item_id IN (SELECT id FROM wi)))
	SELECT 'item='||id FROM wi UNION SELECT 'session='||id FROM ss
	UNION SELECT 'approval='||id FROM approvals WHERE repo_id IN (SELECT id FROM archived)
	 OR work_item_id IN (SELECT id FROM wi) OR session_id IN (SELECT id FROM ss)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hidden := map[string]bool{}
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		hidden[key] = true
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return keepRows(alerts, func(a Alert) bool {
		u, err := url.Parse(a.Link)
		if err != nil {
			return true
		}
		f, err := url.QueryUnescape(u.Fragment)
		return err != nil || !hidden[f]
	}), nil
}
