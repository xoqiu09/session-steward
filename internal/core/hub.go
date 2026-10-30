package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/xoqiu09/session-steward/internal/store"
)

// HubOnlineAfter：超过这么久没收到某台设备的摘要，就标为离线（仍显示最后一次）。
const HubOnlineAfter = 90 * time.Second

// HubSummary 是一台设备推给中心的摘要。只含画小镇需要的字段：
// 不含对话、命令和工具预览、目录路径、恢复命令、审批内容。
type HubSummary struct {
	DeviceID   string    `json:"device_id"`
	DeviceName string    `json:"device_name"`
	SentAt     string    `json:"sent_at"`
	Snapshot   *Snapshot `json:"snapshot"`
	Days       []DayStat `json:"days,omitempty"` // 最近 30 天的历史日历
}

// HubDevice 是合并视图里的一台设备。
type HubDevice struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Self       bool   `json:"self"`
	ReceivedAt string `json:"received_at"`
	Online     bool   `json:"online"`
}

// trimForHub 去掉摘要里不该离开这台电脑的字段。
func trimForHub(s *Snapshot) *Snapshot {
	out := &Snapshot{Cursor: s.Cursor, Now: s.Now, Deps: s.Deps, SignalGapAfterMin: s.SignalGapAfterMin}
	for _, r := range s.Repos {
		out.Repos = append(out.Repos, Repo{ID: r.ID, Name: r.Name, IsGit: r.IsGit})
	}
	for _, x := range s.Sessions {
		out.Sessions = append(out.Sessions, Session{
			ID: x.ID, Provider: x.Provider, Client: x.Client, RepoID: x.RepoID, State: x.State, DataSource: x.DataSource, Freshness: x.Freshness,
			FirstSeenAt: x.FirstSeenAt, LastActivityAt: x.LastActivityAt, LastProgressAt: x.LastProgressAt, WorkItemID: x.WorkItemID, Binding: x.Binding,
			Title: x.Title, TitleSource: x.TitleSource, Signal: publicSignal(x.Signal),
		})
	}
	for _, w := range s.WorkItems {
		var management *WorkManagement
		if w.Management != nil {
			management = &WorkManagement{State: w.Management.State, At: w.Management.At}
		}
		out.WorkItems = append(out.WorkItems, WorkItem{
			ID: w.ID, RepoID: w.RepoID, Title: w.Title, Status: w.Status, MergeState: w.MergeState, NeedsMerge: w.NeedsMerge,
			CreatedAt: w.CreatedAt, UpdatedAt: w.UpdatedAt, Ready: w.Ready, Waiting: w.Waiting, Agents: w.Agents,
			CompletionPolicy: w.CompletionPolicy, AutomaticHistory: w.AutomaticHistory,
			Management: management, Signal: publicSignal(w.Signal),
		})
	}
	out.Runs = append(out.Runs, s.Runs...)
	for _, a := range s.Approvals {
		out.Approvals = append(out.Approvals, Approval{
			ID: a.ID, Kind: a.Kind, Status: a.Status, SessionID: a.SessionID, WorkItemID: a.WorkItemID, RepoID: a.RepoID,
			ToolName: a.ToolName, CreatedAt: a.CreatedAt, ClosedAt: a.ClosedAt, Payload: json.RawMessage("null"),
		})
	}
	return out
}

// HubLocalSummary 生成这台设备要推给中心的摘要。
func (c *Core) HubLocalSummary(ctx context.Context, deviceID, name string, withDays bool) (HubSummary, error) {
	snap, err := c.Snapshot(ctx)
	if err != nil {
		return HubSummary{}, err
	}
	sum := HubSummary{DeviceID: deviceID, DeviceName: name, SentAt: c.St.NowTS(), Snapshot: trimForHub(snap)}
	if withDays {
		if h, err := c.History(ctx, 30, c.UsageDetail != nil); err == nil {
			sum.Days = h.Days
		}
	}
	return sum, nil
}

