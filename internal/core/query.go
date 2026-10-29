package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

type Repo struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	CommonDir string `json:"common_dir"`
	IsGit     bool   `json:"is_git"`
	TargetRef string `json:"target_ref"`
	// Device 只在“全部设备”合并视图里有：项目在哪台电脑上。
	Device string `json:"device,omitempty"`
}

type Session struct {
	ID                int64  `json:"id"`
	HostID            string `json:"host_id"`
	Provider          string `json:"provider"`
	ProviderSessionID string `json:"provider_session_id"`
	Client            string `json:"client"`
	Version           string `json:"version"`
	Cwd               string `json:"cwd"`
	Worktree          string `json:"worktree"`
	Branch            string `json:"branch"`
	RepoID            *int64 `json:"repo_id"`
	State             string `json:"state"`
	StateReason       string `json:"state_reason"`
	DataSource        string `json:"data_source"` // live | history
	Freshness         string `json:"freshness"`   // live | history | stale
	SuggestedWorkItem string `json:"suggested_work_item"`
	FirstSeenAt       string `json:"first_seen_at"`
	LastActivityAt    string `json:"last_activity_at"`
	LastProgressAt    string `json:"last_progress_at"`
	WorkItemID        string `json:"work_item_id"`
	Binding           string `json:"binding"`
	WorktreeConflict  bool   `json:"worktree_conflict"`
	ResumeCommand     string `json:"resume_command"`
	Title             string `json:"title"`
	TitleSource       string `json:"title_source"`
	LastToolPreview   string `json:"last_tool_preview"`
	LastToolAt        string `json:"last_tool_at"`
}

type Run struct {
	ID         int64  `json:"id"`
	WorkItemID string `json:"work_item_id"`
	SessionID  int64  `json:"session_id"`
	Provider   string `json:"provider"`
	Attempt    int    `json:"attempt"`
	Binding    string `json:"binding"`
	StartedAt  string `json:"started_at"`
	EndedAt    string `json:"ended_at"`
	Outcome    string `json:"outcome"`
}

type Dep struct {
	UnmetAt    string `json:"-"`
	Upstream   string `json:"upstream"`
	Downstream string `json:"downstream"`
	Cond       string `json:"cond"`
	Satisfied  bool   `json:"satisfied"`
}

type WorkItem struct {
	StatusChangedAt       string          `json:"-"`
	MergeChangedAt        string          `json:"-"`
	DependenciesChangedAt string          `json:"-"`
	ID                    string          `json:"id"`
	RepoID                *int64          `json:"repo_id"`
	Title                 string          `json:"title"`
	Status                string          `json:"status"`
	Acceptance            string          `json:"acceptance"`
	Branch                string          `json:"branch"`
	MergeState            string          `json:"merge_state"`
	MergeEvidence         *MergeEvidence  `json:"merge_evidence,omitempty"`
	Management            *WorkManagement `json:"management,omitempty"`
	NeedsMerge            bool            `json:"needs_merge"`
	CreatedAt             string          `json:"created_at"`
	UpdatedAt             string          `json:"updated_at"`
	Ready                 bool            `json:"ready"`   // 所有上游均满足
	Waiting               []string        `json:"waiting"` // 未满足的上游
	Agents                []string        `json:"agents"`  // 当前活跃 run 的 provider
	Brief                 *Brief          `json:"brief"`   // 没有任何简报条目时为 null
	CompletionPolicy      string          `json:"completion_policy,omitempty"`
	AutomaticHistory      bool            `json:"automatic_history,omitempty"`
	AutomaticIssue        string          `json:"automatic_issue,omitempty"`
	AutomaticIssueKind    string          `json:"automatic_issue_kind,omitempty"`
	AutomaticIssueAt      string          `json:"automatic_issue_at,omitempty"`
}

type Approval struct {
	ID          string          `json:"id"`
	Kind        string          `json:"kind"`
	Status      string          `json:"status"`
	SessionID   *int64          `json:"session_id"`
	WorkItemID  *string         `json:"work_item_id"`
	RepoID      *int64          `json:"repo_id"`
	Fingerprint string          `json:"fingerprint"`
	ToolName    string          `json:"tool_name"`
	Preview     string          `json:"preview"`
	Decision    string          `json:"decision"`
	Handleable  bool            `json:"handleable"`
	Payload     json.RawMessage `json:"payload"`
	CloseReason string          `json:"close_reason"`
	Deadline    string          `json:"deadline"`
	CreatedAt   string          `json:"created_at"`
	DecidedAt   string          `json:"decided_at"`
	DeliveredAt string          `json:"delivered_at"`
	ConfirmedAt string          `json:"confirmed_at"`
	ClosedAt    string          `json:"closed_at"`
}

