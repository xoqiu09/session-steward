package core

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

// checkOrchestration only inspects facts and writes its own findings. No execution or model port.
func (c *Core) checkOrchestration(ctx context.Context) error {
	v, err := c.OrchestrationView(ctx)
	if err != nil {
		return err
	}
	snap, err := c.Snapshot(ctx)
	if err != nil {
		return err
	}
	desired := map[string]OrchestrationFinding{}
	valid := map[string]bool{}
	recoverable := map[string]bool{}
	currentCandidates := map[string]string{}
	add := func(item, rule, scope, fact, basis string) {
		id := orchHash(item + "\x00" + rule + "\x00" + scope)
		desired[id] = OrchestrationFinding{ID: id, WorkItemID: item, Rule: rule, Scope: scope, Fact: fact, Basis: basis}
	}
	for _, d := range v.Deliveries {
		if d.State == "uncertain" {
			add(d.WorkItemID, "delivery_unknown", d.ID, "一条任务输入的执行结果不明，请核对原会话；不会自动重复发送。", d.ID)
		}
	}
	for _, m := range v.Mandates {
		_, reason, e := c.orchEligibility(ctx, m.WorkItemID, m.Revision)
		if e != nil {
			continue
		}
		if reason != "" {
			continue
		}
		valid[m.WorkItemID] = true
		created, e := time.Parse(time.RFC3339Nano, m.CreatedAt)
		if e != nil {
			return e
		}
		a, e := c.orchAssignment(ctx, m.WorkItemID)
		if e == sql.ErrNoRows {
			if c.St.Now().Sub(created) >= 2*time.Minute && c.OrchExecutor != nil {
				add(m.WorkItemID, "unassigned", m.Revision, "依赖和授权已满足，但尚无有效执行负责人，请核对派活原因。", m.Revision)
			}
		} else if e == nil {
			recoverable[orchHash(m.WorkItemID+"\x00unassigned\x00"+m.Revision)] = true
			var thread, status string
			if e = c.St.R().QueryRowContext(ctx, `SELECT native_thread,native_status FROM managed_sessions WHERE id=?`, a.ManagedID).Scan(&thread, &status); e != nil {
				return e
			}
			if status == "uncertain" || status == "needs_reconcile" {
				add(m.WorkItemID, "execution_unknown", m.Revision, "这一轮是否执行尚待核对，不会自动重跑。", a.ManagedID)
			} else if status == "idle" {
				recoverable[orchHash(m.WorkItemID+"\x00execution_unknown\x00"+m.Revision)] = true
			}
			candidate := c.ManagedCandidate(ctx, a.ManagedID)
			currentCandidates[m.WorkItemID] = candidate
			var count int
			var failedAt string
			// Only failures from this worker, after its grant and within one tool category.
			e = c.St.R().QueryRowContext(ctx, `SELECT count(*),COALESCE(MAX(e.occurred_at),'') FROM events e JOIN sessions s ON s.id=e.session_id WHERE s.provider='codex' AND s.provider_session_id=? AND s.host_id=? AND e.kind='tool_fail' AND json_extract(e.body,'$.candidate')=? AND json_extract(e.body,'$.reason')='nonzero_exit' AND e.occurred_at>=? AND e.occurred_at>=?`, thread, a.HostID, candidate, m.CreatedAt, c.St.Now().Add(-10*time.Minute).UTC().Format("2006-01-02T15:04:05.000000000Z")).Scan(&count, &failedAt)
			if e != nil {
				return e
			}
			// Different tool names are not counted as the same failure.
			var same int
			e = c.St.R().QueryRowContext(ctx, `SELECT COALESCE(MAX(n),0) FROM (SELECT count(*) n FROM events e JOIN sessions s ON s.id=e.session_id WHERE s.provider='codex' AND s.provider_session_id=? AND s.host_id=? AND e.kind='tool_fail' AND json_extract(e.body,'$.candidate')=? AND json_extract(e.body,'$.reason')='nonzero_exit' AND e.occurred_at>=? AND e.occurred_at>=? GROUP BY json_extract(e.body,'$.tool_name'))`, thread, a.HostID, candidate, m.CreatedAt, c.St.Now().Add(-10*time.Minute).UTC().Format("2006-01-02T15:04:05.000000000Z")).Scan(&same)
			if e != nil {
				return e
			}
			if candidate != "" && count >= 3 && same >= 3 {
				add(m.WorkItemID, "repeated_failure", candidate, "同一干净候选的执行工具多次报告非零退出；请核对失败证据，不能据此断定根因相同。", a.ManagedID+"@"+candidate+"@"+failedAt)
			}
			// A long-running tool or an approval is not evidence of a stalled model.
			if status == "running" {
				var last string
				var openTools int
				e = c.St.R().QueryRowContext(ctx, `SELECT COALESCE(MAX(e.occurred_at),'') FROM events e JOIN sessions s ON s.id=e.session_id WHERE s.provider='codex' AND s.provider_session_id=? AND s.host_id=? AND e.kind IN ('tool_post','tool_fail')`, thread, a.HostID).Scan(&last)
				if e != nil {
					return e
				}
				e = c.St.R().QueryRowContext(ctx, `SELECT count(*) FROM events e JOIN sessions s ON s.id=e.session_id WHERE s.provider='codex' AND s.provider_session_id=? AND s.host_id=? AND e.kind='tool_pre' AND NOT EXISTS(SELECT 1 FROM events p WHERE p.session_id=e.session_id AND p.kind IN ('tool_post','tool_fail') AND json_extract(p.body,'$.tool_use_id')=json_extract(e.body,'$.tool_use_id') AND p.occurred_at>=e.occurred_at)`, thread, a.HostID).Scan(&openTools)
				if e != nil {
					return e
				}
				t := created
				if last != "" {
					if parsed, e := time.Parse(time.RFC3339Nano, last); e == nil {
						t = parsed
					}
				}
				if openTools == 0 && c.St.Now().Sub(t) >= 15*time.Minute {
					add(m.WorkItemID, "progress_evidence_gap", m.Revision, "执行中缺少可回查的产物进展，请核对；当前材料不能证明卡死或跑偏。", a.ManagedID+"@"+last)
				} else if last != "" {
					recoverable[orchHash(m.WorkItemID+"\x00progress_evidence_gap\x00"+m.Revision)] = true
				}
			}
		} else {
			return e
		}
		for _, d := range v.Deliveries {
			if d.WorkItemID != m.WorkItemID || d.Revision != m.Revision {
				continue
			}
			switch d.State {
			case "uncertain":
				add(m.WorkItemID, "delivery_unknown", d.ID, "一条任务输入的执行结果不明，请核对原会话；不会自动重复发送。", d.ID)
			case "held":
				if strings.HasPrefix(d.Reason, "route_") {
					add(m.WorkItemID, "event_returned", d.ID, "原负责人退回了一条输入：归属、范围或依据需要核对，不会重复派回。", d.ID+":"+d.Reason)
				}
				if d.Reason == "turn_budget" || d.Reason == "retry_exhausted" || d.Reason == "input_expired" {
					add(m.WorkItemID, "delivery_held", d.ID, "后续输入因预算、重试上限或保存期限停止，请核对后决定下一步。", d.ID+":"+d.Reason)
				}
			}
		}
		for _, f := range snap.Features {
			for _, item := range f.WorkItemIDs {
				if item == m.WorkItemID && f.Conflict && f.Candidate != "" {
					add(item, "candidate_conflict", f.ID+":"+f.Candidate, "同一候选的核心功能回报存在冲突，请核对各来源的验证证据。", f.ID+":"+f.Candidate)
				}
			}
		}
	}
	now := c.St.NowTS()
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		for _, f := range desired {
			_, e := tx.Exec(`INSERT INTO orchestration_findings(id,work_item_id,rule,scope,fact,basis,opened_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fact=excluded.fact,basis=excluded.basis,state=CASE WHEN orchestration_findings.state IN ('resolved','suppressed') THEN 'open' ELSE orchestration_findings.state END,opened_at=CASE WHEN orchestration_findings.state='resolved' THEN excluded.opened_at ELSE orchestration_findings.opened_at END,updated_at=excluded.updated_at`, f.ID, f.WorkItemID, f.Rule, f.Scope, f.Fact, f.Basis, now, now)
			if e != nil {
				return e
			}
		}
		for _, f := range v.Findings {
			if _, ok := desired[f.ID]; ok {
				continue
			}
			state := ""
			if !valid[f.WorkItemID] && f.Rule != "execution_unknown" && f.Rule != "delivery_unknown" {
				state = "suppressed"
			} else if recoverable[f.ID] {
				state = "resolved"
			} else if f.Rule == "repeated_failure" && currentCandidates[f.WorkItemID] != "" && currentCandidates[f.WorkItemID] != f.Scope {
				state = "superseded"
			}
			if state != "" && state != f.State {
				if _, e := tx.Exec(`UPDATE orchestration_findings SET state=?,updated_at=? WHERE id=?`, state, now, f.ID); e != nil {
					return e
				}
			}
		}
		return nil
	})
	return err
}
func (c *Core) AcknowledgeOrchestrationFinding(ctx context.Context, id string) error {
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		res, e := tx.Exec(`UPDATE orchestration_findings SET state='acknowledged',updated_at=? WHERE id=? AND state='open'`, c.St.NowTS(), id)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return ErrConflict
		}
		return orchAudit(tx, "", "finding_acknowledged", id, c.St.NowTS())
	})
	c.notify()
	return err
}
