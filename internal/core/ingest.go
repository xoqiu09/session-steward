package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

// IngestResult 告诉调用方事件是否为新事件。
type IngestResult struct {
	Duplicate  bool   `json:"duplicate"`
	SessionID  int64  `json:"session_id"`
	WorkItemID string `json:"work_item_id,omitempty"`
}

// sessionStateFor 把事件类型映射到 session 状态。返回空串表示不改变状态。
func sessionStateFor(k event.Kind) string {
	switch k {
	case event.KindSessionStart, event.KindPrompt, event.KindToolPre, event.KindToolPost,
		event.KindToolFail, event.KindSubagentOn, event.KindSubagentOff, event.KindCompact:
		return "running"
	case event.KindPermission, event.KindNotifyPerm:
		return "waiting_permission"
	case event.KindStop, event.KindNotifyIdle:
		return "idle"
	case event.KindNotifyInput:
		return "idle"
	case event.KindStopFailure:
		return "error"
	case event.KindInterrupt:
		return "interrupted"
	case event.KindSessionEnd:
		return "ended"
	}
	return ""
}

// Ingest 幂等地处理一条事件：去重、更新 session、归属、生成关注项。
func (c *Core) Ingest(ctx context.Context, e *event.Event) (IngestResult, error) {
	if err := e.Validate(); err != nil {
		return IngestResult{}, fmt.Errorf("%w: %v", ErrBadRequest, err)
	}
	if e.Features != nil {
		e.Features.Redact()
	}
	if e.Source.HostID == "" {
		e.Source.HostID = "local"
	}
	if e.Source.Provider == "codex" {
		if e.Source.Originator == "" {
			e.Source.Originator = e.Source.Client
		}
		e.Source.Client = event.CodexClient(e.Source.Originator)
	}
	// Git 定位放在事务外，避免持锁执行外部命令
	var loc *locInfo
	if e.Cwd != "" && c.Loc != nil {
		l := c.Loc.Locate(ctx, e.Cwd)
		loc = &locInfo{l.IsGit, l.CommonDir, l.Worktree, l.Branch, l.RepoName}
		if e.Branch == "" {
			e.Branch = l.Branch
		}
	}
	var project *locInfo
	if e.Kind == event.KindBegin {
		project = loc
		if e.ProjectPath != "" {
			info, err := os.Stat(e.ProjectPath)
			if err != nil || !info.IsDir() || c.Loc == nil {
				return IngestResult{}, fmt.Errorf("%w: 项目目录不存在", ErrBadRequest)
			}
			l := c.Loc.Locate(ctx, e.ProjectPath)
			project = &locInfo{l.IsGit, l.CommonDir, l.Worktree, l.Branch, l.RepoName}
		}
		if project == nil || (!project.isGit && e.ProjectPath == "") {
			return IngestResult{}, fmt.Errorf("%w: 项目不明确，请用 --project 指定实际项目目录", ErrBadRequest)
		}
	}
	now := c.St.NowTS()
	e.ReceivedAt = c.St.Now().UTC()
	var res IngestResult
	var cancelled []string
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		var exists int
		if err := tx.QueryRow(`SELECT COUNT(1) FROM events WHERE event_id=?`, e.EventID).Scan(&exists); err != nil {
			return err
		}
		if exists > 0 {
			res.Duplicate = true
			return nil
		}
		sid, err := c.upsertSession(tx, e, loc, now)
		if err != nil {
			return err
		}
		res.SessionID = sid
		if err := attachManaged(tx, sid, loc, store.TS(e.OccurredAt), now); err != nil {
			return err
		}
		if e.Kind == event.KindBegin {
			item, err := c.beginWork(tx, sid, e, project, now)
			if err != nil {
				return err
			}
			res.WorkItemID = item
		}
		body, _ := json.Marshal(e)
		if _, err := tx.Exec(`INSERT INTO events(event_id, session_id, kind, occurred_at, received_at, body) VALUES (?,?,?,?,?,?)`,
			e.EventID, sid, string(e.Kind), store.TS(e.OccurredAt), now, string(body)); err != nil {
			return err
		}
		if err := c.applyEvent(tx, sid, e, now, &cancelled); err != nil {
			return err
		}
		return store.Touch(tx, now, "session", e.SessionID)
	})
	if err == nil && !res.Duplicate {
		c.wakeCancelled(cancelled)
		c.notify()
	}
	return res, err
}

