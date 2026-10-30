package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

// 工作简报：目标、最新进展、卡点、下一步。每条都带来源与时间。
// 规则：
//   - Agent 通过 report/ask/deliver 写入（kind=agent）；用户在面板填写、更正或确认（kind=user）。
//   - 字段当前值优先取用户条目；之后到来的 Agent 回报不覆盖，作为 pending 供对照。
//   - 被标记有误的 Agent 条目不再显示，也不回退到更早的回报，字段显示为缺失。
//   - Stop、空闲和工具调用不会生成简报内容。
var BriefFields = []string{"goal", "summary", "progress", "blocker", "next", "stage", "next_owner"}

const briefMaxText = 280

func validField(f string) bool {
	for _, x := range BriefFields {
		if x == f {
			return true
		}
	}
	return false
}

type BriefField struct {
	EntryID   int64       `json:"entry_id"`
	Text      string      `json:"text"`
	Kind      string      `json:"kind"`   // agent|user
	Source    string      `json:"source"` // report|ask|deliver|user|confirm
	SessionID *int64      `json:"session_id"`
	At        string      `json:"at"`
	Pending   *BriefField `json:"pending,omitempty"` // 用户条目之后的新 Agent 回报
	// Flagged 为 true 表示最近的 Agent 条目被标记有误、且没有用户条目可用；Text 为空。
	Flagged bool `json:"flagged,omitempty"`
}

type Brief struct {
	Fields map[string]*BriefField `json:"fields"`
	// 各会话独立回报；不把另一个会话的字段拼进自己的下一步。
	BySession       map[int64]*Brief `json:"by_session,omitempty"`
	LastDeliveredAt string           `json:"last_delivered_at,omitempty"`
	InputResolvedAt string           `json:"input_resolved_at,omitempty"`
	// 最近进展之后观察到的工具事件数与最后事件时间；用于“可能过期”提示，不改变内容。
	ToolEventsSince int    `json:"tool_events_since"`
	LastEventAt     string `json:"last_event_at"`
	Stale           bool   `json:"stale"`
}

type briefRow struct {
	id         int64
	item       string
	field      string
	text       string
	kind       string
	source     string
	session    sql.NullInt64
	supersedes int64
	flagged    string
	at         string
}

func (r briefRow) out() *BriefField {
	f := &BriefField{EntryID: r.id, Text: r.text, Kind: r.kind, Source: r.source, At: r.at}
	if r.session.Valid {
		v := r.session.Int64
		f.SessionID = &v
	}
	return f
}

// resolveField 从一个字段按时间升序的全部条目推导当前值。
func resolveField(rows []briefRow) *BriefField {
	var lastAgent, lastUser *briefRow
	for i := range rows {
		r := &rows[i]
		switch {
		case r.kind == "user" && r.flagged == "":
			if lastUser == nil || r.id > lastUser.id {
				lastUser = r
			}
		case r.kind == "agent":
			// 内容时间决定新旧；接收顺序只用于同时间的确定性排序。
			if lastAgent == nil || r.at > lastAgent.at || (r.at == lastAgent.at && r.id > lastAgent.id) {
				lastAgent = r
			}
		}
	}
	agentLive := lastAgent != nil && lastAgent.flagged == ""
	if lastUser != nil {
		if lastUser.text == "" {
			return nil // 用户清除了该字段
		}
		f := lastUser.out()
		if agentLive && lastAgent.id > lastUser.id && lastAgent.at >= lastUser.at && lastAgent.text != "" {
			f.Pending = lastAgent.out()
		}
		return f
	}
	if lastAgent == nil {
		return nil
	}
	if !agentLive {
		return &BriefField{EntryID: lastAgent.id, Kind: "agent", Source: lastAgent.source, At: lastAgent.at, Flagged: true}
	}
	if lastAgent.text == "" {
		return nil
	}
	return lastAgent.out()
}

