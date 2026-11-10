package core

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/xoqiu09/session-steward/internal/event"
)

// 直播展示（小镇推流）：只读、已脱敏。这里的规则是“白名单重建”——
// 新建一个快照，只拷贝画面需要的非文字字段；保留下来的字符串也都要通过
// 枚举、时间或 provider 的校验，任何来自数据的自由文字都不会原样出现。
// 以后给 Snapshot 加新字段时，默认不会进入展示快照。

// LiveNoteMax 是展示说明每个字段的最大字符数。
const LiveNoteMax = 80

const liveNoteKey = "live:note"

// LiveNote 是展示画面上方的说明卡，由用户在本机面板填写。
type LiveNote struct {
	Doing     string `json:"doing"`
	Thinking  string `json:"thinking"`
	Contact   string `json:"contact"`
	UpdatedAt string `json:"updated_at"`
}

// LiveNote 读取展示说明；没有设置过时返回空值。
func (c *Core) LiveNote(ctx context.Context) (LiveNote, error) {
	var n LiveNote
	raw, err := c.St.Meta(ctx, liveNoteKey)
	if err != nil || raw == "" {
		return n, err
	}
	if json.Unmarshal([]byte(raw), &n) != nil {
		return LiveNote{}, nil
	}
	return n, nil
}

// SetLiveNote 校验并保存展示说明。只写 meta 的一个键，不碰项目和工作项。
func (c *Core) SetLiveNote(ctx context.Context, in LiveNote) (LiveNote, error) {
	out := LiveNote{}
	for _, f := range []struct {
		name string
		src  string
		dst  *string
	}{{"正在", in.Doing, &out.Doing}, {"最近思考", in.Thinking, &out.Thinking}, {"交流方式", in.Contact, &out.Contact}} {
		v := strings.TrimSpace(f.src)
		if !utf8.ValidString(v) {
			return LiveNote{}, fmt.Errorf("%w: %s 不是有效文字", ErrBadRequest, f.name)
		}
		if n := utf8.RuneCountInString(v); n > LiveNoteMax {
			return LiveNote{}, fmt.Errorf("%w: %s 最多 %d 个字（现在 %d 个）", ErrBadRequest, f.name, LiveNoteMax, n)
		}
		if strings.IndexFunc(v, unicode.IsControl) >= 0 {
			return LiveNote{}, fmt.Errorf("%w: %s 不能包含换行或控制字符", ErrBadRequest, f.name)
		}
		*f.dst = v
	}
	out.UpdatedAt = c.St.NowTS()
	b, _ := json.Marshal(out)
	if err := c.St.SetMeta(ctx, liveNoteKey, string(b)); err != nil {
		return LiveNote{}, err
	}
	return out, nil
}

// LiveProjectName 按名次给出通用项目名：项目 A … 项目 Z，之后是“项目 27”。
func LiveProjectName(rank int) string {
	if rank >= 0 && rank < 26 {
		return "项目 " + string(rune('A'+rank))
	}
	return "项目 " + strconv.Itoa(rank+1)
}

