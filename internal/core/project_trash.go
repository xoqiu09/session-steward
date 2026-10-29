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

const trashPrefix = "repo_trash:"

type projectTrash struct {
	At         string `json:"at"`
	ArchivedAt string `json:"archived_at"`
}

func projectMeta(tx *sql.Tx, key string) (string, error) {
	var raw string
	err := tx.QueryRow(`SELECT v FROM meta WHERE k=?`, key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return raw, err
}

// Trash is a recoverable visibility preference. Files, events and acceptance records stay intact.
func (c *Core) TrashProjects(ctx context.Context, ids []int64, trash bool) error {
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
		}
		for id := range canonical {
			key, archive := trashPrefix+strconv.FormatInt(id, 10), archivePrefix+strconv.FormatInt(id, 10)
			raw, err := projectMeta(tx, key)
			if err != nil {
				return err
			}
			if trash {
				if raw != "" {
					continue
				}
				previous, err := projectMeta(tx, archive)
				if err != nil {
					return err
				}
				data, _ := json.Marshal(projectTrash{At: now, ArchivedAt: previous})
				if _, err = tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?)`, key, string(data)); err != nil {
					return err
				}
				// Archive marker also keeps the project out of older readers' live views.
				if _, err = tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING`, archive, now); err != nil {
					return err
				}
			} else {
				if raw == "" {
					continue
				}
				var previous projectTrash
				if json.Unmarshal([]byte(raw), &previous) != nil || previous.At == "" {
					return fmt.Errorf("%w: 回收记录无法核对，请保留记录后检查", ErrConflict)
				}
				if previous.ArchivedAt == "" {
					_, err = tx.Exec(`DELETE FROM meta WHERE k=?`, archive)
				} else {
					_, err = tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, archive, previous.ArchivedAt)
				}
				if err != nil {
					return err
				}
				if _, err = tx.Exec(`DELETE FROM meta WHERE k=?`, key); err != nil {
					return err
				}
			}
			if err = store.Touch(tx, now, "project", strconv.FormatInt(id, 10)); err != nil {
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

func trashedProjectIDs(tx *sql.Tx) (map[int64]bool, error) {
	rows, err := tx.Query(`SELECT k FROM meta WHERE k LIKE 'repo_trash:%' AND v<>''`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := map[int64]bool{}
	for rows.Next() {
		var key string
		if err = rows.Scan(&key); err != nil {
			return nil, err
		}
		if id, err := strconv.ParseInt(strings.TrimPrefix(key, trashPrefix), 10, 64); err == nil {
			ids[id] = true
		}
	}
	return ids, rows.Err()
}

// Reconciliation of symlink aliases must not resurrect a project or lose its original archive scope.
func moveProjectVisibility(tx *sql.Tx, from, to int64) error {
	fromID, toID := strconv.FormatInt(from, 10), strconv.FormatInt(to, 10)
	raw, err := projectMeta(tx, trashPrefix+fromID)
	if err != nil {
		return err
	}
	if raw != "" {
		var info projectTrash
		archived, err := projectMeta(tx, archivePrefix+toID)
		if err != nil {
			return err
		}
		if json.Unmarshal([]byte(raw), &info) == nil && info.ArchivedAt == "" && archived != "" {
			info.ArchivedAt = archived
			data, _ := json.Marshal(info)
			raw = string(data)
		}
		if _, err = tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO NOTHING`, trashPrefix+toID, raw); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(`INSERT INTO meta(k,v) SELECT ?,v FROM meta WHERE k=? ON CONFLICT(k) DO NOTHING`, archivePrefix+toID, archivePrefix+fromID); err != nil {
		return err
	}
	for _, prefix := range []string{archivePrefix, trashPrefix} {
		if _, err = tx.Exec(`DELETE FROM meta WHERE k=?`, prefix+fromID); err != nil {
			return err
		}
	}
	return nil
}
