package core

import (
	"database/sql"
	"time"

	"github.com/xoqiu09/session-steward/internal/store"
)

// 项目活跃度只决定默认在哪里显示，不改变归档、回收站、工作项或验收记录。
//   - active：有未结束且未被你暂停/转交/处理的工作、有待处理请求，或 7 天内有活动；
//   - quiet：7–30 天没有活动；
//   - dormant：超过 30 天没有活动，或从没有会话和工作。
//
// 活动时间只看会话和请求；你暂停、转交或处理工作不算项目又有了动静。
const (
	ActivityActive  = "active"
	ActivityQuiet   = "quiet"
	ActivityDormant = "dormant"

	QuietAfter   = 7 * 24 * time.Hour
	DormantAfter = 30 * 24 * time.Hour
)

type repoActivity struct {
	Last string
	Open bool
}

type querier interface {
	Query(query string, args ...any) (*sql.Rows, error)
}

func repoActivities(q querier) (map[int64]repoActivity, error) {
	rows, err := q.Query(`SELECT r.id,
	 MAX(COALESCE((SELECT MAX(last_activity_at) FROM sessions s WHERE s.repo_id=r.id),''),
	     COALESCE((SELECT MAX(created_at) FROM approvals a WHERE a.repo_id=r.id),'')),
	 EXISTS(SELECT 1 FROM work_items w WHERE w.repo_id=r.id AND w.status NOT IN ('done','abandoned')
	   AND NOT EXISTS(SELECT 1 FROM meta m WHERE m.k='work_management:'||w.id AND json_extract(m.v,'$.state') IN ('paused','delegated','accepted')))
	 OR EXISTS(SELECT 1 FROM approvals a WHERE a.repo_id=r.id AND a.status='pending')
	 FROM repos r`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]repoActivity{}
	for rows.Next() {
		var id int64
		var a repoActivity
		if err := rows.Scan(&id, &a.Last, &a.Open); err != nil {
			return nil, err
		}
		out[id] = a
	}
	return out, rows.Err()
}

func (a repoActivity) tier(now time.Time) string {
	switch {
	case a.Open || a.Last != "" && a.Last >= store.TS(now.Add(-QuietAfter)):
		return ActivityActive
	case a.Last != "" && a.Last >= store.TS(now.Add(-DormantAfter)):
		return ActivityQuiet
	}
	return ActivityDormant
}

func applyRepoActivity(q querier, now time.Time, repos []Repo) error {
	activity, err := repoActivities(q)
	if err != nil {
		return err
	}
	for i := range repos {
		a := activity[repos[i].ID]
		repos[i].Activity, repos[i].LastActivityAt = a.tier(now), a.Last
	}
	return nil
}