// LiveProjectNames 把项目编号按升序排名映射成通用名。新增更大编号的项目不改变已有名称。
func LiveProjectNames(ids []int64) map[int64]string {
	sorted := append([]int64(nil), ids...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	out := make(map[int64]string, len(sorted))
	rank := 0
	for _, id := range sorted {
		if _, ok := out[id]; ok {
			continue
		}
		out[id] = LiveProjectName(rank)
		rank++
	}
	return out
}

// LiveItemID 把工作项编号（可能含项目缩写）换成不透明但稳定的编号。
func LiveItemID(key []byte, id string) string {
	if id == "" {
		return ""
	}
	m := hmac.New(sha256.New, key)
	m.Write([]byte("work-item\x00" + id))
	return "item-" + hex.EncodeToString(m.Sum(nil))[:12]
}

func oneOf(v string, allowed ...string) string {
	for _, a := range allowed {
		if v == a {
			return v
		}
	}
	return ""
}

// liveProvider 只保留常见 Agent 名；配置里的自定义名一律记为 other。
func liveProvider(p string) string {
	switch p {
	case "claude", "codex", "gemini", "cursor", "opencode":
		return p
	case "":
		return ""
	}
	return "other"
}

// liveTime 只保留能解析的时间戳。
func liveTime(v string) string {
	if v == "" {
		return ""
	}
	if _, err := time.Parse(time.RFC3339Nano, v); err != nil {
		return ""
	}
	return v
}

func liveSignal(s *Signal) *Signal {
	if s == nil || !event.ValidChannel(s.Channel) || liveTime(s.At) == "" {
		return nil
	}
	return &Signal{Channel: event.Channel(s.Channel), At: s.At}
}

func liveOutcome(o string) string {
	if strings.HasPrefix(o, "failed") {
		return "failed"
	}
	return oneOf(o, "delivered", "failed", "error", "interrupted", "cancelled", "abandoned", "acknowledged", "unsent", "uncertain",
		"handed_off", "attribution_reverted", "historical", "ended", "ended_with_question", "stopped", "held")
}

// 展示快照的上限。画面最多画 LiveMaxProjects 栋房子；每个项目只带画面和进度气泡用得到的少量记录，
// 项目和会话再多，快照也只有几十 KB。
const (
	LiveMaxProjects     = 12
	liveMaxSessions     = 8 // 每个项目：正在干活的优先
	liveMaxOpenItems    = 8 // 每个项目：未关闭的工作项
	liveMaxClosedItems  = 3 // 每个项目：最近关闭的工作项（气泡要看到状态变化）
	liveMaxOpenRuns     = 8 // 每个项目：未结束的运行
	liveMaxEndedRuns    = 4 // 每个项目：最近结束的运行
	liveClosedWindow    = 2 * time.Hour
	liveRunWindow       = time.Hour
	liveSessionIdleHide = 30 * time.Minute // 与前端 sessionBuckets 一致：空闲超过 30 分钟不上画面
)

// LiveRepo 等是展示快照专用的输出结构：只有这些字段，JSON 键名与普通快照相同，前端可以按同一类型读取。
type LiveRepo struct {
	ID             int64  `json:"id"`
	Name           string `json:"name"`
	IsGit          bool   `json:"is_git,omitempty"`
	Activity       string `json:"activity,omitempty"`
	LastActivityAt string `json:"last_activity_at,omitempty"`
}

type LiveSession struct {
	ID               int64   `json:"id"`
	Provider         string  `json:"provider,omitempty"`
	RepoID           *int64  `json:"repo_id"`
	State            string  `json:"state"`
	DataSource       string  `json:"data_source"`
	Freshness        string  `json:"freshness"`
	FirstSeenAt      string  `json:"first_seen_at,omitempty"`
	LastActivityAt   string  `json:"last_activity_at,omitempty"`
	LastProgressAt   string  `json:"last_progress_at,omitempty"`
	LastToolAt       string  `json:"last_tool_at,omitempty"`
	WorkItemID       string  `json:"work_item_id,omitempty"`
	WorktreeConflict bool    `json:"worktree_conflict,omitempty"`
	Signal           *Signal `json:"signal,omitempty"`
}

type LiveWorkItem struct {
	ID               string   `json:"id"`
	RepoID           *int64   `json:"repo_id"`
	Status           string   `json:"status"`
	MergeState       string   `json:"merge_state,omitempty"`
	NeedsMerge       bool     `json:"needs_merge,omitempty"`
	CreatedAt        string   `json:"created_at,omitempty"`
	UpdatedAt        string   `json:"updated_at,omitempty"`
	Agents           []string `json:"agents,omitempty"`
	CompletionPolicy string   `json:"completion_policy,omitempty"`
	AutomaticHistory bool     `json:"automatic_history,omitempty"`
	Signal           *Signal  `json:"signal,omitempty"`
	ReturnedAt       string   `json:"returned_at,omitempty"`
}

type LiveRun struct {
	ID         int64  `json:"id"`
	WorkItemID string `json:"work_item_id,omitempty"`
	SessionID  int64  `json:"session_id"`
	Provider   string `json:"provider,omitempty"`
	Attempt    int    `json:"attempt"`
	StartedAt  string `json:"started_at,omitempty"`
	EndedAt    string `json:"ended_at,omitempty"`
	Outcome    string `json:"outcome,omitempty"`
}

// LiveSnap 是展示快照。Deps 和 Approvals 恒为空数组，只为和普通快照的结构兼容。
// More 是没有画出来的项目数（只是一个数量）。
type LiveSnap struct {
	SignalGapAfterMin int            `json:"signal_gap_after_min,omitempty"`
	Cursor            int64          `json:"cursor"`
	Now               string         `json:"now"`
	Repos             []LiveRepo     `json:"repos"`
	Sessions          []LiveSession  `json:"sessions"`
	WorkItems         []LiveWorkItem `json:"work_items"`
	Deps              []struct{}     `json:"deps"`
	Runs              []LiveRun      `json:"runs"`
	Approvals         []struct{}     `json:"approvals"`
	More              int            `json:"more"`
}

func liveAt(v string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, v)
	if err != nil {
		return time.Time{}
	}
	return t
}