// itemForSessionAt 按内容产生时的执行关系归属，区间为 [started_at, ended_at)。
// 旧回报补发时不能使用会话当前的工作项。
func itemForSessionAt(tx *sql.Tx, sid int64, at string) (string, error) {
	var item string
	err := tx.QueryRow(`SELECT work_item_id FROM runs WHERE session_id=? AND started_at<=?
		AND (ended_at='' OR ended_at>?) AND outcome<>'attribution_reverted'
		ORDER BY started_at DESC,id DESC LIMIT 1`, sid, at, at).Scan(&item)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return item, err
}

// applyAgentBrief 在事件事务内把 report/ask/deliver 写入简报。会话没有关联工作项时忽略。
func (c *Core) applyAgentBrief(tx *sql.Tx, sid int64, e *event.Event, now string) error {
	fields := map[string]string{}
	source := string(e.Kind)
	switch e.Kind {
	case event.KindReport, event.KindBegin:
		for k, v := range e.Brief {
			if validField(k) {
				fields[k] = v
			}
		}
	case event.KindAsk:
		if strings.TrimSpace(e.Text) != "" {
			fields["blocker"] = e.Text
			fields["next"] = "请回答：" + e.Text
		}
		fields["next_owner"] = "user"
	case event.KindDeliver:
		for k, v := range e.Brief {
			if validField(k) {
				fields[k] = v
			}
		}
		if strings.TrimSpace(e.Text) != "" {
			if _, ok := fields["progress"]; !ok {
				fields["progress"] = e.Text
			}
			if _, ok := fields["summary"]; !ok {
				fields["summary"] = event.Truncate(e.Text, 90)
			}
		}
		fields["stage"], fields["next_owner"] = "review", "user"
		if _, ok := fields["next"]; !ok {
			fields["next"] = "核对交付物和验收条件；需要修改时重新开始本工作项。"
		}
	default:
		return nil
	}
	if len(fields) == 0 {
		return nil
	}
	item, err := itemForSessionAt(tx, sid, store.TS(e.OccurredAt))
	if err != nil || item == "" {
		return err
	}
	var seq int64
	tx.QueryRow(`SELECT seq FROM events WHERE event_id=?`, e.EventID).Scan(&seq)
	at := store.TS(e.OccurredAt)
	for _, k := range BriefFields {
		v, ok := fields[k]
		if !ok {
			continue
		}
		if k == "summary" {
			v = event.Truncate(v, 90)
		}
		if _, err := tx.Exec(`INSERT INTO brief_entries(work_item_id, field, text, kind, source, session_id, event_seq, at, created_at)
			VALUES (?,?,?,?,?,?,?,?,?)`, item, k, clip(v), "agent", source, sid, seq, at, now); err != nil {
			return err
		}
	}
	return store.Touch(tx, now, "work_item", item)
}

func clip(s string) string {
	s = strings.TrimSpace(event.Redact(s))
	r := []rune(s)
	if len(r) > briefMaxText {
		return string(r[:briefMaxText-1]) + "…"
	}
	return s
}

// BriefEdit 是面板对简报的一次操作。
type BriefEdit struct {
	Field   string `json:"field"`
	Action  string `json:"action"` // set|confirm|flag|undo
	Text    string `json:"text"`
	EntryID int64  `json:"entry_id"` // confirm/flag/undo 的目标条目
}

