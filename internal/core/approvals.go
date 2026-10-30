package core

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

// Decision 是面板对一次权限请求的单次决定。
type Decision struct {
	Behavior string `json:"behavior"` // allow | deny
	Message  string `json:"message,omitempty"`
}

var (
	ErrConflict = errors.New("操作与当前状态冲突")
	ErrMismatch = errors.New("请求内容与审批记录不一致")
)

type approvalRow struct {
	kind       string
	sessionID  int64
	workItem   string
	repoID     int64
	fp         string
	tool       string
	preview    string
	handleable bool
	payload    map[string]any
	deadline   string
}

func newID(prefix string) string {
	b := make([]byte, 8)
	rand.Read(b)
	return prefix + "_" + hex.EncodeToString(b)
}

func insertApproval(tx *sql.Tx, a approvalRow, now string) error {
	_, err := insertApprovalID(tx, a, now)
	return err
}

func insertApprovalID(tx *sql.Tx, a approvalRow, now string) (string, error) {
	id := newID(a.kind[:1])
	p, _ := json.Marshal(a.payload)
	if a.payload == nil {
		p = []byte("{}")
	}
	h := 0
	if a.handleable {
		h = 1
	}
	_, err := tx.Exec(`INSERT INTO approvals(id, kind, status, session_id, work_item_id, repo_id, fingerprint, tool_name, preview, handleable, payload, deadline, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		id, a.kind, "pending", nullInt(a.sessionID), nullStr(a.workItem), nullInt(a.repoID), a.fp, a.tool, a.preview, h, string(p), a.deadline, now)
	if err != nil {
		return "", err
	}
	return id, store.Touch(tx, now, "approval", id)
}

// upsertAttention 为同一 session 合并重复的决策/提醒条目。
func upsertAttention(tx *sql.Tx, sid int64, kind, preview string, payload map[string]any, now string) error {
	var id string
	err := tx.QueryRow(`SELECT id FROM approvals WHERE session_id=? AND kind=? AND status='pending'
		AND COALESCE(json_extract(payload,'$.source'),'')<>'native_user_input' LIMIT 1`, sid, kind).Scan(&id)
	if err == nil {
		p, _ := json.Marshal(payload)
		_, err = tx.Exec(`UPDATE approvals SET preview=?, payload=?, created_at=? WHERE id=?`, preview, string(p), now, id)
		if err == nil {
			err = store.Touch(tx, now, "approval", id)
		}
		return err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	// 高置信求助出现时，同 session 的低置信提醒被它取代
	if kind == "decision" {
		tx.Exec(`UPDATE approvals SET status='cancelled', close_reason='superseded', closed_at=? WHERE session_id=? AND kind='attention' AND status='pending'`, now, sid)
	}
	return insertApproval(tx, approvalRow{kind: kind, sessionID: sid, preview: preview, payload: payload}, now)
}

// RequestPermission 由 hook 适配器同步调用：先落库事件，再创建可处理的审批并等待面板决定。
// 返回 ok=false 表示 Steward 不作决定，适配器应回到 Agent 原生审批流程。
func (c *Core) RequestPermission(ctx context.Context, e *event.Event, wait time.Duration) (id string, d Decision, ok bool, err error) {
	if e.Kind != event.KindPermission {
		return "", d, false, errors.New("不是权限请求事件")
	}
	if event.NativeInputTool(e.Source.Provider, e.ToolName) {
		observed := *e
		observed.Kind, observed.Reason = event.KindNotifyInput, "native_user_input"
		_, err = c.Ingest(ctx, &observed)
		return "", d, false, err // old adapters also return to Claude's native UI
	}
	res, err := c.Ingest(ctx, e)
	if err != nil {
		return "", d, false, err
	}
	if res.Duplicate {
		return "", d, false, nil // 重试的同一请求不再等待，交回原生流程
	}
	deadline := c.St.Now().Add(wait)
	now := c.St.NowTS()
	ch := make(chan Decision, 1)
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		execution, err := permissionExecutionFor(tx, res.SessionID, e)
		if err != nil {
			return err
		}
		// 同一 session 之前未处理的观察条目被这次可处理请求取代
		tx.Exec(`UPDATE approvals SET status='cancelled', close_reason='superseded', closed_at=? WHERE kind='permission' AND session_id=? AND handleable=0 AND status='pending'`, now, res.SessionID)
		id, err = insertApprovalID(tx, approvalRow{
			kind: "permission", sessionID: res.SessionID, fp: e.Fingerprint, tool: e.ToolName,
			preview: e.Preview, handleable: true, deadline: store.TS(deadline),
			payload: map[string]any{"event_id": e.EventID, "cwd": e.Cwd, "execution": execution},
		}, now)
		return err
	})
	if err != nil {
		return "", d, false, err
	}
	c.mu.Lock()
	c.waiters[id] = ch
	c.mu.Unlock()
	c.notify()
	defer func() {
		c.mu.Lock()
		delete(c.waiters, id)
		c.mu.Unlock()
	}()

	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case dec := <-ch:
		if dec.Behavior == "" {
			return id, d, false, nil // 哨兵：已被取消（会话中断等）
		}
		return id, dec, true, nil
	case <-timer.C:
		c.closeApproval(context.Background(), id, "expired", "timeout")
	case <-ctx.Done():
		c.closeApproval(context.Background(), id, "expired", "adapter_disconnected")
	}
	return id, d, false, nil
}

// closeApproval 只关闭仍在 pending/decided 的条目。
func (c *Core) closeApproval(ctx context.Context, id, status, reason string) {
	now := c.St.NowTS()
	c.St.Tx(ctx, func(tx *sql.Tx) error {
		r, err := tx.Exec(`UPDATE approvals SET status=?, close_reason=?, closed_at=? WHERE id=? AND status IN ('pending','decided')`, status, reason, now, id)
		if err != nil {
			return err
		}
		if n, _ := r.RowsAffected(); n > 0 {
			return store.Touch(tx, now, "approval", id)
		}
		return nil
	})
	c.notify()
}

// Decide 处理面板上的决定。必须提供 approval id 与面板看到的指纹，二者都匹配且仍在等待中才生效。
func (c *Core) Decide(ctx context.Context, id, fingerprint string, d Decision) error {
	if d.Behavior != "allow" && d.Behavior != "deny" {
		return errors.New("behavior 只能是 allow 或 deny")
	}
	c.mu.Lock()
	ch, waiting := c.waiters[id]
	c.mu.Unlock()
	now := c.St.Now()
	err := c.panelTx(ctx, func(tx *sql.Tx) error {
		var status, fp, deadline, kind string
		var handleable int
		err := tx.QueryRow(`SELECT status, fingerprint, deadline, kind, handleable FROM approvals WHERE id=?`, id).
			Scan(&status, &fp, &deadline, &kind, &handleable)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if kind != "permission" || handleable == 0 {
			return errors.New("该请求只能回原界面处理")
		}
		if fp != fingerprint {
			return ErrMismatch
		}
		if status != "pending" {
			return ErrConflict
		}
		if deadline != "" && store.TS(now) > deadline {
			tx.Exec(`UPDATE approvals SET status='expired', close_reason='timeout', closed_at=? WHERE id=?`, store.TS(now), id)
			store.Touch(tx, store.TS(now), "approval", id)
			return ErrConflict
		}
		if !waiting {
			// 适配器已不在等待（例如服务重启后），这个决定无法送达
			tx.Exec(`UPDATE approvals SET status='expired', close_reason='no_waiter', closed_at=? WHERE id=?`, store.TS(now), id)
			store.Touch(tx, store.TS(now), "approval", id)
			return ErrConflict
		}
		if _, err := tx.Exec(`UPDATE approvals SET status='decided', decision=?, decided_at=? WHERE id=?`, d.Behavior, store.TS(now), id); err != nil {
			return err
		}
		return store.Touch(tx, store.TS(now), "approval", id)
	})
	c.notify()
	if err != nil {
		return err
	}
	select {
	case ch <- d:
	default:
	}
	return nil
}

// AckDelivered 由适配器在把决定写回 Agent 后调用。
func (c *Core) AckDelivered(ctx context.Context, id string) error {
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		r, err := tx.Exec(`UPDATE approvals SET status='delivered', delivered_at=? WHERE id=? AND status='decided'`, now, id)
		if err != nil {
			return err
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return ErrConflict
		}
		if err := reconcileDeliveredPermission(tx, id, now); err != nil {
			return err
		}
		return store.Touch(tx, now, "approval", id)
	})
	c.notify()
	return err
}

// Dismiss 关闭决策/提醒/观察类条目（人工确认已处理或忽略）。
func (c *Core) Dismiss(ctx context.Context, id, reason string) error {
	now := c.St.NowTS()
	err := c.panelTx(ctx, func(tx *sql.Tx) error {
		r, err := tx.Exec(`UPDATE approvals SET status='cancelled', close_reason=?, closed_at=?
			WHERE id=? AND status='pending' AND (kind IN ('decision','attention') OR (kind='permission' AND handleable=0))`, nz(reason, "dismissed"), now, id)
		if err != nil {
			return err
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return ErrConflict
		}
		return store.Touch(tx, now, "approval", id)
	})
	c.notify()
	return err
}

// openPermissionIDsBefore 返回该 session 上在 before 之前创建、仍待处理的可处理权限请求。
func openPermissionIDsBefore(tx *sql.Tx, sid int64, before string) []string {
	rows, err := tx.Query(`SELECT id FROM approvals WHERE kind='permission' AND session_id=? AND handleable=1 AND status='pending' AND created_at <= ?`, sid, before)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	return ids
}

// openPermissionIDsByFingerprint 返回与指纹匹配、在 before 之前创建、仍待处理的可处理权限请求。
func openPermissionIDsByFingerprint(tx *sql.Tx, sid int64, fp, before string) []string {
	rows, err := tx.Query(`SELECT id FROM approvals WHERE kind='permission' AND session_id=? AND handleable=1 AND fingerprint=? AND status='pending' AND created_at <= ?`, sid, fp, before)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		rows.Scan(&id)
		ids = append(ids, id)
	}
	return ids
}

// wakeCancelled 用空决定唤醒等待中的适配器，让它们回到原生流程。
func (c *Core) wakeCancelled(ids []string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, id := range ids {
		if ch, ok := c.waiters[id]; ok {
			select {
			case ch <- Decision{}:
			default:
			}
		}
	}
}
