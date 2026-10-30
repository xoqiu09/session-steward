package core

import (
	"context"
	"fmt"
	"time"

	"github.com/xoqiu09/session-steward/internal/store"
)

// replayWindow：回放某一时刻时，只看这之前多久的事件来判断会话状态。更早就没动静的会话按“已收起”处理。
const replayWindow = 7 * 24 * time.Hour

// SnapshotAt 还原过去某一时刻的快照，供小镇回放。只读：
//   - 工作项：只含当时已创建的，状态取那一刻之前最后一次状态变化；
//   - 运行：只含当时已开始的，那一刻之后才结束的当作还在进行；
//   - 会话：状态由那一刻之前最后一条事件推出，等权限的以当时未关闭的审批为准；
//   - 审批：那一刻已创建、还没关闭的算待处理。
//
// 简报、用量、托管、合并任务等不回放（返回空），界面只用它画小镇。
func (c *Core) SnapshotAt(ctx context.Context, at time.Time) (*Snapshot, error) {
	now := c.St.Now()
	if at.After(now) {
		return nil, fmt.Errorf("%w: 回放时间不能晚于现在", ErrBadRequest)
	}
	live, err := c.Snapshot(ctx)
	if err != nil {
		return nil, err
	}
	T := store.TS(at)
	snap := &Snapshot{Cursor: live.Cursor, Now: T, ReplayAt: T, Repos: live.Repos, Deps: live.Deps, Agents: live.Agents, AgentInfo: live.AgentInfo}
	r := c.St.R()

	// 工作项状态
	statusAt := map[string]string{}
	firstAfter := map[string]string{}
	rows, err := r.QueryContext(ctx, `SELECT work_item_id, old_status, status, at FROM work_item_state_changes ORDER BY at, id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, from, to, when string
		if err := rows.Scan(&id, &from, &to, &when); err != nil {
			rows.Close()
			return nil, err
		}
		if when <= T {
			statusAt[id] = to
		} else if _, ok := firstAfter[id]; !ok {
			firstAfter[id] = from
		}
	}
	rows.Close()
	for _, w := range live.WorkItems {
		if w.CreatedAt > T {
			continue
		}
		if s, ok := statusAt[w.ID]; ok {
			w.Status = s
		} else if s, ok := firstAfter[w.ID]; ok {
			w.Status = s
		}
		w.Brief, w.Agents, w.Ready, w.Waiting = nil, nil, true, nil
		w.Signal = nil // 回放不得带入现在的信号时间。
		w.AutomaticHistory = w.AutomaticHistory && w.Status == "done"
		snap.WorkItems = append(snap.WorkItems, w)
	}

	// 运行
	activeRun := map[int64]Run{}
	for _, run := range live.Runs {
		if run.StartedAt > T {
			continue
		}
		if run.EndedAt != "" && run.EndedAt > T {
			run.EndedAt, run.Outcome = "", ""
		}
		snap.Runs = append(snap.Runs, run)
		if run.EndedAt == "" {
			if cur, ok := activeRun[run.SessionID]; !ok || run.StartedAt > cur.StartedAt {
				activeRun[run.SessionID] = run
			}
		}
	}

	// 审批：那一刻已创建、尚未关闭的算待处理
	rows, err = r.QueryContext(ctx, `SELECT `+approvalColumns+` FROM approvals WHERE created_at <= ? AND created_at >= ? AND (closed_at='' OR closed_at > ?) ORDER BY created_at DESC LIMIT 500`,
		T, store.TS(at.Add(-replayWindow)), T)
	if err != nil {
		return nil, err
	}
	pendingPerm := map[int64]bool{}
	for _, a := range readApprovals(rows) {
		a.Status, a.Decision, a.DecidedAt, a.DeliveredAt, a.ConfirmedAt, a.ClosedAt, a.CloseReason = "pending", "", "", "", "", "", ""
		if a.Kind == "permission" && a.SessionID != nil {
			pendingPerm[*a.SessionID] = true
		}
		snap.Approvals = append(snap.Approvals, a)
	}
	rows.Close()

	// 会话：那一刻之前最后一条事件
	type last struct{ kind, at string }
	lastEv := map[int64]last{}
	rows, err = r.QueryContext(ctx, `SELECT session_id, kind, MAX(occurred_at) FROM events WHERE occurred_at <= ? AND occurred_at >= ? AND session_id IS NOT NULL AND kind<>'user_action' GROUP BY session_id`,
		T, store.TS(at.Add(-replayWindow)))
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		var kind, when string
		if err := rows.Scan(&id, &kind, &when); err != nil {
			rows.Close()
			return nil, err
		}
		lastEv[id] = last{kind, when}
	}
	rows.Close()
	stale := c.StaleAfter
	if stale <= 0 {
		stale = 15 * time.Minute
	}
	for _, s := range live.Sessions {
		e, ok := lastEv[s.ID]
		if !ok || s.FirstSeenAt > T {
			continue
		}
		s.LastActivityAt, s.LastProgressAt, s.LastToolPreview, s.LastToolAt = e.at, "", "", ""
		s.Signal = nil // 信号回放不在本期范围，避免用未来信号解释过去。
		s.DataSource, s.Freshness, s.StateReason = "live", "live", ""
		switch e.kind {
		case "session_end":
			s.State = "ended"
		case "stop":
			s.State = "idle"
		case "stop_failure":
			s.State = "error"
		case "interrupt":
			s.State = "interrupted"
		default:
			s.State = "running"
		}
		if pendingPerm[s.ID] {
			s.State = "waiting_permission"
		}
		if t, err := time.Parse(time.RFC3339Nano, e.at); err == nil && s.State == "running" && at.Sub(t) > stale {
			s.Freshness = "stale"
		}
		if run, ok := activeRun[s.ID]; ok {
			s.WorkItemID, s.Binding = run.WorkItemID, run.Binding
		} else {
			s.WorkItemID, s.Binding = "", ""
		}
		snap.Sessions = append(snap.Sessions, s)
	}
	return snap, nil
}

// ReplayParse 解析 ?at=：RFC3339 时间。
func ReplayParse(v string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: at 应为 RFC3339 时间", ErrBadRequest)
	}
	return t, nil
}