// EditBrief 执行用户操作并返回新条目 id（flag/undo 返回目标条目 id），供撤销使用。
func (c *Core) EditBrief(ctx context.Context, item string, b BriefEdit) (int64, error) {
	if !validField(b.Field) {
		return 0, fmt.Errorf("%w: 未知字段 %q", ErrBadRequest, b.Field)
	}
	if b.Action == "set" && (b.Field == "stage" || b.Field == "next_owner") {
		probe := &event.Event{EventID: "validate", SessionID: "validate", Source: event.Source{Provider: "other"}, OccurredAt: time.Now(), Kind: event.KindReport, Brief: map[string]string{b.Field: b.Text}}
		if err := probe.Validate(); err != nil {
			return 0, fmt.Errorf("%w: %v", ErrBadRequest, err)
		}
	}
	now := c.St.NowTS()
	var out int64
	err := c.panelTx(ctx, func(tx *sql.Tx) error {
		if !itemExists(tx, item) {
			return ErrNotFound
		}
		load := func(id int64) (briefRow, error) {
			var r briefRow
			err := tx.QueryRow(`SELECT id, work_item_id, field, text, kind, source, at, flagged, supersedes FROM brief_entries WHERE id=?`, id).
				Scan(&r.id, &r.item, &r.field, &r.text, &r.kind, &r.source, &r.at, &r.flagged, &r.supersedes)
			if errors.Is(err, sql.ErrNoRows) || (err == nil && (r.item != item || r.field != b.Field)) {
				return r, fmt.Errorf("%w: 简报条目 %d", ErrNotFound, id)
			}
			return r, err
		}
		insertUser := func(text, source, at string, supersedes int64) error {
			res, err := tx.Exec(`INSERT INTO brief_entries(work_item_id, field, text, kind, source, supersedes, at, created_at)
				VALUES (?,?,?,?,?,?,?,?)`, item, b.Field, text, "user", source, supersedes, at, now)
			if err != nil {
				return err
			}
			out, _ = res.LastInsertId()
			return nil
		}
		switch b.Action {
		case "set":
			if err := insertUser(clip(b.Text), "user", now, b.EntryID); err != nil {
				return err
			}
		case "confirm":
			r, err := load(b.EntryID)
			if err != nil {
				return err
			}
			if r.kind != "agent" || r.flagged != "" || r.text == "" {
				return fmt.Errorf("%w: 只能确认未被标记的 Agent 回报", ErrConflict)
			}
			// 保留原内容时间，过期判断仍以内容产生时刻为准
			if err := insertUser(r.text, "confirm", r.at, r.id); err != nil {
				return err
			}
		case "flag":
			r, err := load(b.EntryID)
			if err != nil {
				return err
			}
			if r.kind != "agent" || r.flagged != "" {
				return fmt.Errorf("%w: 只能标记未被标记的 Agent 回报", ErrConflict)
			}
			if _, err := tx.Exec(`UPDATE brief_entries SET flagged='wrong' WHERE id=?`, r.id); err != nil {
				return err
			}
			out = r.id
		case "undo":
			r, err := load(b.EntryID)
			if err != nil {
				return err
			}
			switch {
			case r.kind == "user" && r.flagged == "":
				if _, err := tx.Exec(`UPDATE brief_entries SET flagged='undone' WHERE id=?`, r.id); err != nil {
					return err
				}
			case r.kind == "agent" && r.flagged == "wrong":
				if _, err := tx.Exec(`UPDATE brief_entries SET flagged='' WHERE id=?`, r.id); err != nil {
					return err
				}
			default:
				return fmt.Errorf("%w: 该条目无可撤销的操作", ErrConflict)
			}
			out = r.id
		default:
			return fmt.Errorf("%w: 未知操作 %q", ErrBadRequest, b.Action)
		}
		if _, err := tx.Exec(`UPDATE work_items SET updated_at=? WHERE id=?`, now, item); err != nil {
			return err
		}
		return store.Touch(tx, now, "work_item", item)
	})
	if err == nil {
		c.notify()
	}
	return out, err
}

