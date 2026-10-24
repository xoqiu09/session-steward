package core

import (
	"database/sql"
	"encoding/json"
)

type mergeMember struct {
	id, item, status string
	binding          MergeBinding
}

func sameMerge(a, b MergeBinding) bool {
	return a.RepoID != 0 && a.SourceRef != "" && a.SourceHeadSHA != "" && a.TargetRef != "" && a.TargetBaseSHA != "" &&
		a.RepoID == b.RepoID && a.SourceRef == b.SourceRef && a.SourceHeadSHA == b.SourceHeadSHA && a.TargetRef == b.TargetRef && a.TargetBaseSHA == b.TargetBaseSHA
}

// A decision is for one exact Git operation, potentially covering several work items.
// Permission/decision approvals are deliberately never included here.
func mergeMembers(tx *sql.Tx, id string) ([]mergeMember, error) {
	var selected mergeMember
	var payload string
	err := tx.QueryRow(`SELECT id,COALESCE(work_item_id,''),status,payload FROM approvals WHERE id=? AND kind='merge'`, id).Scan(&selected.id, &selected.item, &selected.status, &payload)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if selected.status != "pending" && selected.status != "decided" {
		return nil, ErrConflict
	}
	if err = json.Unmarshal([]byte(payload), &selected.binding); err != nil {
		return nil, ErrBadRequest
	}
	rows, err := tx.Query(`SELECT id,COALESCE(work_item_id,''),status,payload FROM approvals WHERE kind='merge' AND status IN ('pending','decided') ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []mergeMember
	for rows.Next() {
		var m mergeMember
		if err = rows.Scan(&m.id, &m.item, &m.status, &payload); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(payload), &m.binding); err != nil {
			continue
		}
		if m.id == id || sameMerge(m.binding, selected.binding) {
			out = append(out, m)
		}
	}
	return out, rows.Err()
}