func liveSessionState(s string) string {
	return oneOf(s, "running", "waiting_permission", "idle", "interrupted", "error", "ended", "unknown")
}

func liveItemStatus(s string) string {
	return oneOf(s, "todo", "in_progress", "blocked", "review", "done", "abandoned")
}

// liveOnStage：前端会把它画成小人的会话（与 sessionBuckets 的 recent 同一口径；展示快照没有审批，所以没有“等你处理”的例外）。
func liveOnStage(x *Session, now time.Time) bool {
	state := liveSessionState(x.State)
	if x.DataSource != "live" || state == "ended" || x.Freshness == "stale" {
		return false
	}
	if state == "running" || state == "waiting_permission" {
		return true
	}
	at := liveAt(x.LastActivityAt)
	return at.IsZero() || now.Sub(at) < liveSessionIdleHide
}

func liveWorking(x *Session) bool {
	return liveSessionState(x.State) == "running" && x.Freshness != "stale" && x.Freshness != "history"
}

func liveOpen(status string) bool {
	switch liveItemStatus(status) {
	case "todo", "in_progress", "blocked", "review":
		return true
	}
	return false
}

// liveRepoOrder 选出要画的项目：没有被收起（安静、沉睡）且有未关闭工作项或在画面上的会话；
// 有助手在干活的排前面，其次按最近活动，最后按编号。
func liveRepoOrder(s *Snapshot, now time.Time) []Repo {
	type info struct {
		open, working bool
		onStage       bool
		last          time.Time
	}
	by := map[int64]*info{}
	get := func(id *int64) *info {
		if id == nil {
			return nil
		}
		if by[*id] == nil {
			by[*id] = &info{}
		}
		return by[*id]
	}
	for i := range s.WorkItems {
		if w := &s.WorkItems[i]; liveOpen(w.Status) {
			if r := get(w.RepoID); r != nil {
				r.open = true
			}
		}
	}
	for i := range s.Sessions {
		x := &s.Sessions[i]
		r := get(x.RepoID)
		if r == nil || !liveOnStage(x, now) {
			continue
		}
		r.onStage = true
		r.working = r.working || liveWorking(x)
		if at := liveAt(x.LastActivityAt); at.After(r.last) {
			r.last = at
		}
	}
	type cand struct {
		repo Repo
		info info
	}
	var list []cand
	for _, r := range s.Repos {
		a := by[r.ID]
		if a == nil || (!a.open && !a.onStage) || r.Activity == "quiet" || r.Activity == "dormant" {
			continue
		}
		c := cand{repo: r, info: *a}
		if at := liveAt(r.LastActivityAt); at.After(c.info.last) {
			c.info.last = at
		}
		list = append(list, c)
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i].info, list[j].info
		if a.working != b.working {
			return a.working
		}
		if !a.last.Equal(b.last) {
			return a.last.After(b.last)
		}
		return list[i].repo.ID < list[j].repo.ID
	})
	out := make([]Repo, 0, min(len(list), LiveMaxProjects))
	seen := map[int64]bool{}
	for _, c := range list {
		if len(out) == LiveMaxProjects {
			break
		}
		if !seen[c.repo.ID] {
			seen[c.repo.ID] = true
			out = append(out, c.repo)
		}
	}
	return out
}

