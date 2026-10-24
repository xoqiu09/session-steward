package core

import (
	"database/sql"
	"errors"
	"regexp"
	"strings"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

// 归属优先级：manual > tag > inherited > branch_guess（branch_guess 只作为建议，不建 run）。
var bindingRank = map[string]int{"manual": 3, "tag": 2, "managed": 2, "inherited": 1, "auto": 1}

// 分支名中的工作项编号：feat/QM-014-xxx、fix/215-xxx（后者需要结合仓库前缀，只作建议）。
var branchTagRe = regexp.MustCompile(`(?i)(?:^|/)([a-z][a-z0-9]{0,15}-\d{1,6})(?:[-_/]|$)`)

func GuessFromBranch(branch string) string {
	m := branchTagRe.FindStringSubmatch(branch)
	if m == nil {
		return ""
	}
	return strings.ToUpper(m[1])
}

func (c *Core) attribute(tx *sql.Tx, sid int64, e *event.Event, now string) error {
	switch {
	case e.Kind == event.KindClaim && e.WorkTag != "":
		return bindRun(tx, sid, e.WorkTag, "tag", store.TS(e.OccurredAt), now)
	case e.Kind == event.KindPrompt && e.WorkTag != "":
		if itemExists(tx, e.WorkTag) {
			return bindRun(tx, sid, e.WorkTag, "tag", store.TS(e.OccurredAt), now)
		}
	}
	// 没有有效绑定时，用分支名生成建议
	if e.Branch != "" {
		if g := GuessFromBranch(e.Branch); g != "" && itemExists(tx, g) {
			var cur string
			tx.QueryRow(`SELECT work_item_id FROM runs WHERE session_id=? AND ended_at='' LIMIT 1`, sid).Scan(&cur)
			sugg := ""
			if cur == "" {
				sugg = g
			}
			_, err := tx.Exec(`UPDATE sessions SET suggested_work_item=? WHERE id=?`, sugg, sid)
			return err
		}
	}
	return nil
}

func itemExists(tx *sql.Tx, id string) bool {
	var n int
	tx.QueryRow(`SELECT COUNT(1) FROM work_items WHERE id=?`, id).Scan(&n)
	return n > 0
}

// bindRun 把 session 绑定到工作项。已有同一工作项的进行中 run 时，只在新绑定优先级更高时升级来源；
// 绑定到不同工作项时，结束旧 run（结果：转交）并开新 run。低优先级绑定不会覆盖高优先级的人工绑定。
func bindRun(tx *sql.Tx, sid int64, item, binding, at, now string) error {
	if !itemExists(tx, item) {
		return ErrNotFound
	}
	var runID int64
	var curItem, curBinding string
	err := tx.QueryRow(`SELECT id, work_item_id, binding FROM runs WHERE session_id=? AND ended_at='' ORDER BY id DESC LIMIT 1`, sid).
		Scan(&runID, &curItem, &curBinding)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil {
		if curItem == item {
			if bindingRank[binding] > bindingRank[curBinding] {
				_, err = tx.Exec(`UPDATE runs SET binding=? WHERE id=?`, binding, runID)
			}
			return err
		}
		if bindingRank[binding] < bindingRank[curBinding] {
			return nil
		}
		if _, err := tx.Exec(`UPDATE runs SET ended_at=?, outcome='handed_off' WHERE id=?`, at, runID); err != nil {
			return err
		}
	}
	var attempt int
	tx.QueryRow(`SELECT COALESCE(MAX(attempt),0)+1 FROM runs WHERE work_item_id=?`, item).Scan(&attempt)
	if _, err := tx.Exec(`INSERT INTO runs(work_item_id, session_id, attempt, binding, started_at) VALUES (?,?,?,?,?)`,
		item, sid, attempt, binding, at); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE sessions SET suggested_work_item='' WHERE id=?`, sid); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE work_items SET status='in_progress', updated_at=? WHERE id=? AND status='todo'`, now, item); err != nil {
		return err
	}
	return store.Touch(tx, now, "work_item", item)
}

var ErrNotFound = errors.New("not found")
