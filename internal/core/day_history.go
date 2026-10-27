package core

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/xoqiu09/session-steward/internal/usage"
)

// DetailSource 返回会话按天、按模型、按轮的 token 明细和子 Agent。只读数字、模型名、时间和子 Agent 的一句说明。
type DetailSource interface {
	Detail(provider, sessionID string, loc *time.Location) (self usage.Detail, subs []usage.Subagent, withSubs usage.Detail, ok bool)
}

// dayMod 把 UTC 时间戳换成本地日期：SQLite 的 date(x, '+480 minutes')。夏令时切换当天可能差一小时，可以接受。
func dayMod(t time.Time) string {
	_, off := t.Zone()
	return fmt.Sprintf("%+d minutes", off/60)
}

// archiveDaily 把会话（含子 Agent）的按天用量写进 usage_daily。已有的日子用新数字覆盖，记录里已经没有的日子保留不动。
func (c *Core) archiveDaily(ctx context.Context, src DetailSource, id int64, provider, sid string) (bool, error) {
	_, _, all, ok := src.Detail(provider, sid, time.Local)
	if !ok {
		return false, nil
	}
	changed := false
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		for day, models := range all.ByDay {
			for model, t := range models {
				res, err := tx.Exec(`INSERT INTO usage_daily(session_id,day,model,input,output,cache_read,cache_write) VALUES(?,?,?,?,?,?,?)
					ON CONFLICT(session_id,day,model) DO UPDATE SET input=excluded.input,output=excluded.output,cache_read=excluded.cache_read,cache_write=excluded.cache_write
					WHERE input<>excluded.input OR output<>excluded.output OR cache_read<>excluded.cache_read OR cache_write<>excluded.cache_write`,
					id, day, model, t.Input, t.Output, t.CacheRead, t.CacheWrite)
				if err != nil {
					return err
				}
				if n, _ := res.RowsAffected(); n > 0 {
					changed = true
				}
			}
		}
		return nil
	})
	return changed, err
}

// DayStat 是历史日历里的一天。Tokens 只在开启用量统计后才有。
type DayStat struct {
	Day        string           `json:"day"`
	Tokens     usage.Totals     `json:"tokens"`
	ByProvider map[string]int64 `json:"by_provider"`
	ByModel    map[string]int64 `json:"by_model"`
	Sessions   int              `json:"sessions"`
	Prompts    int              `json:"prompts"`
	Tools      int              `json:"tools"`
	Subagents  int              `json:"subagents"`
	Delivered  int              `json:"delivered"`
	Accepted   int              `json:"accepted"`
	Returned   int              `json:"returned"`
	Blocked    int              `json:"blocked"`
	Failed     int              `json:"failed"`
}

type History struct {
	From          string    `json:"from"`
	To            string    `json:"to"`
	TokensEnabled bool      `json:"tokens_enabled"`
	Days          []DayStat `json:"days"`
}

func tokenSum(t usage.Totals) int64 { return t.Input + t.Output + t.CacheRead + t.CacheWrite }