// LiveSnapshot 用白名单重建一份可以公开展示的快照：只带要画的项目（最多 LiveMaxProjects 个），
// 以及这些项目下数量有限的会话、工作项和运行。key 用于把工作项编号换成稳定的不透明编号。
// 输出结构是专用的 Live* 类型，只有画面需要的字段；审批、功能、结构、归属、托管、派活、交接、合并、用量、设备等一律不带。
// 项目通用名按全部项目编号的升序名次计算，所以裁剪不会改变同一个项目的名字。
func LiveSnapshot(s *Snapshot, key []byte) *LiveSnap {
	out := &LiveSnap{Repos: []LiveRepo{}, Sessions: []LiveSession{}, WorkItems: []LiveWorkItem{}, Deps: []struct{}{}, Runs: []LiveRun{}, Approvals: []struct{}{}}
	if s == nil {
		out.Now = time.Now().UTC().Format(time.RFC3339Nano)
		return out
	}
	out.Cursor = s.Cursor
	out.Now = liveTime(s.Now)
	if out.Now == "" {
		out.Now = time.Now().UTC().Format(time.RFC3339Nano)
	}
	now := liveAt(out.Now)
	out.SignalGapAfterMin = s.SignalGapAfterMin
	item := func(id string) string { return LiveItemID(key, id) }

	all := make([]int64, 0, len(s.Repos))
	distinct := map[int64]bool{}
	for _, r := range s.Repos {
		all = append(all, r.ID)
		distinct[r.ID] = true
	}
	names := LiveProjectNames(all)
	chosen := liveRepoOrder(s, now)
	shown := make(map[int64]bool, len(chosen))
	for _, r := range chosen {
		shown[r.ID] = true
		out.Repos = append(out.Repos, LiveRepo{
			ID: r.ID, Name: names[r.ID], IsGit: r.IsGit,
			Activity:       oneOf(r.Activity, "active", "quiet", "dormant"),
			LastActivityAt: liveTime(r.LastActivityAt),
		})
	}
	out.More = len(distinct) - len(chosen)
	in := func(id *int64) bool { return id != nil && shown[*id] }
	repoKey := func(id *int64) int64 { return *id }

	// 会话：每个项目先放正在干活的，再按最近活动。
	sessionsBy := map[int64][]*Session{}
	sessionRepo := map[int64]*int64{}
	for i := range s.Sessions {
		x := &s.Sessions[i]
		sessionRepo[x.ID] = x.RepoID
		if in(x.RepoID) && liveOnStage(x, now) {
			sessionsBy[repoKey(x.RepoID)] = append(sessionsBy[repoKey(x.RepoID)], x)
		}
	}
	var sessions []*Session
	for _, list := range sessionsBy {
		sort.SliceStable(list, func(i, j int) bool {
			if a, b := liveWorking(list[i]), liveWorking(list[j]); a != b {
				return a
			}
			if a, b := liveAt(list[i].LastActivityAt), liveAt(list[j].LastActivityAt); !a.Equal(b) {
				return a.After(b)
			}
			return list[i].ID < list[j].ID
		})
		sessions = append(sessions, list[:min(len(list), liveMaxSessions)]...)
	}
	sort.Slice(sessions, func(i, j int) bool { return sessions[i].ID < sessions[j].ID })
	for _, x := range sessions {
		out.Sessions = append(out.Sessions, LiveSession{
			ID: x.ID, Provider: liveProvider(x.Provider), RepoID: x.RepoID,
			State:            liveSessionState(x.State),
			DataSource:       oneOf(x.DataSource, "live", "history"),
			Freshness:        oneOf(x.Freshness, "live", "history", "stale"),
			FirstSeenAt:      liveTime(x.FirstSeenAt),
			LastActivityAt:   liveTime(x.LastActivityAt),
			LastProgressAt:   liveTime(x.LastProgressAt),
			LastToolAt:       liveTime(x.LastToolAt),
			WorkItemID:       item(x.WorkItemID),
			WorktreeConflict: x.WorktreeConflict,
			Signal:           liveSignal(x.Signal),
		})
	}

	// 工作项：未关闭的按“待处理 > 进行中 > 卡住 > 待开始”再按更新时间；另带少量最近关闭的，
	// 这样上一份快照里的工作项关闭时，下一份还看得到它，进度气泡能比出状态变化。
	rank := map[string]int{"review": 0, "in_progress": 1, "blocked": 2, "todo": 3}
	openBy, closedBy := map[int64][]*WorkItem{}, map[int64][]*WorkItem{}
	itemRepo := map[string]*int64{}
	for i := range s.WorkItems {
		w := &s.WorkItems[i]
		itemRepo[w.ID] = w.RepoID
		if !in(w.RepoID) {
			continue
		}
		switch {
		case liveOpen(w.Status):
			openBy[repoKey(w.RepoID)] = append(openBy[repoKey(w.RepoID)], w)
		case liveItemStatus(w.Status) != "":
			if at := liveAt(w.UpdatedAt); !at.IsZero() && now.Sub(at) < liveClosedWindow {
				closedBy[repoKey(w.RepoID)] = append(closedBy[repoKey(w.RepoID)], w)
			}
		}
	}
	newer := func(list []*WorkItem, i, j int) bool {
		if a, b := liveAt(list[i].UpdatedAt), liveAt(list[j].UpdatedAt); !a.Equal(b) {
			return a.After(b)
		}
		return list[i].ID < list[j].ID
	}
	var items []*WorkItem
	for _, list := range openBy {
		sort.SliceStable(list, func(i, j int) bool {
			if a, b := rank[list[i].Status], rank[list[j].Status]; a != b {
				return a < b
			}
			return newer(list, i, j)
		})
		items = append(items, list[:min(len(list), liveMaxOpenItems)]...)
	}
	for _, list := range closedBy {
		sort.SliceStable(list, func(i, j int) bool { return newer(list, i, j) })
		items = append(items, list[:min(len(list), liveMaxClosedItems)]...)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ID < items[j].ID })
	for _, w := range items {
		agents := make([]string, 0, len(w.Agents))
		for _, a := range w.Agents {
			agents = append(agents, liveProvider(a))
		}
		out.WorkItems = append(out.WorkItems, LiveWorkItem{
			ID: item(w.ID), RepoID: w.RepoID,
			Status:           liveItemStatus(w.Status),
			MergeState:       oneOf(w.MergeState, "none", "not_ready", "awaiting", "approved", "merged"),
			NeedsMerge:       w.NeedsMerge,
			CreatedAt:        liveTime(w.CreatedAt),
			UpdatedAt:        liveTime(w.UpdatedAt),
			Agents:           agents[:min(len(agents), 4)],
			CompletionPolicy: oneOf(w.CompletionPolicy, "auto_history", "manual"),
			AutomaticHistory: w.AutomaticHistory,
			Signal:           liveSignal(w.Signal),
			ReturnedAt:       liveTime(w.ReturnedAt),
		})
	}

	// 运行：归到工作项（没有时归到会话）的项目；未结束的优先，另带最近一小时结束的。
	runsBy := map[int64][]*Run{}
	for i := range s.Runs {
		r := &s.Runs[i]
		repo, ok := itemRepo[r.WorkItemID]
		if !ok || repo == nil {
			repo = sessionRepo[r.SessionID]
		}
		if !in(repo) {
			continue
		}
		if r.EndedAt != "" {
			if at := liveAt(r.EndedAt); at.IsZero() || now.Sub(at) >= liveRunWindow {
				continue
			}
		}
		runsBy[repoKey(repo)] = append(runsBy[repoKey(repo)], r)
	}
	// 未结束的：先放画面上那些会话的（它们结束时才会出“一轮运行完成”），再按编号从新到旧；
	// 刚结束的另算名额，按结束时间从新到旧，这样上一份里未结束的运行结束后，下一份还看得到它。
	onStage := make(map[int64]bool, len(out.Sessions))
	for _, x := range out.Sessions {
		onStage[x.ID] = true
	}
	var runs []*Run
	for _, list := range runsBy {
		var open, ended []*Run
		for _, r := range list {
			if r.EndedAt == "" {
				open = append(open, r)
			} else {
				ended = append(ended, r)
			}
		}
		sort.SliceStable(open, func(i, j int) bool {
			if a, b := onStage[open[i].SessionID], onStage[open[j].SessionID]; a != b {
				return a
			}
			return open[i].ID > open[j].ID
		})
		sort.SliceStable(ended, func(i, j int) bool {
			if a, b := liveAt(ended[i].EndedAt), liveAt(ended[j].EndedAt); !a.Equal(b) {
				return a.After(b)
			}
			return ended[i].ID > ended[j].ID
		})
		runs = append(runs, open[:min(len(open), liveMaxOpenRuns)]...)
		runs = append(runs, ended[:min(len(ended), liveMaxEndedRuns)]...)
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].ID < runs[j].ID })
	for _, r := range runs {
		out.Runs = append(out.Runs, LiveRun{
			ID: r.ID, WorkItemID: item(r.WorkItemID), SessionID: r.SessionID, Provider: liveProvider(r.Provider), Attempt: r.Attempt,
			StartedAt: liveTime(r.StartedAt), EndedAt: liveTime(r.EndedAt), Outcome: liveOutcome(r.Outcome),
		})
	}
	return out
}