type locInfo struct {
	isGit     bool
	commonDir string
	worktree  string
	branch    string
	repoName  string
}

func ensureRepo(tx *sql.Tx, l *locInfo, now string) (int64, error) {
	var id int64
	l.commonDir = canonicalIdentity(l.commonDir)
	if err := tx.QueryRow(`SELECT repo_id FROM repo_identities WHERE identity=?`, l.commonDir).Scan(&id); err == nil {
		return canonicalRepo(tx, id)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	err := tx.QueryRow(`SELECT id FROM repos WHERE common_dir=?`, l.commonDir).Scan(&id)
	if err == nil {
		return canonicalRepo(tx, id)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	if l.isGit && l.worktree != "" {
		old := "dir:" + canonicalPath(l.worktree)
		if err = tx.QueryRow(`SELECT id FROM repos WHERE common_dir=? AND is_git=0`, old).Scan(&id); err == nil {
			id, err = canonicalRepo(tx, id)
			if err != nil {
				return 0, err
			}
			if _, err = tx.Exec(`INSERT INTO repo_identities(identity,repo_id) VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET repo_id=excluded.repo_id`, old, id); err != nil {
				return 0, err
			}
			_, err = tx.Exec(`UPDATE repos SET common_dir=?,is_git=1,name=? WHERE id=?`, l.commonDir, l.repoName, id)
			return id, err
		} else if !errors.Is(err, sql.ErrNoRows) {
			return 0, err
		}
	} else if strings.HasPrefix(l.commonDir, "dir:") {
		gitDir := strings.TrimPrefix(l.commonDir, "dir:") + "/.git"
		if err = tx.QueryRow(`SELECT id FROM repos WHERE common_dir=? AND is_git=1`, gitDir).Scan(&id); err == nil {
			return canonicalRepo(tx, id)
		} else if !errors.Is(err, sql.ErrNoRows) {
			return 0, err
		}
	}
	isGit := 0
	if l.isGit {
		isGit = 1
	}
	r, err := tx.Exec(`INSERT INTO repos(common_dir, name, is_git, created_at) VALUES (?,?,?,?)`, l.commonDir, l.repoName, isGit, now)
	if err != nil {
		return 0, err
	}
	return r.LastInsertId()
}

func (c *Core) upsertSession(tx *sql.Tx, e *event.Event, l *locInfo, now string) (int64, error) {
	var repoID int64
	if l != nil {
		var err error
		if repoID, err = ensureRepo(tx, l, now); err != nil {
			return 0, err
		}
	}
	var id int64
	var dataSource string
	err := tx.QueryRow(`SELECT id, data_source FROM sessions WHERE host_id=? AND provider=? AND provider_session_id=?`,
		e.Source.HostID, e.Source.Provider, e.SessionID).Scan(&id, &dataSource)
	if errors.Is(err, sql.ErrNoRows) {
		wt, br := "", e.Branch
		if l != nil {
			wt = l.worktree
		}
		r, err := tx.Exec(`INSERT INTO sessions(host_id, provider, provider_session_id, client, version, cwd, worktree, branch, repo_id, first_seen_at, data_source)
			VALUES (?,?,?,?,?,?,?,?,?,?,'live')`,
			e.Source.HostID, e.Source.Provider, e.SessionID, nz(e.Source.Client, "unknown"), e.Source.Version,
			e.Cwd, wt, br, nullInt(repoID), store.TS(e.OccurredAt))
		if err != nil {
			return 0, err
		}
		return r.LastInsertId()
	}
	if err != nil {
		return 0, err
	}
	// 已存在：补全客户端信息，更新位置。实时事件把“仅历史发现”升级为实时。
	q := `UPDATE sessions SET data_source='live',
		client = CASE WHEN ? NOT IN ('', 'unknown') THEN ? ELSE client END,
		version = CASE WHEN ? <> '' THEN ? ELSE version END`
	args := []any{e.Source.Client, e.Source.Client, e.Source.Version, e.Source.Version}
	if e.Cwd != "" && l != nil {
		q += `, cwd=?, worktree=?, branch=?, repo_id=?`
		args = append(args, e.Cwd, l.worktree, e.Branch, nullInt(repoID))
	}
	q += ` WHERE id=?`
	args = append(args, id)
	_, err = tx.Exec(q, args...)
	return id, err
}

func (c *Core) applyEvent(tx *sql.Tx, sid int64, e *event.Event, now string, cancelled *[]string) error {
	occ := store.TS(e.OccurredAt)
	// 1. session 状态：只有比当前状态更新的事件才能改变状态（乱序保护）
	if st := sessionStateFor(e.Kind); st != "" {
		reason := e.Reason
		if e.Kind == event.KindStop && e.EndsWithAsk {
			reason = "ended_with_question"
		}
		if _, err := tx.Exec(`UPDATE sessions SET state=?, state_reason=?, state_at=? WHERE id=? AND state_at <= ?
			AND NOT (state='ended' AND ?<>'session_start')`,
			st, reason, occ, sid, occ, string(e.Kind)); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE sessions SET last_activity_at=? WHERE id=? AND last_activity_at < ?`, occ, sid, occ); err != nil {
		return err
	}

	// 2. 归属
	if err := c.attribute(tx, sid, e, now); err != nil {
		return err
	}

	// 3. 关注项
	switch e.Kind {
	case event.KindToolPre:
		if event.NativeInputTool(e.Source.Provider, e.ToolName) {
			if err := upsertNativeInput(tx, sid, e, now); err != nil {
				return err
			}
		}
	case event.KindToolPost, event.KindToolFail:
		ids, err := permissionsCompletedBy(tx, sid, e, now)
		if err != nil {
			return err
		}
		*cancelled = append(*cancelled, ids...)
		if event.NativeInputTool(e.Source.Provider, e.ToolName) {
			if err := closeNativeInput(tx, sid, e, now); err != nil {
				return err
			}
		}
		// 观察类的权限条目（未经面板处理）在工具继续执行后关闭
		if _, err := tx.Exec(`UPDATE approvals SET status='cancelled', close_reason='resolved_elsewhere', closed_at=?
			WHERE kind='permission' AND handleable=0 AND session_id=? AND status='pending'`, now, sid); err != nil {
			return err
		}
	case event.KindNotifyPerm:
		// 面板无法处理的权限提示（例如未经过 PermissionRequest 的请求）：只做观察条目
		var open int
		tx.QueryRow(`SELECT COUNT(1) FROM approvals WHERE kind='permission' AND session_id=? AND status IN ('pending','decided')`, sid).Scan(&open)
		if open == 0 {
			if err := insertApproval(tx, approvalRow{kind: "permission", sessionID: sid, preview: e.Preview, handleable: false,
				payload: map[string]any{"notification": e.Reason}}, now); err != nil {
				return err
			}
		}
	case event.KindNotifyInput:
		if event.NativeInputTool(e.Source.Provider, e.ToolName) {
			return upsertNativeInput(tx, sid, e, now)
		}
		var native int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM approvals WHERE session_id=? AND kind='decision'
			AND status='pending' AND json_extract(payload,'$.source')='native_user_input'`, sid).Scan(&native); err != nil {
			return err
		}
		if native > 0 {
			break // notification must not overwrite a call-scoped native question
		}
		if err := upsertAttention(tx, sid, "decision", nz(e.Preview, "Agent 请求输入"), map[string]any{"source": e.Reason, "confidence": "high"}, now); err != nil {
			return err
		}
	case event.KindAsk:
		if err := upsertAttention(tx, sid, "decision", nz(e.Text, "Agent 请求帮助"), map[string]any{"source": "steward-hook ask", "confidence": "high"}, now); err != nil {
			return err
		}
	case event.KindStop:
		if e.EndsWithAsk {
			if err := upsertAttention(tx, sid, "attention", nz(e.Text, "最后一条回复以问句结尾"), map[string]any{"confidence": "low"}, now); err != nil {
				return err
			}
		}
	case event.KindPrompt:
		// 用户回到该会话输入，低置信提醒自动关闭
		if _, err := tx.Exec(`UPDATE approvals SET status='cancelled', close_reason='user_replied', closed_at=?
			WHERE session_id=? AND kind IN ('attention','decision') AND status='pending'`, now, sid); err != nil {
			return err
		}
	case event.KindDeliver:
		if err := c.deliver(tx, sid, e, now); err != nil {
			return err
		}
	}
	if err := c.applyAgentBrief(tx, sid, e, now); err != nil {
		return err
	}
	if e.Kind == event.KindFeatures {
		if err := c.applyFeatures(tx, sid, e, now); err != nil {
			return err
		}
	}

	// 4. 会话中断或结束：等待中的权限请求失效；run 结束但结果待定
	switch e.Kind {
	case event.KindInterrupt, event.KindSessionEnd, event.KindStopFailure:
		// Stop 只是一轮回复结束，不作为失效条件。
		// 只取消在该事件发生之前创建、仍待处理的请求；迟到的旧事件不能取消更新的请求。
		ids := openPermissionIDsBefore(tx, sid, occ)
		if _, err := tx.Exec(`UPDATE approvals SET status='cancelled', close_reason=?, closed_at=?
			WHERE kind='permission' AND session_id=? AND status='pending' AND created_at <= ?`, "session_"+string(e.Kind), now, sid, occ); err != nil {
			return err
		}
		*cancelled = append(*cancelled, ids...)
	}
	if e.Kind == event.KindSessionEnd {
		if _, err := tx.Exec(`UPDATE runs SET ended_at=? WHERE session_id=? AND ended_at=''`, occ, sid); err != nil {
			return err
		}
	}
	return nil
}

func (c *Core) deliver(tx *sql.Tx, sid int64, e *event.Event, now string) error {
	item, err := itemForSessionAt(tx, sid, store.TS(e.OccurredAt))
	if err != nil || item == "" {
		return err
	}
	var reopened string
	if err := tx.QueryRow(`SELECT COALESCE(MAX(at),'') FROM brief_entries WHERE work_item_id=? AND field='stage' AND source='reopened'`, item).Scan(&reopened); err != nil {
		return err
	}
	if reopened != "" && store.TS(e.OccurredAt) < reopened {
		return nil // 上一轮离线交付不能把重新开始的工作送回待验收。
	}
	if _, err := tx.Exec(`UPDATE work_items SET status='review', updated_at=? WHERE id=? AND status IN ('todo','in_progress','blocked')`, now, item); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE sessions SET last_progress_at=? WHERE id=?`, store.TS(e.OccurredAt), sid); err != nil {
		return err
	}
	return store.Touch(tx, now, "work_item", item)
}

func nz(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}

// ResolveSession 为 Agent 主动调用（claim/ask/deliver）找到所属会话：
// 优先使用显式 session id；否则取 cwd 所在 worktree 中最近活跃的唯一实时会话。
func (c *Core) ResolveSession(ctx context.Context, hostID, provider, sessionID, cwd string) (prov, sid string, err error) {
	db := c.St.R()
	if sessionID != "" {
		q := `SELECT provider, provider_session_id FROM sessions WHERE host_id=? AND provider_session_id=?`
		args := []any{hostID, sessionID}
		if provider != "" && provider != "other" {
			q += ` AND provider=?`
			args = append(args, provider)
		}
		err = db.QueryRowContext(ctx, q+` LIMIT 1`, args...).Scan(&prov, &sid)
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("%w: 找不到会话 %s", ErrNotFound, sessionID)
		}
		return
	}
	wt := cwd
	if c.Loc != nil && cwd != "" {
		wt = c.Loc.Locate(ctx, cwd).Worktree
	}
	since := c.St.Now().Add(-c.StaleAfter).UTC().Format("2006-01-02T15:04:05.000000000Z")
	rows, err := db.QueryContext(ctx, `SELECT provider, provider_session_id FROM sessions
		WHERE host_id=? AND data_source='live' AND state NOT IN ('ended') AND (worktree=? OR cwd=?) AND last_activity_at >= ?
		ORDER BY last_activity_at DESC`, hostID, wt, cwd, since)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	var list [][2]string
	for rows.Next() {
		var p, s string
		rows.Scan(&p, &s)
		if provider == "" || provider == "other" || provider == p {
			list = append(list, [2]string{p, s})
		}
	}
	switch len(list) {
	case 0:
		return "", "", fmt.Errorf("%w: 当前目录没有活跃会话，请用 --session 指定", ErrNotFound)
	case 1:
		return list[0][0], list[0][1], nil
	}
	return "", "", fmt.Errorf("%w: 当前目录有 %d 个活跃会话，请用 --session 指定", ErrConflict, len(list))
}
