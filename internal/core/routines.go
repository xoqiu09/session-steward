package core

import (
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/xoqiu09/session-steward/internal/store"
)

var memoryRoutineTitle = regexp.MustCompile(`^(整合|整理)(本地)?(代理|agent)?记忆$`)

// This policy is configured by repository identity and a narrow task family.
// It never writes accepted/done, and never treats Stop as a successful delivery.
func (c *Core) applyRoutinePolicies(snap *Snapshot) {
	allowed := map[int64]bool{}
	for _, repo := range snap.Repos {
		for _, common := range c.AutomaticMemoryProjects {
			if repo.CommonDir == common {
				allowed[repo.ID] = true
			}
		}
	}
	for i := range snap.WorkItems {
		w := &snap.WorkItems[i]
		title := strings.Map(func(r rune) rune {
			if unicode.IsSpace(r) {
				return -1
			}
			return unicode.ToLower(r)
		}, w.Title)
		if w.RepoID == nil || !allowed[*w.RepoID] || !memoryRoutineTitle.MatchString(title) {
			continue
		}
		w.CompletionPolicy = "auto_history"
		c.routineState(snap, w)
	}
}

func (c *Core) routineState(snap *Snapshot, w *WorkItem) {
	delivered := ""
	if w.Brief != nil {
		delivered = w.Brief.LastDeliveredAt
	}
	hold := false
	issue := func(kind, at, text string) {
		if at == "" {
			at = w.UpdatedAt
		}
		if w.AutomaticIssue == "" || at > w.AutomaticIssueAt {
			w.AutomaticIssueKind, w.AutomaticIssueAt, w.AutomaticIssue = kind, at, text
		}
	}
	if w.Status == "blocked" {
		issue("blocked", nz(w.StatusChangedAt, w.CreatedAt), "工作项已标记受阻")
	}
	if !w.Ready {
		at := nz(w.DependenciesChangedAt, w.CreatedAt)
		for _, dep := range snap.Deps {
			if dep.Downstream != w.ID || dep.Satisfied {
				continue
			}
			if dep.UnmetAt > at {
				at = dep.UnmetAt
			}
		}
		issue("blocked", at, "等待上游工作项就绪")
	}
	briefs := []*Brief{w.Brief}
	if w.Brief != nil {
		for _, b := range w.Brief.BySession {
			briefs = append(briefs, b)
		}
	}
	for _, b := range briefs {
		if b == nil {
			continue
		}
		latest := ""
		for _, f := range b.Fields {
			if f != nil && !f.Flagged && f.At > latest {
				latest = f.At
			}
		}
		if latest < delivered {
			continue
		} // earlier routine rounds stay in history
		if f := b.Fields["blocker"]; f != nil && !f.Flagged && strings.TrimSpace(f.Text) != "" {
			issue("blocked", f.At, "Agent 回报卡点："+f.Text)
		}
		for _, key := range []string{"stage", "summary", "progress"} {
			if f := b.Fields[key]; f != nil && !f.Flagged && f.At > delivered && f.Source != "deliver" {
				hold = true
			}
		}
		if f := b.Fields["next_owner"]; f != nil && !f.Flagged && f.Text == "user" && f.Source != "deliver" && f.At >= delivered && (b.InputResolvedAt == "" || b.InputResolvedAt <= f.At) {
			issue("reported_decision", f.At, "Agent 明确回报需要你回应")
		}
	}
	sids := map[int64]bool{}
	for _, run := range snap.Runs {
		if run.WorkItemID != w.ID {
			continue
		}
		sids[run.SessionID] = true
		if run.EndedAt == "" && run.StartedAt > delivered {
			hold = true
		}
	}
	for _, s := range snap.Sessions {
		if s.DataSource != "live" || (s.WorkItemID != w.ID && (s.WorkItemID != "" || !sids[s.ID])) {
			continue
		}
		if s.LastActivityAt < delivered {
			continue
		}
		if s.State == "error" || s.State == "interrupted" {
			issue("session", s.LastActivityAt, "会话出错或中断，需要检查")
		}
		if s.State == "running" || s.State == "waiting_permission" {
			if s.Freshness == "live" {
				hold = true
			}
			if s.Freshness == "stale" && s.LastActivityAt > delivered {
				at, err := time.Parse(time.RFC3339Nano, s.LastActivityAt)
				if err == nil {
					issue("stalled", store.TS(at.Add(c.StaleAfter)), "长时间没有新活动，请检查；尚不能判断是否卡死")
				}
			}
		}
	}
	for _, a := range snap.Approvals {
		belongs := a.WorkItemID != nil && *a.WorkItemID == w.ID || a.WorkItemID == nil && a.SessionID != nil && sids[*a.SessionID]
		if !belongs || (a.Status != "pending" && a.Status != "decided") || a.Kind == "attention" {
			continue
		}
		if a.Deadline != "" && a.Deadline <= snap.Now {
			continue
		}
		issue("formal", a.CreatedAt, "存在正式审批或决定请求")
	}
	for _, f := range snap.Features {
		if f.Accepted || f.Validation != "failed" {
			continue
		}
		for _, p := range f.Contributions {
			if p.WorkItemID == w.ID && (p.Active || p.Candidate == f.Candidate) {
				at := p.ValidationAt
				if at == "" {
					at = p.At
				}
				issue("validation", at, "功能验证失败，需要检查")
			}
		}
	}
	w.AutomaticHistory = !hold && w.AutomaticIssue == "" && (w.Status == "done" || w.Status == "review" && delivered != "")
}
