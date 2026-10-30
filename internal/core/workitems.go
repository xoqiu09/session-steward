package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"

	"github.com/xoqiu09/session-steward/internal/store"
)

var (
	itemIDRe      = regexp.MustCompile(`^[A-Z][A-Z0-9]{0,15}-\d{1,6}$`)
	ErrCycle      = errors.New("依赖会形成环")
	ErrBadRequest = errors.New("参数不合法")
)

var itemStatuses = map[string]bool{"todo": true, "in_progress": true, "blocked": true, "review": true, "done": true, "abandoned": true}

type WorkItemInput struct {
	ID         string `json:"id"`
	RepoID     int64  `json:"repo_id"`
	Title      string `json:"title"`
	Acceptance string `json:"acceptance"`
	Branch     string `json:"branch"`
	NeedsMerge *bool  `json:"needs_merge"`
	SessionID  *int64 `json:"session_id,omitempty"`
	RepoPath   string `json:"repo_path,omitempty"`
}

func (c *Core) CreateWorkItem(ctx context.Context, in WorkItemInput) error {
	in.ID = strings.ToUpper(strings.TrimSpace(in.ID))
	if !itemIDRe.MatchString(in.ID) {
		return fmt.Errorf("%w: 编号格式应为 ABC-123", ErrBadRequest)
	}
	if strings.TrimSpace(in.Title) == "" {
		return fmt.Errorf("%w: 标题不能为空", ErrBadRequest)
	}
	var location *locInfo
	if in.RepoPath != "" {
		if in.RepoID != 0 || c.Loc == nil {
			return fmt.Errorf("%w: 请选择项目或填写项目目录", ErrBadRequest)
		}
		info, err := os.Stat(in.RepoPath)
		if err != nil || !info.IsDir() {
			return fmt.Errorf("%w: 项目目录不存在", ErrBadRequest)
		}
		l := c.Loc.Locate(ctx, in.RepoPath)
		location = &locInfo{l.IsGit, l.CommonDir, l.Worktree, l.Branch, l.RepoName}
	}
	needs := 1
	if in.NeedsMerge != nil && !*in.NeedsMerge {
		needs = 0
	}
	mergeState := "not_ready"
	if needs == 0 {
		mergeState = "none"
	}
	now := c.St.NowTS()
	err := c.panelTx(ctx, func(tx *sql.Tx) error {
		var resolveErr error
		in.RepoID, resolveErr = canonicalRepo(tx, in.RepoID)
		if resolveErr != nil {
			return resolveErr
		}
		if location != nil {
			id, err := ensureRepo(tx, location, now)
			if err != nil {
				return err
			}
			in.RepoID = id
		}
		_, err := tx.Exec(`INSERT INTO work_items(id, repo_id, title, acceptance, branch, needs_merge, merge_state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
			in.ID, nullInt(in.RepoID), strings.TrimSpace(in.Title), in.Acceptance, strings.TrimSpace(in.Branch), needs, mergeState, now, now)
		if err != nil {
			if strings.Contains(err.Error(), "UNIQUE") {
				return fmt.Errorf("%w: 编号 %s 已存在", ErrBadRequest, in.ID)
			}
			return err
		}
		if in.SessionID != nil {
			var exists int
			if err := tx.QueryRow(`SELECT COUNT(1) FROM sessions WHERE id=?`, *in.SessionID).Scan(&exists); err != nil {
				return err
			}
			if exists == 0 {
				return ErrNotFound
			}
			if err := bindRun(tx, *in.SessionID, in.ID, "manual", now, now); err != nil {
				return err
			}
		}
		return store.Touch(tx, now, "work_item", in.ID)
	})
	c.notify()
	return err
}

type WorkItemPatch struct {
	Management *WorkManagement `json:"management"`
	Title      *string         `json:"title"`
	Acceptance *string         `json:"acceptance"`
	Branch     *string         `json:"branch"`
	Status     *string         `json:"status"`
	RepoID     *int64          `json:"repo_id"`
}

// UpdateWorkItem 是人工操作，可以把工作项改为任意状态（包括待验收、已完成）。
func (c *Core) UpdateWorkItem(ctx context.Context, id string, p WorkItemPatch) error {
	if p.Management != nil && p.Status != nil {
		return fmt.Errorf("%w: 管理操作和执行状态请分开提交", ErrBadRequest)
	}
	if err := validateManagement(p.Management); err != nil {
		return err
	}
	if p.Management != nil {
		switch p.Management.State {
		case "accepted":
			v := "done"
			p.Status = &v
		case "active", "delegated":
			v := "in_progress"
			p.Status = &v
		}
	}
	if p.Status != nil && !itemStatuses[*p.Status] {
		return fmt.Errorf("%w: 未知状态 %s", ErrBadRequest, *p.Status)
	}
	now := c.St.NowTS()
	err := c.panelTx(ctx, func(tx *sql.Tx) error {
		var oldStatus string
		if err := tx.QueryRow(`SELECT status FROM work_items WHERE id=?`, id).Scan(&oldStatus); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		set := []string{"updated_at=?"}
		args := []any{now}
		if p.Title != nil {
			set, args = append(set, "title=?"), append(args, strings.TrimSpace(*p.Title))
		}
		if p.Acceptance != nil {
			set, args = append(set, "acceptance=?"), append(args, *p.Acceptance)
		}
		if p.Branch != nil {
			set, args = append(set, "branch=?"), append(args, strings.TrimSpace(*p.Branch))
		}
		if p.RepoID != nil {
			repo, err := canonicalRepo(tx, *p.RepoID)
			if err != nil {
				return err
			}
			set, args = append(set, "repo_id=?"), append(args, nullInt(repo))
		}
		if p.Status != nil {
			set, args = append(set, "status=?"), append(args, *p.Status)
			if _, err := tx.Exec(`DELETE FROM meta WHERE k=?`, managementKey(id)); err != nil {
				return err
			}
		}
		args = append(args, id)
		if _, err := tx.Exec(`UPDATE work_items SET `+strings.Join(set, ",")+` WHERE id=?`, args...); err != nil {
			return err
		}
		if p.Status != nil && (oldStatus == "done" || oldStatus == "review" || oldStatus == "abandoned") && (*p.Status == "in_progress" || *p.Status == "todo" || *p.Status == "blocked") {
			for _, f := range []string{"stage", "next_owner"} {
				if _, err := tx.Exec(`INSERT INTO brief_entries(work_item_id,field,text,kind,source,at,created_at) VALUES(?,?,?,'user','reopened',?,?)`, id, f, "unknown", now, now); err != nil {
					return err
				}
			}
		}
		// 已放弃或已完成的工作项，结束其进行中的 run
		if p.Status != nil && (*p.Status == "abandoned" || *p.Status == "done") {
			outcome := "delivered"
			if *p.Status == "abandoned" {
				outcome = "abandoned"
			}
			if _, err := tx.Exec(`UPDATE runs SET ended_at=?, outcome=? WHERE work_item_id=? AND ended_at=''`, now, outcome, id); err != nil {
				return err
			}
		}
		if err := writeManagement(tx, id, now, p.Management); err != nil {
			return err
		}
		return store.Touch(tx, now, "work_item", id)
	})
	c.notify()
	return err
}

// AddDep 添加依赖并在写入前检测环。
func (c *Core) AddDep(ctx context.Context, upstream, downstream, cond string) error {
	if cond == "" {
		cond = "accepted"
	}
	if cond != "accepted" && cond != "merged" {
		return fmt.Errorf("%w: 条件只能是 accepted 或 merged", ErrBadRequest)
	}
	if upstream == downstream {
		return ErrCycle
	}
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		if !itemExists(tx, upstream) || !itemExists(tx, downstream) {
			return ErrNotFound
		}
		// downstream 能否到达 upstream？能则加边后成环
		if reachable(tx, downstream, upstream) {
			return ErrCycle
		}
		changed, err := tx.Exec(`INSERT INTO work_deps(upstream, downstream, cond) VALUES (?,?,?)
			ON CONFLICT(upstream, downstream) DO UPDATE SET cond=excluded.cond WHERE work_deps.cond<>excluded.cond`, upstream, downstream, cond)
		if err != nil {
			return err
		}
		if count, _ := changed.RowsAffected(); count > 0 {
			if _, err := tx.Exec(`UPDATE work_item_clocks SET dependencies_at=? WHERE work_item_id=?`, now, downstream); err != nil {
				return err
			}
		}
		return store.Touch(tx, now, "work_item", downstream)
	})
	c.notify()
	return err
}

func (c *Core) RemoveDep(ctx context.Context, upstream, downstream string) error {
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		changed, err := tx.Exec(`DELETE FROM work_deps WHERE upstream=? AND downstream=?`, upstream, downstream)
		if err != nil {
			return err
		}
		if count, _ := changed.RowsAffected(); count > 0 {
			if _, err := tx.Exec(`UPDATE work_item_clocks SET dependencies_at=? WHERE work_item_id=?`, now, downstream); err != nil {
				return err
			}
		}
		return store.Touch(tx, now, "work_item", downstream)
	})
	c.notify()
	return err
}

// reachable 判断从 from 沿依赖方向（上游→下游）能否到达 to。
func reachable(tx *sql.Tx, from, to string) bool {
	var n int
	tx.QueryRow(`WITH RECURSIVE r(id) AS (
		SELECT ? UNION SELECT d.downstream FROM work_deps d JOIN r ON d.upstream = r.id)
		SELECT COUNT(1) FROM r WHERE id = ?`, from, to).Scan(&n)
	return n > 0
}

// DepSatisfied 根据条件判断一个上游是否满足。已放弃的上游默认不满足。
func DepSatisfied(cond, upStatus, upMerge string) bool {
	switch upStatus {
	case "abandoned":
		return false
	}
	if cond == "merged" {
		return upMerge == "merged" || (upMerge == "none" && upStatus == "done")
	}
	return upStatus == "done"
}

// BindManual 人工把 session 绑定到工作项（最高优先级）。
func (c *Core) BindManual(ctx context.Context, sessionID int64, item string) error {
	now := c.St.NowTS()
	err := c.panelTx(ctx, func(tx *sql.Tx) error {
		var n int
		tx.QueryRow(`SELECT COUNT(1) FROM sessions WHERE id=?`, sessionID).Scan(&n)
		if n == 0 {
			return ErrNotFound
		}
		if err := bindRun(tx, sessionID, item, "manual", now, now); err != nil {
			return err
		}
		return store.Touch(tx, now, "session", "")
	})
	c.notify()
	return err
}

// Unbind 结束 session 当前的 run，结果由人工指定。
func (c *Core) Unbind(ctx context.Context, sessionID int64, outcome string) error {
	switch outcome {
	case "delivered", "failed", "abandoned", "handed_off", "":
	default:
		return fmt.Errorf("%w: 未知结果 %s", ErrBadRequest, outcome)
	}
	now := c.St.NowTS()
	err := c.panelTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`UPDATE runs SET ended_at=?, outcome=? WHERE session_id=? AND ended_at=''`, now, outcome, sessionID); err != nil {
			return err
		}
		return store.Touch(tx, now, "session", "")
	})
	c.notify()
	return err
}

// SetRunOutcome 人工为已结束但结果待定的 run 补记结果。
func (c *Core) SetRunOutcome(ctx context.Context, runID int64, outcome string) error {
	switch outcome {
	case "delivered", "failed", "abandoned", "handed_off":
	default:
		return fmt.Errorf("%w: 未知结果 %s", ErrBadRequest, outcome)
	}
	now := c.St.NowTS()
	err := c.panelTx(ctx, func(tx *sql.Tx) error {
		r, err := tx.Exec(`UPDATE runs SET outcome=?, ended_at=CASE WHEN ended_at='' THEN ? ELSE ended_at END WHERE id=?`, outcome, now, runID)
		if err != nil {
			return err
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return store.Touch(tx, now, "work_item", "")
	})
	c.notify()
	return err
}

func (c *Core) WorkItemExists(ctx context.Context, id string) bool {
	var n int
	c.St.R().QueryRowContext(ctx, `SELECT COUNT(1) FROM work_items WHERE id=?`, id).Scan(&n)
	return n > 0
}