// BriefHistory 返回某工作项全部简报条目（新到旧），用于追溯纠错。
func (c *Core) BriefHistory(ctx context.Context, item string) ([]map[string]any, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT id, field, text, kind, source, session_id, supersedes, flagged, at, created_at
		FROM brief_entries WHERE work_item_id=? ORDER BY id DESC LIMIT 200`, item)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []map[string]any{}
	for rows.Next() {
		var id, sup int64
		var field, text, kind, source, flagged, at, created string
		var sid sql.NullInt64
		if err := rows.Scan(&id, &field, &text, &kind, &source, &sid, &sup, &flagged, &at, &created); err != nil {
			return nil, err
		}
		m := map[string]any{"id": id, "field": field, "text": text, "kind": kind, "source": source, "supersedes": sup, "flagged": flagged, "at": at, "created_at": created}
		if sid.Valid {
			m["session_id"] = sid.Int64
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// loadBriefs 在快照事务中计算所有工作项的当前简报与过期提示。
func (c *Core) loadBriefs(tx *sql.Tx, status map[string]string) (map[string]*Brief, error) {
	rows, err := tx.Query(`SELECT id, work_item_id, field, text, kind, source, session_id, supersedes, flagged, at
		FROM brief_entries ORDER BY work_item_id, field, id`)
	if err != nil {
		return nil, err
	}
	group := map[string]map[string][]briefRow{}
	for rows.Next() {
		var r briefRow
		if err := rows.Scan(&r.id, &r.item, &r.field, &r.text, &r.kind, &r.source, &r.session, &r.supersedes, &r.flagged, &r.at); err != nil {
			rows.Close()
			return nil, err
		}
		if group[r.item] == nil {
			group[r.item] = map[string][]briefRow{}
		}
		group[r.item][r.field] = append(group[r.item][r.field], r)
	}
	rows.Close()
	out := map[string]*Brief{}
	for item, fs := range group {
		b := &Brief{Fields: map[string]*BriefField{}, BySession: map[int64]*Brief{}}
		var boundary *briefRow
		for i := range fs["stage"] {
			r := &fs["stage"][i]
			if r.source == "reopened" && (boundary == nil || r.at > boundary.at || (r.at == boundary.at && r.id > boundary.id)) {
				boundary = r
			}
		}
		for _, f := range BriefFields {
			entries := fs[f]
			if boundary != nil && f != "goal" {
				entries = nil
				for _, r := range fs[f] {
					if r.at > boundary.at || (r.at == boundary.at && r.id >= boundary.id) {
						entries = append(entries, r)
					}
				}
			}
			var v *BriefField
			if f == "stage" {
				for _, r := range entries {
					if r.source == "deliver" && r.flagged == "" && r.at > b.LastDeliveredAt {
						b.LastDeliveredAt = r.at
					}
				}
			}
			if f == "stage" || f == "next_owner" {
				v = resolveTimelineField(entries)
			} else {
				v = resolveField(entries)
			}
			if v != nil {
				b.Fields[f] = v
			}
			bySession := map[int64][]briefRow{}
			for _, r := range entries {
				if r.kind == "agent" && r.session.Valid {
					bySession[r.session.Int64] = append(bySession[r.session.Int64], r)
				}
			}
			for sid, sourceRows := range bySession {
				if b.BySession[sid] == nil {
					b.BySession[sid] = &Brief{Fields: map[string]*BriefField{}}
				}
				if value := resolveField(sourceRows); value != nil {
					b.BySession[sid].Fields[f] = value
				}
			}
		}
		out[item] = b
	}
	// A response in this same session resolves earlier advisory handoffs only.
	// It does not complete work, accept delivery, or dismiss a peer's request.
	inputs, err := tx.Query(`SELECT session_id,MAX(occurred_at) FROM events WHERE kind='prompt'
		OR (kind='tool_post' AND json_extract(body,'$.source.provider')='claude'
		AND json_extract(body,'$.tool_name') IN ('AskUserQuestion','ExitPlanMode')) GROUP BY session_id`)
	if err != nil {
		return nil, err
	}
	resolved := map[int64]string{}
	for inputs.Next() {
		var sid int64
		var at string
		if err := inputs.Scan(&sid, &at); err != nil {
			inputs.Close()
			return nil, err
		}
		resolved[sid] = at
	}
	err = inputs.Err()
	inputs.Close()
	if err != nil {
		return nil, err
	}
	for _, b := range out {
		for sid, own := range b.BySession {
			own.InputResolvedAt = resolved[sid]
		}
		if owner := b.Fields["next_owner"]; owner != nil && owner.SessionID != nil {
			b.InputResolvedAt = resolved[*owner.SessionID]
		}
	}

	// 按实际展示的进展计数。待对照的新回报不能替置顶的旧进展消除过期提示。
	var values []string
	var args []any
	for item, b := range out {
		if progress := b.Fields["progress"]; progress != nil && progress.Text != "" && !progress.Flagged {
			values = append(values, "(?,?,?)")
			args = append(args, item, 0, progress.At)
		}
		for sid, source := range b.BySession {
			if progress := source.Fields["progress"]; progress != nil && progress.Text != "" && !progress.Flagged {
				values = append(values, "(?,?,?)")
				args = append(args, item, sid, progress.At)
			}
		}
	}
	if len(values) == 0 {
		return out, nil
	}
	rows, err = tx.Query(`WITH p(work_item_id,session_id,at) AS (VALUES `+strings.Join(values, ",")+`)
		SELECT p.work_item_id, p.session_id, COUNT(e.seq), COALESCE(MAX(e.occurred_at),'')
		FROM p JOIN runs r ON r.work_item_id=p.work_item_id AND (p.session_id=0 OR r.session_id=p.session_id)
		JOIN events e ON e.session_id=r.session_id AND e.occurred_at > p.at AND e.occurred_at >= r.started_at
			AND (r.ended_at='' OR e.occurred_at < r.ended_at) AND r.outcome<>'attribution_reverted'
			AND e.kind IN ('tool_post','tool_fail')
		GROUP BY p.work_item_id,p.session_id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item, last string
		var n int
		var sid int64
		if err := rows.Scan(&item, &sid, &n, &last); err != nil {
			return nil, err
		}
		b := out[item]
		if sid != 0 && b != nil {
			b = b.BySession[sid]
		}
		if b == nil || b.Fields["progress"] == nil {
			continue
		}
		b.ToolEventsSince, b.LastEventAt = n, last
		if status[item] == "done" || status[item] == "abandoned" || (sid == 0 && status[item] == "review") || (sid != 0 && b.Fields["stage"] != nil && b.Fields["stage"].Text == "review") {
			continue
		}
		pAt, _ := time.Parse(time.RFC3339Nano, b.Fields["progress"].At)
		lAt, _ := time.Parse(time.RFC3339Nano, last)
		b.Stale = n >= c.BriefStaleEvents || (!pAt.IsZero() && lAt.Sub(pAt) > c.BriefStaleAfter)
	}
	return out, rows.Err()
}