type Snapshot struct {
	Cursor       int64            `json:"cursor"`
	Now          string           `json:"now"`
	Repos        []Repo           `json:"repos"`
	Sessions     []Session        `json:"sessions"`
	WorkItems    []WorkItem       `json:"work_items"`
	Deps         []Dep            `json:"deps"`
	Runs         []Run            `json:"runs"`
	Approvals    []Approval       `json:"approvals"`
	Attributions []Attribution    `json:"attributions"`
	Features     []ProjectFeature `json:"features"`
	Managed      []ManagedSession `json:"managed"`
	Agents       []string         `json:"agents"`
	AgentInfo    []AgentInfo      `json:"agent_info"`
	MergeJobs    []MergeJob       `json:"merge_jobs"`
	CheckedRepos []int64          `json:"checked_repos"`
	SessionUsage []SessionUsage   `json:"session_usage"`
	ItemUsage    []ItemUsage      `json:"item_usage"`
	Handoffs     []Handoff        `json:"handoffs"`
	SummaryRepos []int64          `json:"summary_repos"`
	// ReplayAt 非空表示这是回放快照（小镇时间条），只读。
	ReplayAt string `json:"replay_at,omitempty"`
	// Devices 只在“全部设备”合并视图里有。
	Devices          []HubDevice `json:"devices,omitempty"`
	ArchivedProjects int         `json:"archived_projects,omitempty"`
}

