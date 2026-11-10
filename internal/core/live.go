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

func liveBinding(b string) string {
	return oneOf(b, "manual", "auto", "claim", "suggested", "inferred", "dispatch", "handoff")
}

// LiveSnapshot 用白名单重建一份可以公开展示的快照。key 用于把工作项编号换成稳定的不透明编号。
// 审批、功能、结构、归属、托管、派活、交接、合并、用量、设备等一律不带。
func LiveSnapshot(s *Snapshot, key []byte) *Snapshot {
	out := &Snapshot{
		Repos: []Repo{}, Sessions: []Session{}, WorkItems: []WorkItem{}, Deps: []Dep{}, Runs: []Run{}, Approvals: []Approval{},
	}
	if s == nil {
		out.Now = time.Now().UTC().Format(time.RFC3339Nano)
		return out
	}
	out.Cursor = s.Cursor
	out.Now = liveTime(s.Now)
	if out.Now == "" {
		out.Now = time.Now().UTC().Format(time.RFC3339Nano)
	}
	out.SignalGapAfterMin = s.SignalGapAfterMin
	item := func(id string) string { return LiveItemID(key, id) }

	ids := make([]int64, 0, len(s.Repos))
	for _, r := range s.Repos {
		ids = append(ids, r.ID)
	}
	names := LiveProjectNames(ids)
	for _, r := range s.Repos {
		out.Repos = append(out.Repos, Repo{
			ID: r.ID, Name: names[r.ID], IsGit: r.IsGit,
			Activity:       oneOf(r.Activity, "active", "quiet", "dormant"),
			LastActivityAt: liveTime(r.LastActivityAt),
		})
	}
	for _, x := range s.Sessions {
		out.Sessions = append(out.Sessions, Session{
			ID: x.ID, Provider: liveProvider(x.Provider), RepoID: x.RepoID,
			State:            oneOf(x.State, "running", "waiting_permission", "idle", "interrupted", "error", "ended", "unknown"),
			DataSource:       oneOf(x.DataSource, "live", "history"),
			Freshness:        oneOf(x.Freshness, "live", "history", "stale"),
			FirstSeenAt:      liveTime(x.FirstSeenAt),
			LastActivityAt:   liveTime(x.LastActivityAt),
			LastProgressAt:   liveTime(x.LastProgressAt),
			LastToolAt:       liveTime(x.LastToolAt),
			WorkItemID:       item(x.WorkItemID),
			Binding:          liveBinding(x.Binding),
			WorktreeConflict: x.WorktreeConflict,
			Signal:           liveSignal(x.Signal),
		})
	}
	for _, w := range s.WorkItems {
		waiting := make([]string, 0, len(w.Waiting))
		for _, u := range w.Waiting {
			waiting = append(waiting, item(u))
		}
		agents := make([]string, 0, len(w.Agents))
		for _, a := range w.Agents {
			agents = append(agents, liveProvider(a))
		}
		out.WorkItems = append(out.WorkItems, WorkItem{
			ID: item(w.ID), RepoID: w.RepoID, Title: "工作项",
			Status:           oneOf(w.Status, "todo", "in_progress", "blocked", "review", "done", "abandoned"),
			MergeState:       oneOf(w.MergeState, "none", "not_ready", "awaiting", "approved", "merged"),
			NeedsMerge:       w.NeedsMerge,
			CreatedAt:        liveTime(w.CreatedAt),
			UpdatedAt:        liveTime(w.UpdatedAt),
			Ready:            w.Ready,
			Waiting:          waiting,
			Agents:           agents,
			CompletionPolicy: oneOf(w.CompletionPolicy, "auto_history", "manual"),
			AutomaticHistory: w.AutomaticHistory,
			Signal:           liveSignal(w.Signal),
			ReturnedAt:       liveTime(w.ReturnedAt),
		})
	}
	for _, d := range s.Deps {
		out.Deps = append(out.Deps, Dep{Upstream: item(d.Upstream), Downstream: item(d.Downstream), Cond: oneOf(d.Cond, "accepted", "merged"), Satisfied: d.Satisfied})
	}
	for _, r := range s.Runs {
		out.Runs = append(out.Runs, Run{
			ID: r.ID, WorkItemID: item(r.WorkItemID), SessionID: r.SessionID, Provider: liveProvider(r.Provider), Attempt: r.Attempt,
			Binding: liveBinding(r.Binding), StartedAt: liveTime(r.StartedAt), EndedAt: liveTime(r.EndedAt), Outcome: liveOutcome(r.Outcome),
		})
	}
	return out
}
