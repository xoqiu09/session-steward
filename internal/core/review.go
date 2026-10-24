package core

import (
	"context"
	"sort"
	"time"

	"github.com/xoqiu09/session-steward/internal/store"
)

// AgentReview 是按 Agent 汇总的复盘计数。只用事实记录：执行记录、Agent 的 deliver、
// 用户把工作项标为完成、交付后被重新打开、检查门结果。不给质量打分。
type AgentReview struct {
	Provider    string `json:"provider"`
	Runs        int    `json:"runs"`         // 期间开始的执行记录
	Delivered   int    `json:"delivered"`    // 其中 Agent 提交过交付
	Accepted    int    `json:"accepted"`     // 交付的工作项目前已由用户标为完成
	Reopened    int    `json:"reopened"`     // 交付后被重新打开
	Abandoned   int    `json:"abandoned"`    // 执行记录以放弃结束
	HandedOff   int    `json:"handed_off"`   // 中途交接给其他会话
	ChecksPass  int    `json:"checks_pass"`  // 交付的工作项检查门合并成功
	ChecksFail  int    `json:"checks_fail"`  // 检查门未通过
	OpenPending int    `json:"open_pending"` // 已交付但尚未验收、也未重开
}

type Review struct {
	Since  string        `json:"since"`
	Days   int           `json:"days"`
	Agents []AgentReview `json:"agents"`
}

// AgentReview 统计最近 days 天开始的执行记录。
func (c *Core) AgentReview(ctx context.Context, days int) (*Review, error) {
	if days <= 0 || days > 365 {
		days = 30
	}
	since := store.TS(c.St.Now().Add(-time.Duration(days) * 24 * time.Hour))
	rows, err := c.St.R().QueryContext(ctx, `
		SELECT s.provider, r.work_item_id, r.outcome, w.status,
		  (SELECT MAX(b.at) FROM brief_entries b WHERE b.work_item_id=r.work_item_id AND b.session_id=r.session_id AND b.source='deliver' AND b.kind='agent' AND b.flagged=''
		    AND b.at>=r.started_at AND (r.ended_at='' OR b.at<=r.ended_at)),
		  (SELECT MAX(b.at) FROM brief_entries b WHERE b.work_item_id=r.work_item_id AND b.source='reopened')
		FROM runs r JOIN sessions s ON s.id=r.session_id JOIN work_items w ON w.id=r.work_item_id
		WHERE r.started_at > ? AND r.outcome<>'attribution_reverted' AND s.subagent_id=''`, since)
	if err != nil {
		return nil, err
	}
	type key struct{ provider, item string }
	m := map[string]*AgentReview{}
	delivered := map[key]bool{}
	for rows.Next() {
		var provider, item, outcome, status string
		var deliverAt, reopenAt *string
		if err := rows.Scan(&provider, &item, &outcome, &status, &deliverAt, &reopenAt); err != nil {
			rows.Close()
			return nil, err
		}
		a := m[provider]
		if a == nil {
			a = &AgentReview{Provider: provider}
			m[provider] = a
		}
		a.Runs++
		switch outcome {
		case "abandoned":
			a.Abandoned++
		case "handed_off":
			a.HandedOff++
		}
		if deliverAt == nil || *deliverAt == "" {
			continue
		}
		a.Delivered++
		delivered[key{provider, item}] = true
		switch {
		case reopenAt != nil && *reopenAt > *deliverAt:
			a.Reopened++
		case status == "done":
			a.Accepted++
		default:
			a.OpenPending++
		}
	}
	rows.Close()
	// 检查门：每个工作项只取最后一次结束的结果
	jrows, err := c.St.R().QueryContext(ctx, `SELECT work_item_id, state FROM merge_jobs j WHERE state IN ('merged','failed') AND created_at > ?
		AND created_at=(SELECT MAX(created_at) FROM merge_jobs k WHERE k.work_item_id=j.work_item_id AND k.state IN ('merged','failed'))`, since)
	if err != nil {
		return nil, err
	}
	for jrows.Next() {
		var item, state string
		if err := jrows.Scan(&item, &state); err != nil {
			jrows.Close()
			return nil, err
		}
		for k := range delivered {
			if k.item != item {
				continue
			}
			if state == "merged" {
				m[k.provider].ChecksPass++
			} else {
				m[k.provider].ChecksFail++
			}
		}
	}
	jrows.Close()
	out := &Review{Since: since, Days: days, Agents: []AgentReview{}}
	for _, a := range m {
		out.Agents = append(out.Agents, *a)
	}
	sort.Slice(out.Agents, func(i, j int) bool { return out.Agents[i].Provider < out.Agents[j].Provider })
	return out, nil
}