// History 汇总最近 days 天（含今天）每天的活动、交付、验收和 token。只读本机数据库。
func (c *Core) History(ctx context.Context, days int, tokensEnabled bool) (History, error) {
	if days < 1 || days > 400 {
		days = 370
	}
	now := c.St.Now().In(time.Local)
	mod := dayMod(now)
	to := now.Format("2006-01-02")
	fromDay := now.AddDate(0, 0, -(days - 1)).Format("2006-01-02")
	// 起点放宽一天，避免时区差把第一天切掉；最后按本地日期过滤。
	since := now.AddDate(0, 0, -days).UTC().Format("2006-01-02")
	byDay := map[string]*DayStat{}
	get := func(d string) *DayStat {
		if byDay[d] == nil {
			byDay[d] = &DayStat{Day: d, ByProvider: map[string]int64{}, ByModel: map[string]int64{}}
		}
		return byDay[d]
	}
	r := c.St.R()
	rows, err := r.QueryContext(ctx, `SELECT date(substr(occurred_at,1,19), ?) AS d, COUNT(DISTINCT session_id),
		SUM(kind='prompt'), SUM(kind='tool_post' OR kind='tool_fail'), SUM(kind='subagent_start')
		FROM events WHERE occurred_at >= ? GROUP BY d`, mod, since)
	if err != nil {
		return History{}, err
	}
	for rows.Next() {
		var d string
		var s, p, t, sub sql.NullInt64
		if err := rows.Scan(&d, &s, &p, &t, &sub); err != nil {
			rows.Close()
			return History{}, err
		}
		x := get(d)
		x.Sessions, x.Prompts, x.Tools, x.Subagents = int(s.Int64), int(p.Int64), int(t.Int64), int(sub.Int64)
	}
	rows.Close()
	rows, err = r.QueryContext(ctx, `SELECT date(substr(at,1,19), ?) AS d,
		SUM(status='review' AND old_status<>'review'), SUM(status='done' AND old_status<>'done'),
		SUM(old_status='review' AND status='in_progress'), SUM(status='blocked' AND old_status<>'blocked')
		FROM work_item_state_changes WHERE at >= ? GROUP BY d`, mod, since)
	if err != nil {
		return History{}, err
	}
	for rows.Next() {
		var d string
		var dl, ac, rt, bl sql.NullInt64
		if err := rows.Scan(&d, &dl, &ac, &rt, &bl); err != nil {
			rows.Close()
			return History{}, err
		}
		x := get(d)
		x.Delivered, x.Accepted, x.Returned, x.Blocked = int(dl.Int64), int(ac.Int64), int(rt.Int64), int(bl.Int64)
	}
	rows.Close()
	rows, err = r.QueryContext(ctx, `SELECT date(substr(ended_at,1,19), ?) AS d, COUNT(*) FROM runs
		WHERE outcome='failed' AND ended_at >= ? GROUP BY d`, mod, since)
	if err != nil {
		return History{}, err
	}
	for rows.Next() {
		var d string
		var n int
		if err := rows.Scan(&d, &n); err != nil {
			rows.Close()
			return History{}, err
		}
		get(d).Failed = n
	}
	rows.Close()
	if tokensEnabled {
		rows, err = r.QueryContext(ctx, `SELECT u.day, s.provider, u.model, SUM(u.input), SUM(u.output), SUM(u.cache_read), SUM(u.cache_write)
			FROM usage_daily u JOIN sessions s ON s.id=u.session_id
			WHERE u.day >= ? AND u.model<>'<synthetic>' AND u.input+u.output+u.cache_read+u.cache_write > 0 GROUP BY u.day, s.provider, u.model`, fromDay)
		if err != nil {
			return History{}, err
		}
		for rows.Next() {
			var d, provider, model string
			var t usage.Totals
			if err := rows.Scan(&d, &provider, &model, &t.Input, &t.Output, &t.CacheRead, &t.CacheWrite); err != nil {
				rows.Close()
				return History{}, err
			}
			x := get(d)
			x.Tokens.Input += t.Input
			x.Tokens.Output += t.Output
			x.Tokens.CacheRead += t.CacheRead
			x.Tokens.CacheWrite += t.CacheWrite
			x.ByProvider[provider] += tokenSum(t)
			x.ByModel[model] += tokenSum(t)
		}
		rows.Close()
	}
	out := History{From: fromDay, To: to, TokensEnabled: tokensEnabled, Days: []DayStat{}}
	for d := now.AddDate(0, 0, -(days - 1)); d.Format("2006-01-02") <= to; d = d.AddDate(0, 0, 1) {
		key := d.Format("2006-01-02")
		if x := byDay[key]; x != nil {
			out.Days = append(out.Days, *x)
		}
	}
	return out, nil
}

// DayItem 是某天状态变过的工作项，Changes 按时间先后。
type DayItem struct {
	ID      string      `json:"id"`
	Title   string      `json:"title"`
	RepoID  *int64      `json:"repo_id"`
	Changes []DayChange `json:"changes"`
}

type DayChange struct {
	From string `json:"from"`
	To   string `json:"to"`
	At   string `json:"at"`
}

// DaySession 是某天有活动的会话：几轮对话、几次工具、几个子 Agent、多少 token。
type DaySession struct {
	ID        int64        `json:"id"`
	Provider  string       `json:"provider"`
	RepoID    *int64       `json:"repo_id"`
	WorkItem  string       `json:"work_item_id"`
	First     string       `json:"first"`
	Last      string       `json:"last"`
	Prompts   int          `json:"prompts"`
	Tools     int          `json:"tools"`
	Failed    int          `json:"tool_failed"`
	Subagents int          `json:"subagents"`
	Tokens    usage.Totals `json:"tokens"`
}

type DayDetail struct {
	Day      string       `json:"day"`
	Items    []DayItem    `json:"items"`
	Sessions []DaySession `json:"sessions"`
}

