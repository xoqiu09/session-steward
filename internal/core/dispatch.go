package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"

	"github.com/xoqiu09/session-steward/internal/store"
)

// 派活台的数据：任务就是 runner=codex_app 的托管会话，状态、幂等键和审计都在托管表里，不另建任务库。

type DispatchProject struct {
	RepoID  int64  `json:"repo_id"`
	Name    string `json:"name"`
	AddedAt string `json:"added_at"`
}

// DispatchProjects 列出可派活的项目（只在 Studio 本机添加）。
func (c *Core) DispatchProjects(ctx context.Context) ([]DispatchProject, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT d.repo_id,r.name,d.added_at FROM dispatch_projects d JOIN repos r ON r.id=d.repo_id ORDER BY r.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DispatchProject{}
	for rows.Next() {
		var p DispatchProject
		if err := rows.Scan(&p.RepoID, &p.Name, &p.AddedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SetDispatchProject 添加或移除可派活的项目。只接受仍在本机的 Git 项目；移除不影响已开始的任务。
func (c *Core) SetDispatchProject(ctx context.Context, repoID int64, allowed bool) error {
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		id, err := canonicalRepo(tx, repoID)
		if err != nil {
			return err
		}
		if !allowed {
			_, err = tx.Exec(`DELETE FROM dispatch_projects WHERE repo_id=?`, id)
			return err
		}
		var common string
		var isGit bool
		err = tx.QueryRow(`SELECT common_dir,is_git FROM repos WHERE id=?`, id).Scan(&common, &isGit)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if !isGit {
			return fmt.Errorf("%w: 派活需要 Git 项目（每件任务一个 worktree）", ErrBadRequest)
		}
		if _, err := os.Stat(common); err != nil {
			return fmt.Errorf("%w: 这个项目的目录在本机不可用", ErrBadRequest)
		}
		_, err = tx.Exec(`INSERT INTO dispatch_projects(repo_id,added_at) VALUES(?,?) ON CONFLICT(repo_id) DO NOTHING`, id, c.St.NowTS())
		return err
	})
}

// LaunchDispatch 在授权项目里为一件任务新建分支、worktree、工作项和托管记录，并在同一事务里记下幂等键。
// 只建好位置，不启动 Codex；客户端只能给项目和标题，不能指定目录、命令或模型。
func (c *Core) LaunchDispatch(ctx context.Context, repoID int64, title, op string) (*ManagedSession, error) {
	var allowed int
	if err := c.St.R().QueryRowContext(ctx, `SELECT COUNT(1) FROM dispatch_projects WHERE repo_id=?`, repoID).Scan(&allowed); err != nil {
		return nil, err
	}
	if allowed == 0 {
		return nil, fmt.Errorf("%w: 这个项目还没有加入可派活的项目", ErrForbidden)
	}
	return c.launch(ctx, LaunchInput{RepoID: repoID, Title: title}, launchOpts{native: true, inTx: func(tx *sql.Tx, m *ManagedSession, now string) error {
		_, err := tx.Exec(`INSERT INTO dispatch_ops(managed_id,op,created_at) VALUES(?,?,?)`, m.ID, op, now)
		return err
	}})
}

type DispatchRow struct {
	ID         string            `json:"id"`
	RepoID     int64             `json:"repo_id"`
	RepoName   string            `json:"repo_name"`
	Title      string            `json:"title"`
	WorkItemID string            `json:"work_item_id"`
	Worktree   string            `json:"worktree"`
	Branch     string            `json:"branch"`
	Thread     string            `json:"thread_id"`
	Turn       string            `json:"turn_id"`
	Status     string            `json:"status"`
	Error      string            `json:"last_error,omitempty"`
	CreatedAt  string            `json:"created_at"`
	Ops        map[string]string `json:"-"`
}

// DispatchRows 读出所有未归档的派活任务及其幂等键，供服务启动时恢复。
func (c *Core) DispatchRows(ctx context.Context) ([]DispatchRow, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT m.id,m.repo_id,COALESCE(r.name,''),m.title,m.work_item_id,m.worktree,m.branch,m.native_thread,m.native_turn,m.native_status,m.error,m.created_at
		FROM managed_sessions m LEFT JOIN repos r ON r.id=m.repo_id WHERE m.runner='codex_app' AND m.state<>'archived' ORDER BY m.created_at`)
	if err != nil {
		return nil, err
	}
	var out []DispatchRow
	for rows.Next() {
		d := DispatchRow{Ops: map[string]string{}}
		if err := rows.Scan(&d.ID, &d.RepoID, &d.RepoName, &d.Title, &d.WorkItemID, &d.Worktree, &d.Branch, &d.Thread, &d.Turn, &d.Status, &d.Error, &d.CreatedAt); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, d)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		ops, err := c.St.R().QueryContext(ctx, `SELECT op,turn FROM dispatch_ops WHERE managed_id=?`, out[i].ID)
		if err != nil {
			return nil, err
		}
		for ops.Next() {
			var op, turn string
			if err := ops.Scan(&op, &turn); err != nil {
				ops.Close()
				return nil, err
			}
			out[i].Ops[op] = turn
		}
		ops.Close()
	}
	return out, nil
}

// SaveDispatch 写回任务的原生会话号、当前轮次和运行状态。只改派活任务的行。
func (c *Core) SaveDispatch(ctx context.Context, id, thread, turn, status, lastError string) error {
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		now := c.St.NowTS()
		res, err := tx.Exec(`UPDATE managed_sessions SET native_thread=?, native_turn=?, native_status=?, error=?, updated_at=? WHERE id=? AND runner='codex_app'`, thread, turn, status, lastError, now, id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return ErrNotFound
		}
		return store.Touch(tx, now, "managed", id)
	})
	if err == nil {
		c.notify()
	}
	return err
}

// SetDispatchOp 记下或更新一个幂等键对应的原生轮次。
func (c *Core) SetDispatchOp(ctx context.Context, id, op, turn string) error {
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO dispatch_ops(managed_id,op,turn,created_at) VALUES(?,?,?,?) ON CONFLICT(managed_id,op) DO UPDATE SET turn=excluded.turn`, id, op, turn, c.St.NowTS())
		return err
	})
}

