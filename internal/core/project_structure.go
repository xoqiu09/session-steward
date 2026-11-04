package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/xoqiu09/session-steward/internal/projectstructure"
	"github.com/xoqiu09/session-steward/internal/store"
)

const structurePrefix = "project_structure:"

type ProjectStructure struct {
	RepoID    int64                     `json:"repo_id"`
	Document  projectstructure.Document `json:"document"`
	Revision  string                    `json:"revision"`
	UpdatedAt string                    `json:"updated_at"`
	Author    string                    `json:"author"` // user | agent; no acceptance meaning
}

func structureKey(repo int64) string { return structurePrefix + strconv.FormatInt(repo, 10) }

func readProjectStructure(tx *sql.Tx, repo int64) (*ProjectStructure, error) {
	raw, err := projectMeta(tx, structureKey(repo))
	if err != nil || raw == "" {
		return nil, err
	}
	var p ProjectStructure
	if err = json.Unmarshal([]byte(raw), &p); err != nil {
		return nil, err
	}
	return &p, nil
}

func (c *Core) ProjectStructure(ctx context.Context, repo int64) (*ProjectStructure, error) {
	tx, err := c.St.R().BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	id, err := canonicalRepo(tx, repo)
	if err != nil {
		return nil, err
	}
	var exists int
	if err = tx.QueryRow(`SELECT 1 FROM repos WHERE id=?`, id).Scan(&exists); err == sql.ErrNoRows {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	return readProjectStructure(tx, id)
}

// SaveProjectStructure changes only presentation metadata. It never writes feature,
// WorkItem, Run, Approval, orchestration or acceptance tables. Exact revisions prevent
// late suggestions from overwriting newer edits; Agent writes cannot replace user edits.
func (c *Core) SaveProjectStructure(ctx context.Context, repo int64, raw json.RawMessage, base, author string) (*ProjectStructure, error) {
	d, err := projectstructure.Decode(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	if author != "user" && author != "agent" {
		return nil, ErrForbidden
	}
	var saved *ProjectStructure
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		id, err := canonicalRepo(tx, repo)
		if err != nil {
			return err
		}
		if id != repo {
			return fmt.Errorf("%w: 项目归属已变化，请刷新", ErrConflict)
		}
		var exists int
		if err = tx.QueryRow(`SELECT 1 FROM repos WHERE id=?`, repo).Scan(&exists); err == sql.ErrNoRows {
			return ErrNotFound
		} else if err != nil {
			return err
		}
		if trash, err := projectMeta(tx, trashPrefix+strconv.FormatInt(repo, 10)); err != nil {
			return err
		} else if trash != "" {
			return fmt.Errorf("%w: 请先从回收站恢复项目", ErrConflict)
		}
		prev, err := readProjectStructure(tx, repo)
		if err != nil {
			return err
		}
		if prev == nil && base != "" || prev != nil && prev.Revision != base {
			return fmt.Errorf("%w: 目录已经变化，请重新读取后比较", ErrConflict)
		}
		if prev != nil && prev.Author == "user" && author == "agent" {
			return fmt.Errorf("%w: 目录已有手工调整，请将新建议交给用户在面板导入", ErrConflict)
		}
		for _, g := range d.Groups {
			for _, f := range g.Features {
				if err = tx.QueryRow(`SELECT 1 FROM project_features WHERE repo_id=? AND feature_id=?`, repo, f.ID).Scan(&exists); err == sql.ErrNoRows {
					return fmt.Errorf("%w: 本项目未登记功能 %s；请先复用或登记功能 ID", ErrBadRequest, f.ID)
				} else if err != nil {
					return err
				}
			}
		}
		now := c.St.NowTS()
		saved = &ProjectStructure{RepoID: repo, Document: d, UpdatedAt: now, Author: author, Revision: featureHash([]any{base, d, author, now})}
		body, err := json.Marshal(saved)
		if err != nil {
			return err
		}
		if prev != nil {
			old, _ := json.Marshal(prev)
			if _, err = tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING`, "project_structure_history:"+strconv.FormatInt(repo, 10)+":"+prev.Revision, string(old)); err != nil {
				return err
			}
		}
		if _, err = tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, structureKey(repo), string(body)); err != nil {
			return err
		}
		return store.Touch(tx, now, "project_structure", strconv.FormatInt(repo, 10))
	})
	if err == nil {
		c.notify()
	}
	return saved, err
}

func readProjectStructures(tx *sql.Tx, repos []Repo) ([]ProjectStructure, error) {
	out := []ProjectStructure{}
	visible := map[int64]bool{}
	for _, r := range repos {
		visible[r.ID] = true
	}
	rows, err := tx.Query(`SELECT v FROM meta WHERE k GLOB 'project_structure:[0-9]*' ORDER BY k`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var p ProjectStructure
		if err = json.Unmarshal([]byte(raw), &p); err != nil {
			return nil, err
		}
		if visible[p.RepoID] {
			out = append(out, p)
		}
	}
	return out, rows.Err()
}

// Alias reconciliation preserves a structure's ownership and refuses two competing
// descriptions, just as it already preserves conflicting feature definitions.
func structureMergeAllowed(tx *sql.Tx, from, to int64) (bool, error) {
	a, err := readProjectStructure(tx, from)
	if err != nil {
		return false, err
	}
	b, err := readProjectStructure(tx, to)
	if err != nil {
		return false, err
	}
	return a == nil || b == nil, nil
}

func moveProjectStructure(tx *sql.Tx, from, to int64) error {
	p, err := readProjectStructure(tx, from)
	if err != nil || p == nil {
		return err
	}
	p.RepoID = to
	body, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?)`, structureKey(to), string(body)); err != nil {
		return err
	}
	_, err = tx.Exec(`DELETE FROM meta WHERE k=?`, structureKey(from))
	return err
}
