package core

import "database/sql"

type dependencyCondition struct{ upstream, cond string }

// Only a satisfied -> unsatisfied transition starts a new dependency incident.
// Raw state history captures recovery even if no Snapshot/Pending/Check ran in
// between, and keeps DepSatisfied as the single definition of readiness.
func dependencyLossTimes(tx *sql.Tx) (map[dependencyCondition]string, error) {
	rows, err := tx.Query(`SELECT DISTINCT h.work_item_id,d.cond,h.old_status,h.old_merge_state,h.status,h.merge_state,h.at
		FROM work_item_state_changes h JOIN work_deps d ON d.upstream=h.work_item_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[dependencyCondition]string{}
	for rows.Next() {
		var key dependencyCondition
		var oldStatus, oldMerge, status, merge, at string
		if err := rows.Scan(&key.upstream, &key.cond, &oldStatus, &oldMerge, &status, &merge, &at); err != nil {
			return nil, err
		}
		if DepSatisfied(key.cond, oldStatus, oldMerge) && !DepSatisfied(key.cond, status, merge) && at > out[key] {
			out[key] = at
		}
	}
	return out, rows.Err()
}