// DispatchOpOwner 返回已受理这个幂等键的任务；没有则为空。
func (c *Core) DispatchOpOwner(ctx context.Context, op string) (string, error) {
	var id string
	err := c.St.R().QueryRowContext(ctx, `SELECT managed_id FROM dispatch_ops WHERE op=? LIMIT 1`, op).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

// DispatchAudit 记一条派活审计：哪台设备、什么动作、结果。不记任务文字和命令，只记长度。
func (c *Core) DispatchAudit(ctx context.Context, id, action, detail, actor, device string) error {
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO managed_audit(managed_id,action,detail,actor,at,device) VALUES(?,?,?,?,?,?)`, id, action, detail, actor, c.St.NowTS(), device)
		return err
	})
}

// DispatchEvents 返回任务最近的审计，新的在前。
func (c *Core) DispatchEvents(ctx context.Context, id string, limit int) ([]ManagedAuditEntry, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT action,detail,actor,at,device FROM managed_audit WHERE managed_id=? ORDER BY id DESC LIMIT ?`, id, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ManagedAuditEntry{}
	for rows.Next() {
		var a ManagedAuditEntry
		if err := rows.Scan(&a.Action, &a.Detail, &a.Actor, &a.At, &a.Device); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DispatchMark 给小镇用：哪些工作项是派活台发起的、现在大致什么状态。不含任务文字。
type DispatchMark struct {
	ManagedID  string `json:"managed_id"`
	WorkItemID string `json:"work_item_id"`
	RepoID     int64  `json:"repo_id"`
	Status     string `json:"status"`
}

func readDispatchMarks(tx *sql.Tx) ([]DispatchMark, error) {
	rows, err := tx.Query(`SELECT id,work_item_id,repo_id,native_status FROM managed_sessions WHERE runner='codex_app' AND state<>'archived' ORDER BY created_at DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DispatchMark{}
	for rows.Next() {
		var m DispatchMark
		if err := rows.Scan(&m.ManagedID, &m.WorkItemID, &m.RepoID, &m.Status); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// DeleteDispatchOp 撤掉一个还没执行的幂等键（连 Codex 都没连上），同一个键可以再交一次。
func (c *Core) DeleteDispatchOp(ctx context.Context, id, op string) error {
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`DELETE FROM dispatch_ops WHERE managed_id=? AND op=? AND turn=''`, id, op)
		return err
	})
}