// Stage and responsibility describe the current phase; earlier user edits do
// not pin them forever across subsequent real work. Older content still loses.
func resolveTimelineField(rows []briefRow) *BriefField {
	var latest *briefRow
	for i := range rows {
		r := &rows[i]
		if r.flagged == "undone" {
			continue
		}
		if latest == nil || r.at > latest.at || (r.at == latest.at && r.id > latest.id) {
			latest = r
		}
	}
	if latest == nil || latest.text == "" {
		return nil
	}
	if latest.flagged != "" {
		return &BriefField{EntryID: latest.id, Flagged: true, At: latest.at}
	}
	return latest.out()
}

// SessionHasActiveItem 用于 report 前置检查：会话需要先关联工作项。
func (c *Core) SessionHasActiveItem(ctx context.Context, hostID, provider, providerSessionID string) (string, error) {
	var item string
	err := c.St.R().QueryRowContext(ctx, `SELECT r.work_item_id FROM sessions s JOIN runs r ON r.session_id=s.id AND r.ended_at=''
		WHERE s.host_id=? AND s.provider=? AND s.provider_session_id=? ORDER BY r.id DESC LIMIT 1`, hostID, provider, providerSessionID).Scan(&item)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return item, err
}

// SessionItemAt 用于回报入口校验，允许正确归属已结束 run 的迟到回报。
func (c *Core) SessionItemAt(ctx context.Context, hostID, provider, providerSessionID string, at time.Time) (string, error) {
	var item string
	ts := store.TS(at)
	err := c.St.R().QueryRowContext(ctx, `SELECT r.work_item_id FROM sessions s JOIN runs r ON r.session_id=s.id
 WHERE s.host_id=? AND s.provider=? AND s.provider_session_id=? AND r.started_at<=?
 AND (r.ended_at='' OR r.ended_at>?) AND r.outcome<>'attribution_reverted'
 ORDER BY r.started_at DESC,r.id DESC LIMIT 1`, hostID, provider, providerSessionID, ts, ts).Scan(&item)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return item, err
}