// HistoryDay 返回某个本地日期里状态变过的工作项和有活动的会话。
func (c *Core) HistoryDay(ctx context.Context, day string, tokensEnabled bool) (DayDetail, error) {
	d, err := time.ParseInLocation("2006-01-02", day, time.Local)
	if err != nil {
		return DayDetail{}, fmt.Errorf("%w: 日期格式应为 YYYY-MM-DD", ErrBadRequest)
	}
	mod := dayMod(d)
	lo := d.AddDate(0, 0, -1).UTC().Format("2006-01-02")
	hi := d.AddDate(0, 0, 2).UTC().Format("2006-01-02")
	out := DayDetail{Day: day, Items: []DayItem{}, Sessions: []DaySession{}}
	r := c.St.R()
	rows, err := r.QueryContext(ctx, `SELECT c.work_item_id, w.title, w.repo_id, c.old_status, c.status, c.at
		FROM work_item_state_changes c JOIN work_items w ON w.id=c.work_item_id
		WHERE c.at >= ? AND c.at < ? AND date(substr(c.at,1,19), ?) = ? AND c.old_status<>c.status ORDER BY c.at`, lo, hi, mod, day)
	if err != nil {
		return DayDetail{}, err
	}
	idx := map[string]int{}
	for rows.Next() {
		var id, title, from, to, at string
		var repo sql.NullInt64
		if err := rows.Scan(&id, &title, &repo, &from, &to, &at); err != nil {
			rows.Close()
			return DayDetail{}, err
		}
		i, ok := idx[id]
		if !ok {
			it := DayItem{ID: id, Title: title, Changes: []DayChange{}}
			if repo.Valid {
				v := repo.Int64
				it.RepoID = &v
			}
			out.Items = append(out.Items, it)
			i = len(out.Items) - 1
			idx[id] = i
		}
		out.Items[i].Changes = append(out.Items[i].Changes, DayChange{From: from, To: to, At: at})
	}
	rows.Close()
	rows, err = r.QueryContext(ctx, `SELECT e.session_id, s.provider, s.repo_id, COALESCE((SELECT r.work_item_id FROM runs r WHERE r.session_id=s.id ORDER BY r.started_at DESC LIMIT 1),''), MIN(e.occurred_at), MAX(e.occurred_at),
		SUM(e.kind='prompt'), SUM(e.kind='tool_post' OR e.kind='tool_fail'), SUM(e.kind='tool_fail'), SUM(e.kind='subagent_start')
		FROM events e JOIN sessions s ON s.id=e.session_id
		WHERE e.occurred_at >= ? AND e.occurred_at < ? AND date(substr(e.occurred_at,1,19), ?) = ?
		GROUP BY e.session_id ORDER BY MAX(e.occurred_at) DESC`, lo, hi, mod, day)
	if err != nil {
		return DayDetail{}, err
	}
	sidx := map[int64]int{}
	for rows.Next() {
		var x DaySession
		var repo sql.NullInt64
		if err := rows.Scan(&x.ID, &x.Provider, &repo, &x.WorkItem, &x.First, &x.Last, &x.Prompts, &x.Tools, &x.Failed, &x.Subagents); err != nil {
			rows.Close()
			return DayDetail{}, err
		}
		if repo.Valid {
			v := repo.Int64
			x.RepoID = &v
		}
		sidx[x.ID] = len(out.Sessions)
		out.Sessions = append(out.Sessions, x)
	}
	rows.Close()
	if tokensEnabled {
		rows, err = r.QueryContext(ctx, `SELECT session_id, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write) FROM usage_daily WHERE day=? AND model<>'<synthetic>' GROUP BY session_id`, day)
		if err != nil {
			return DayDetail{}, err
		}
		for rows.Next() {
			var id int64
			var t usage.Totals
			if err := rows.Scan(&id, &t.Input, &t.Output, &t.CacheRead, &t.CacheWrite); err != nil {
				rows.Close()
				return DayDetail{}, err
			}
			if i, ok := sidx[id]; ok {
				out.Sessions[i].Tokens = t
			}
		}
		rows.Close()
	}
	return out, nil
}

// SessionUsageDetail 是会话详情里的“消耗”：会话自身按模型、按轮，加上子 Agent。打开时现读本地记录，不另存。
type SessionUsageDetail struct {
	Enabled   bool             `json:"enabled"`
	Found     bool             `json:"found"`
	Self      usage.Detail     `json:"self"`
	Subagents []usage.Subagent `json:"subagents"`
	WithSubs  usage.Totals     `json:"with_subagents"`
}

func (c *Core) SessionUsage(ctx context.Context, id int64) (SessionUsageDetail, error) {
	if c.UsageDetail == nil {
		return SessionUsageDetail{Subagents: []usage.Subagent{}}, nil
	}
	var provider, sid string
	if err := c.St.R().QueryRowContext(ctx, `SELECT provider, provider_session_id FROM sessions WHERE id=?`, id).Scan(&provider, &sid); err != nil {
		if err == sql.ErrNoRows {
			return SessionUsageDetail{}, fmt.Errorf("%w: 会话不存在", ErrNotFound)
		}
		return SessionUsageDetail{}, err
	}
	self, subs, all, ok := c.UsageDetail.Detail(provider, sid, time.Local)
	if !ok {
		return SessionUsageDetail{Enabled: true, Subagents: []usage.Subagent{}}, nil
	}
	self.ByDay = nil // 会话页只要按模型和按轮
	return SessionUsageDetail{Enabled: true, Found: true, Self: self, Subagents: subs, WithSubs: all.Total}, nil
}