// HubStore 中心机保存一台设备推来的摘要（覆盖上一次）。
func (c *Core) HubStore(ctx context.Context, sum HubSummary) error {
	if sum.DeviceID == "" || len(sum.DeviceID) > 80 || sum.Snapshot == nil {
		return fmt.Errorf("%w: 摘要缺少设备编号或快照", ErrBadRequest)
	}
	if sum.DeviceName == "" {
		sum.DeviceName = sum.DeviceID
	}
	b, err := json.Marshal(sum)
	if err != nil {
		return err
	}
	now := c.St.NowTS()
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO hub_devices(device_id,name,received_at,body) VALUES(?,?,?,?)
			ON CONFLICT(device_id) DO UPDATE SET name=excluded.name,received_at=excluded.received_at,body=excluded.body`, sum.DeviceID, sum.DeviceName, now, string(b)); err != nil {
			return err
		}
		return store.Touch(tx, now, "hub", sum.DeviceID)
	})
}

// HubMerged 中心机把自己和各设备的摘要合成一张快照。本机的编号不变（点开仍能看详情）；
// 其他设备的编号加前缀或偏移，避免撞号；项目带上设备名。selfID 为中心机自己的设备编号。
func (c *Core) HubMerged(ctx context.Context, selfID, selfName string) (*Snapshot, error) {
	others, err := c.HubOthers(ctx, selfID, selfName, selfID)
	if err != nil {
		return nil, err
	}
	return c.HubCombine(ctx, selfID, selfName, others)
}

// HubOthers 中心机替一台设备（viewerID）准备“除它以外”的部分：中心机自己和其余设备的摘要，
// 按设备名排序，编号一律加前缀或偏移，都不标为本机。那台设备再用 HubCombine 接上自己的数据，
// 这样每台看到的“本机”都是它自己。viewerID 等于中心机自己时，就是其余各台。
func (c *Core) HubOthers(ctx context.Context, hubID, hubName, viewerID string) (*Snapshot, error) {
	type part struct {
		id, name, at string
		online       bool
		snap         *Snapshot
	}
	var parts []part
	if viewerID != hubID {
		sum, err := c.HubLocalSummary(ctx, hubID, hubName, false)
		if err != nil {
			return nil, err
		}
		parts = append(parts, part{hubID, hubName, sum.SentAt, true, sum.Snapshot})
	}
	rows, err := c.St.R().QueryContext(ctx, `SELECT device_id, name, received_at, body FROM hub_devices WHERE device_id<>? AND device_id<>? ORDER BY name, device_id`, hubID, viewerID)
	if err != nil {
		return nil, err
	}
	type dev struct{ id, name, at, body string }
	var devs []dev
	for rows.Next() {
		var d dev
		if err := rows.Scan(&d.id, &d.name, &d.at, &d.body); err != nil {
			rows.Close()
			return nil, err
		}
		devs = append(devs, d)
	}
	rows.Close()
	now := c.St.Now()
	for _, d := range devs {
		var sum HubSummary
		if json.Unmarshal([]byte(d.body), &sum) != nil || sum.Snapshot == nil {
			continue
		}
		at, _ := time.Parse(time.RFC3339Nano, d.at)
		parts = append(parts, part{d.id, d.name, d.at, now.Sub(at) <= HubOnlineAfter, sum.Snapshot})
	}
	// 偏移倍数按设备列表的顺序给：界面用“第几台非本机设备”认出编号属于谁
	sort.SliceStable(parts, func(a, b int) bool { return parts[a].name < parts[b].name })
	out := &Snapshot{}
	for i, p := range parts {
		out.Devices = append(out.Devices, HubDevice{ID: p.id, Name: p.name, ReceivedAt: p.at, Online: p.online})
		addSnap(out, p.snap, p.name, int64(i+1)*hubIDStride, p.name+":")
	}
	return out, nil
}

// HubCombine 把本机摘要放在最前面（编号不变、标为本机），接上 HubOthers 给的其余部分。
func (c *Core) HubCombine(ctx context.Context, selfID, selfName string, others *Snapshot) (*Snapshot, error) {
	self, err := c.HubLocalSummary(ctx, selfID, selfName, false)
	if err != nil {
		return nil, err
	}
	merged := &Snapshot{Cursor: self.Snapshot.Cursor, Now: self.Snapshot.Now, SignalGapAfterMin: self.Snapshot.SignalGapAfterMin}
	merged.Devices = append(merged.Devices, HubDevice{ID: selfID, Name: selfName, Self: true, ReceivedAt: self.SentAt, Online: true})
	addSnap(merged, self.Snapshot, selfName, 0, "")
	merged.Devices = append(merged.Devices, others.Devices...)
	merged.Repos = append(merged.Repos, others.Repos...)
	merged.Sessions = append(merged.Sessions, others.Sessions...)
	merged.WorkItems = append(merged.WorkItems, others.WorkItems...)
	merged.Deps = append(merged.Deps, others.Deps...)
	merged.Runs = append(merged.Runs, others.Runs...)
	merged.Approvals = append(merged.Approvals, others.Approvals...)
	return merged, nil
}

// hubIDStride：其他设备的数字编号加上这个倍数，界面据此认出“不是本机的”。
const hubIDStride = 1_000_000_000

func addSnap(dst, src *Snapshot, device string, off int64, prefix string) {
	shift := func(p *int64) *int64 {
		if p == nil {
			return nil
		}
		v := *p + off
		return &v
	}
	pre := func(s string) string {
		if s == "" {
			return ""
		}
		return prefix + s
	}
	for _, r := range src.Repos {
		r.ID += off
		r.Device = device
		dst.Repos = append(dst.Repos, r)
	}
	for _, s := range src.Sessions {
		s.ID += off
		s.RepoID = shift(s.RepoID)
		s.WorkItemID = pre(s.WorkItemID)
		dst.Sessions = append(dst.Sessions, s)
	}
	for _, w := range src.WorkItems {
		w.ID = pre(w.ID)
		w.RepoID = shift(w.RepoID)
		for i := range w.Waiting {
			w.Waiting[i] = pre(w.Waiting[i])
		}
		dst.WorkItems = append(dst.WorkItems, w)
	}
	for _, d := range src.Deps {
		d.Upstream, d.Downstream = pre(d.Upstream), pre(d.Downstream)
		dst.Deps = append(dst.Deps, d)
	}
	for _, r := range src.Runs {
		r.ID += off
		r.SessionID += off
		r.WorkItemID = pre(r.WorkItemID)
		dst.Runs = append(dst.Runs, r)
	}
	for _, a := range src.Approvals {
		a.ID = pre(a.ID)
		a.SessionID = shift(a.SessionID)
		a.RepoID = shift(a.RepoID)
		if a.WorkItemID != nil {
			v := pre(*a.WorkItemID)
			a.WorkItemID = &v
		}
		dst.Approvals = append(dst.Approvals, a)
	}
}
