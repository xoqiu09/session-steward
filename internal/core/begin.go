package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

// beginWork 在采集事务里完成命名、创建/复用和归属，失败不留下空任务。
func (c *Core) beginWork(tx *sql.Tx, sid int64, e *event.Event, project *locInfo, now string) (string, error) {
	title := clip(e.WorkTitle)
	e.WorkTitle = title
	if title == "" {
		return "", fmt.Errorf("%w: begin 需要 --title", ErrBadRequest)
	}
	var current, currentTitle, currentProject string
	err := tx.QueryRow(`SELECT w.id,w.title,COALESCE(p.common_dir,'') FROM runs r JOIN work_items w ON w.id=r.work_item_id LEFT JOIN repos p ON p.id=w.repo_id WHERE r.session_id=? AND r.ended_at='' ORDER BY r.id DESC LIMIT 1`, sid).Scan(&current, &currentTitle, &currentProject)
	if err == nil {
		if !strings.EqualFold(strings.TrimSpace(currentTitle), title) || currentProject != project.commonDir {
			return "", fmt.Errorf("%w: 当前会话已关联 %s，继续当前工作请用 report；确需切换任务再显式 claim，原归属已保留", ErrConflict, current)
		}
		return current, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	repoID, err := ensureRepo(tx, project, now)
	if err != nil {
		return "", err
	}
	branch := project.branch
	if !distinctBranch(branch) {
		branch = ""
	}
	rows, err := tx.Query(`SELECT id,title FROM work_items WHERE repo_id=? AND status NOT IN ('done','abandoned') AND branch=?`, repoID, branch)
	if err != nil {
		return "", err
	}
	var matches []string
	for rows.Next() {
		var id, t string
		if err = rows.Scan(&id, &t); err != nil {
			rows.Close()
			return "", err
		}
		if strings.EqualFold(strings.TrimSpace(t), title) {
			matches = append(matches, id)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return "", err
	}
	if len(matches) > 1 {
		return "", fmt.Errorf("%w: 有多个同名工作项，请显式 claim 编号", ErrConflict)
	}
	var item string
	if len(matches) == 1 {
		item = matches[0]
	} else {
		item, err = autoItemID(tx, autoRepo{id: repoID, name: project.repoName, common: project.commonDir, git: project.isGit})
		if err != nil {
			return "", err
		}
		needs := 0
		merge := "none"
		if project.isGit && branch != "" {
			needs = 1
			merge = "not_ready"
		}
		_, err = tx.Exec(`INSERT INTO work_items(id,repo_id,title,status,branch,needs_merge,merge_state,created_at,updated_at) VALUES(?,?,?,'todo',?,?,?,?,?)`, item, repoID, title, branch, needs, merge, now, now)
		if err != nil {
			return "", err
		}
	}
	if err = bindRun(tx, sid, item, "tag", store.TS(e.OccurredAt), now); err != nil {
		return "", err
	}
	return item, store.Touch(tx, now, "work_item", item)
}

// ReportingHint 对已有会话只在第一次普通输入时提醒；恢复/启动仍可重新提供上下文。
func (c *Core) ReportingHint(ctx context.Context, host, provider, session string, startup bool) (string, bool, error) {
	var item string
	show := false
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		var sid int64
		err := tx.QueryRow(`SELECT s.id,COALESCE(r.work_item_id,'') FROM sessions s LEFT JOIN runs r ON r.session_id=s.id AND r.ended_at='' WHERE s.host_id=? AND s.provider=? AND s.provider_session_id=? AND s.state<>'ended'`, host, provider, session).Scan(&sid, &item)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		result, err := tx.Exec(`INSERT INTO reporting_hint_versions(session_id,version,sent_at) VALUES(?,3,?)
      ON CONFLICT(session_id) DO UPDATE SET version=excluded.version,sent_at=excluded.sent_at WHERE version<3`, sid, c.St.NowTS())
		if err != nil {
			return err
		}
		n, _ := result.RowsAffected()
		show = startup || n > 0
		return nil
	})
	return item, show, err
}

// ReportingPreviousItem is a continuation hint, not a binding. Only an engine
// SessionEnd may suggest resuming: never revive a manual unbind or completed item.
func (c *Core) ReportingPreviousItem(ctx context.Context, host, provider, session string) (string, error) {
	var item string
	err := c.St.R().QueryRowContext(ctx, `SELECT CASE WHEN r.ended_at<>'' AND r.outcome=''
		AND w.status NOT IN ('done','abandoned') AND EXISTS (
		 SELECT 1 FROM events e WHERE e.session_id=s.id AND e.kind='session_end' AND e.occurred_at=r.ended_at
		) THEN w.id ELSE '' END FROM sessions s JOIN runs r ON r.session_id=s.id
		JOIN work_items w ON w.id=r.work_item_id
		WHERE s.host_id=? AND s.provider=? AND s.provider_session_id=? ORDER BY r.id DESC LIMIT 1`, host, provider, session).Scan(&item)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return item, err
}