// Snapshot 返回界面需要的完整状态。审批只包含未关闭的和最近 24 小时关闭的。
func (c *Core) Snapshot(ctx context.Context) (*Snapshot, error) {
	db := c.St.R()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	snap := &Snapshot{Now: c.St.NowTS()}
	tx.QueryRow(`SELECT COALESCE(MAX(seq),0) FROM changes`).Scan(&snap.Cursor)

	rows, err := tx.Query(`SELECT id, name, common_dir, is_git, target_ref FROM repos WHERE id NOT IN (SELECT repo_id FROM repo_aliases) ORDER BY name`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r Repo
		rows.Scan(&r.ID, &r.Name, &r.CommonDir, &r.IsGit, &r.TargetRef)
		snap.Repos = append(snap.Repos, r)
	}
	rows.Close()

	staleBefore := c.St.Now().Add(-c.StaleAfter).UTC().Format("2006-01-02T15:04:05.000000000Z")
	rows, err = tx.Query(`SELECT s.id, s.host_id, s.provider, s.provider_session_id, s.client, s.version, s.cwd, s.worktree, s.branch, s.repo_id,
		s.state, s.state_reason, s.data_source, s.suggested_work_item, s.first_seen_at, s.last_activity_at, s.last_progress_at,
		COALESCE(r.work_item_id,''), COALESCE(r.binding,''), COALESCE(t.title,''), COALESCE(t.source,''),
		COALESCE((SELECT body FROM events e WHERE e.session_id=s.id AND e.kind IN ('tool_pre','tool_post','tool_fail') ORDER BY occurred_at DESC,seq DESC LIMIT 1),'{}')
		FROM sessions s LEFT JOIN runs r ON r.session_id=s.id AND r.ended_at=''
		LEFT JOIN session_titles t ON t.session_id=s.id
		ORDER BY s.last_activity_at DESC`)
	if err != nil {
		return nil, err
	}
	activeWorktrees := map[string]int{}
	for rows.Next() {
		var s Session
		var repo sql.NullInt64
		var toolBody string
		if err := rows.Scan(&s.ID, &s.HostID, &s.Provider, &s.ProviderSessionID, &s.Client, &s.Version, &s.Cwd, &s.Worktree, &s.Branch, &repo,
			&s.State, &s.StateReason, &s.DataSource, &s.SuggestedWorkItem, &s.FirstSeenAt, &s.LastActivityAt, &s.LastProgressAt,
			&s.WorkItemID, &s.Binding, &s.Title, &s.TitleSource, &toolBody); err != nil {
			rows.Close()
			return nil, err
		}
		var tool event.Event
		if json.Unmarshal([]byte(toolBody), &tool) == nil && tool.Preview != "" {
			s.LastToolPreview, s.LastToolAt = tool.Preview, tool.OccurredAt.UTC().Format(time.RFC3339Nano)
		}
		if s.Provider == "codex" {
			s.Client = event.CodexClient(s.Client) // 兼容已有历史记录，不改写原始事件
		}
		if repo.Valid {
			v := repo.Int64
			s.RepoID = &v
		}
		s.Freshness = s.DataSource
		active := s.State == "running" || s.State == "waiting_permission"
		if s.DataSource == "live" && active && s.LastActivityAt < staleBefore {
			s.Freshness = "stale" // 长时间无活动 / 状态未知，不判定为卡死
		}
		if s.Freshness == "live" && active && s.Worktree != "" {
			activeWorktrees[s.Worktree]++
		}
		s.ResumeCommand = resumeCommand(s.Provider, s.ProviderSessionID)
		snap.Sessions = append(snap.Sessions, s)
	}
	rows.Close()
	for i := range snap.Sessions {
		s := &snap.Sessions[i]
		// Hooks 能证明同目录会话正在运行，不能证明它们都在写文件。
		s.WorktreeConflict = s.Freshness == "live" &&
			(s.State == "running" || s.State == "waiting_permission") && activeWorktrees[s.Worktree] > 1
	}

	type st struct{ status, merge string }
	items := map[string]st{}
	rows, err = tx.Query(`SELECT w.id, w.repo_id, w.title, w.status, w.acceptance, w.branch, w.merge_state, w.needs_merge, w.created_at, w.updated_at,
	  COALESCE(k.status_at,w.created_at),COALESCE(k.merge_at,w.created_at),COALESCE(k.dependencies_at,w.created_at),
	  COALESCE((SELECT v FROM meta WHERE k='merge_verified:'||w.id),''),
	  COALESCE((SELECT v FROM meta WHERE k='work_management:'||w.id),'')
	  FROM work_items w LEFT JOIN work_item_clocks k ON k.work_item_id=w.id ORDER BY w.id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var w WorkItem
		var repo sql.NullInt64
		var evidence, management string
		if err := rows.Scan(&w.ID, &repo, &w.Title, &w.Status, &w.Acceptance, &w.Branch, &w.MergeState, &w.NeedsMerge, &w.CreatedAt, &w.UpdatedAt, &w.StatusChangedAt, &w.MergeChangedAt, &w.DependenciesChangedAt, &evidence, &management); err != nil {
			rows.Close()
			return nil, err
		}
		if w.MergeState == "merged" && evidence != "" {
			_ = json.Unmarshal([]byte(evidence), &w.MergeEvidence)
		}
		if management != "" {
			_ = json.Unmarshal([]byte(management), &w.Management)
		}
		if repo.Valid {
			v := repo.Int64
			w.RepoID = &v
		}
		w.Ready = true
		w.Waiting = []string{}
		w.Agents = []string{}
		items[w.ID] = st{w.Status, w.MergeState}
		snap.WorkItems = append(snap.WorkItems, w)
	}
	rows.Close()

	losses, err := dependencyLossTimes(tx)
	if err != nil {
		return nil, err
	}
	rows, err = tx.Query(`SELECT upstream, downstream, cond FROM work_deps`)
	if err != nil {
		return nil, err
	}
	waiting := map[string][]string{}
	for rows.Next() {
		var d Dep
		rows.Scan(&d.Upstream, &d.Downstream, &d.Cond)
		u := items[d.Upstream]
		d.Satisfied = DepSatisfied(d.Cond, u.status, u.merge)
		d.UnmetAt = losses[dependencyCondition{d.Upstream, d.Cond}]
		if !d.Satisfied {
			waiting[d.Downstream] = append(waiting[d.Downstream], d.Upstream)
		}
		snap.Deps = append(snap.Deps, d)
	}
	rows.Close()

	rows, err = tx.Query(`SELECT r.id, r.work_item_id, r.session_id, s.provider, r.attempt, r.binding, r.started_at, r.ended_at, r.outcome
		FROM runs r JOIN sessions s ON s.id=r.session_id ORDER BY r.work_item_id, r.attempt`)
	if err != nil {
		return nil, err
	}
	agents := map[string][]string{}
	for rows.Next() {
		var r Run
		rows.Scan(&r.ID, &r.WorkItemID, &r.SessionID, &r.Provider, &r.Attempt, &r.Binding, &r.StartedAt, &r.EndedAt, &r.Outcome)
		if r.EndedAt == "" {
			agents[r.WorkItemID] = appendUniq(agents[r.WorkItemID], r.Provider)
		}
		snap.Runs = append(snap.Runs, r)
	}
	rows.Close()
	statuses := map[string]string{}
	for id, v := range items {
		statuses[id] = v.status
	}
	briefs, err := c.loadBriefs(tx, statuses)
	if err != nil {
		return nil, err
	}
	for i := range snap.WorkItems {
		w := &snap.WorkItems[i]
		w.Brief = briefs[w.ID]
		if ws := waiting[w.ID]; len(ws) > 0 {
			w.Ready, w.Waiting = false, ws
		}
		if a := agents[w.ID]; a != nil {
			w.Agents = a
		}
	}

	since := c.St.Now().Add(-24 * time.Hour).UTC().Format("2006-01-02T15:04:05.000000000Z")
	rows, err = tx.Query(`SELECT `+approvalColumns+`
		FROM approvals WHERE closed_at='' OR closed_at >= ? OR (status='delivered' AND delivered_at >= ?) ORDER BY created_at DESC LIMIT 2000`, since, since)
	if err != nil {
		return nil, err
	}
	snap.Approvals = append(snap.Approvals, readApprovals(rows)...)
	rows.Close()
	rows, err = tx.Query(`SELECT id,session_id,fingerprint,status,plan,work_item_id,run_id,automatic,created_item,created_at,decided_at FROM attributions ORDER BY created_at DESC,id LIMIT 2000`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var a Attribution
		var plan string
		if err = rows.Scan(&a.ID, &a.SessionID, &a.Fingerprint, &a.Status, &plan, &a.WorkItemID, &a.RunID, &a.Automatic, &a.CreatedItem, &a.CreatedAt, &a.DecidedAt); err != nil {
			rows.Close()
			return nil, err
		}
		if err = json.Unmarshal([]byte(plan), &a.Plan); err != nil {
			rows.Close()
			return nil, err
		}
		snap.Attributions = append(snap.Attributions, a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if snap.Features, err = c.readFeatures(tx); err != nil {
		return nil, err
	}
	if snap.Managed, err = c.readManaged(tx); err != nil {
		return nil, err
	}
	if snap.SessionUsage, snap.ItemUsage, err = c.readUsage(tx); err != nil {
		return nil, err
	}
	if snap.Handoffs, err = c.readHandoffs(tx); err != nil {
		return nil, err
	}
	if snap.MergeJobs, err = c.readMergeJobs(tx); err != nil {
		return nil, err
	}
	for _, r := range snap.Repos {
		if c.SummaryAllowed(r.Name, r.CommonDir) {
			snap.SummaryRepos = append(snap.SummaryRepos, r.ID)
		}
		if len(c.ChecksFor(r.Name, r.CommonDir)) > 0 {
			snap.CheckedRepos = append(snap.CheckedRepos, r.ID)
		}
	}
	if c.Term != nil {
		snap.Agents, snap.AgentInfo = c.AgentNames(), c.AgentInfos()
	}
	c.applyRoutinePolicies(snap)
	if err := projectVisibility(tx, snap); err != nil {
		return nil, err
	}
	return snap, nil
}

func appendUniq(s []string, v string) []string {
	for _, x := range s {
		if x == v {
			return s
		}
	}
	return append(s, v)
}

func resumeCommand(provider, id string) string {
	switch provider {
	case "claude":
		return "claude --resume " + id
	case "codex":
		return "codex resume " + id
	}
	return ""
}

// SessionEvents 返回某个 session 最近的事件（脱敏后的）。
func (c *Core) SessionEvents(ctx context.Context, sid int64, limit int) ([]json.RawMessage, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT body FROM events WHERE session_id=? ORDER BY occurred_at DESC, seq DESC LIMIT ?`, sid, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []json.RawMessage{}
	for rows.Next() {
		var b string
		rows.Scan(&b)
		out = append(out, json.RawMessage(b))
	}
	return out, rows.Err()
}

// approvalColumns 与 readApprovals 的扫描顺序一致。
const approvalColumns = `id, kind, status, session_id, work_item_id, repo_id, fingerprint, tool_name, preview, decision, handleable, payload,
		close_reason, deadline, created_at, decided_at, delivered_at, confirmed_at, closed_at`

func readApprovals(rows *sql.Rows) []Approval {
	var out []Approval
	for rows.Next() {
		var a Approval
		var sid, rid sql.NullInt64
		var wid sql.NullString
		var payload string
		rows.Scan(&a.ID, &a.Kind, &a.Status, &sid, &wid, &rid, &a.Fingerprint, &a.ToolName, &a.Preview, &a.Decision, &a.Handleable, &payload,
			&a.CloseReason, &a.Deadline, &a.CreatedAt, &a.DecidedAt, &a.DeliveredAt, &a.ConfirmedAt, &a.ClosedAt)
		if sid.Valid {
			v := sid.Int64
			a.SessionID = &v
		}
		if rid.Valid {
			v := rid.Int64
			a.RepoID = &v
		}
		if wid.Valid {
			v := wid.String
			a.WorkItemID = &v
		}
		a.Payload = json.RawMessage(payload)
		out = append(out, a)
	}
	return out
}
