package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/store"
)

// Alert 是一条“需要你”推送。Body 只含类别和编号，不含命令预览或对话内容。
type Alert struct {
	Key   string
	Title string
	Body  string
	Link  string
	// RemoteLink 是远程面板上的同一深链；未开启远程访问时为空。
	RemoteLink string
}

// Sender 把推送送到某个渠道（macOS 通知、ntfy）。
type Sender interface {
	Send(ctx context.Context, a Alert) error
}

// Notifier 在每次状态变化后检查新的“需要你”条目，按 key 去重后推送。
// 只推送启动之后出现的条目，避免重启时把旧条目重新弹一遍。
type Notifier struct {
	C             *Core
	Senders       []Sender
	BaseURL       string // 面板地址，例如 http://127.0.0.1:7788
	RemoteBaseURL string // 远程面板地址（可选）
	Debounce      time.Duration
	since         string
}

func (n *Notifier) link(frag string) string { return n.BaseURL + "/#" + frag }

// Run 阻塞直到 ctx 结束。
func (n *Notifier) Run(ctx context.Context) {
	if n.since == "" {
		n.since = n.C.St.NowTS()
	}
	if n.Debounce == 0 {
		n.Debounce = 300 * time.Millisecond
	}
	ch, cancel := n.C.Subscribe()
	defer cancel()
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ch:
			time.Sleep(n.Debounce)
		case <-tick.C:
		}
		if err := n.Check(ctx); err != nil && ctx.Err() == nil {
			log.Printf("推送检查失败: %v", err)
		}
	}
}

// Pending 返回尚未推送的条目（不标记已发送）。
func (n *Notifier) Pending(ctx context.Context) ([]Alert, error) {
	if n.since == "" {
		n.since = n.C.St.NowTS()
	}
	db := n.C.St.R()
	automatic := map[string]WorkItem{}
	if len(n.C.AutomaticMemoryProjects) > 0 {
		snap, err := n.C.Snapshot(ctx)
		if err != nil {
			return nil, err
		}
		for _, w := range snap.WorkItems {
			if w.CompletionPolicy == "auto_history" {
				automatic[w.ID] = w
			}
		}
	}
	var out []Alert
	add := func(a Alert) {
		if n.RemoteBaseURL != "" && strings.HasPrefix(a.Link, n.BaseURL) {
			a.RemoteLink = n.RemoteBaseURL + strings.TrimPrefix(a.Link, n.BaseURL)
		}
		var x int
		db.QueryRowContext(ctx, `SELECT COUNT(1) FROM notify_sent WHERE key=?`, a.Key).Scan(&x)
		if x == 0 {
			out = append(out, a)
		}
	}
	itemLabel := func(item sql.NullString, sid sql.NullInt64) string {
		if item.Valid && item.String != "" {
			return item.String
		}
		if sid.Valid {
			return fmt.Sprintf("会话 #%d", sid.Int64)
		}
		return "未关联条目"
	}
	rows, err := db.QueryContext(ctx, `SELECT a.id,a.kind,a.work_item_id,a.session_id,COALESCE(r.work_item_id,'') FROM approvals a
		LEFT JOIN runs r ON r.session_id=a.session_id AND r.ended_at=''
		WHERE a.status='pending' AND a.created_at>? AND ((a.kind='permission' AND a.handleable=1) OR a.kind='decision')`, n.since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, kind, runItem string
		var item sql.NullString
		var sid sql.NullInt64
		if err := rows.Scan(&id, &kind, &item, &sid, &runItem); err != nil {
			rows.Close()
			return nil, err
		}
		if !item.Valid || item.String == "" {
			item = sql.NullString{String: runItem, Valid: runItem != ""}
		}
		title := "需要你：工具权限"
		if kind == "decision" {
			title = "需要你：做决定"
		}
		add(Alert{Key: "approval:" + id, Title: title, Body: itemLabel(item, sid) + " 正在等待处理", Link: n.link("approval=" + url.QueryEscape(id))})
	}
	rows.Close()

	// 与面板一致：早于最新重开边界的交接属于上一轮，迟到写入也不推送。
	rows, err = db.QueryContext(ctx, `SELECT b.id,b.work_item_id,w.status,b.source,
	 COALESCE((SELECT v FROM meta WHERE k='work_management:'||w.id),'') FROM brief_entries b JOIN work_items w ON w.id=b.work_item_id
		WHERE b.field='next_owner' AND b.text='user' AND b.kind='agent' AND b.flagged='' AND b.created_at>?
		AND w.status NOT IN ('done','abandoned')
		AND NOT EXISTS (SELECT 1 FROM brief_entries newer WHERE newer.work_item_id=b.work_item_id
		  AND newer.session_id IS b.session_id AND newer.field='next_owner' AND newer.flagged=''
		  AND (newer.at>b.at OR (newer.at=b.at AND newer.id>b.id)))
		AND NOT EXISTS (SELECT 1 FROM brief_entries ro WHERE ro.work_item_id=b.work_item_id
		  AND ro.field='stage' AND ro.source='reopened'
		  AND (ro.at>b.at OR (ro.at=b.at AND ro.id>b.id)))`, n.since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		var item, status, source, management string
		if err := rows.Scan(&id, &item, &status, &source, &management); err != nil {
			rows.Close()
			return nil, err
		}
		var m WorkManagement
		if json.Unmarshal([]byte(management), &m) == nil && (m.State == "paused" || m.State == "delegated") {
			continue
		}
		if _, ok := automatic[item]; ok {
			// Routine routing/summary reports are not user decisions. Explicit
			// questions have their own formal approval notification above.
			continue
		}
		title, body := "需要你：接手下一步", item+" 的 Agent 回报下一步由你处理"
		if status == "review" {
			title, body = "交付待你验收", item+" 已提交交付；打开后可验收通过或退回修改"
		}
		add(Alert{Key: fmt.Sprintf("brief:%d", id), Title: title, Body: body, Link: n.link("item=" + url.QueryEscape(item))})
	}
	rows.Close()

	rows, err = db.QueryContext(ctx, `SELECT s.id,s.state,s.state_at,COALESCE(r.work_item_id,'') FROM sessions s
		LEFT JOIN runs r ON r.session_id=s.id AND r.ended_at=''
		WHERE s.data_source='live' AND s.state IN ('error','interrupted') AND s.state_at>?`, n.since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var sid int64
		var state, at, item string
		if err := rows.Scan(&sid, &state, &at, &item); err != nil {
			rows.Close()
			return nil, err
		}
		title := "需要你：会话出错"
		if state == "interrupted" {
			title = "需要你：会话已中断"
		}
		label := fmt.Sprintf("会话 #%d", sid)
		if item != "" {
			label = item + " · " + label
		}
		add(Alert{Key: fmt.Sprintf("session:%d:%s:%s", sid, state, at), Title: title, Body: label, Link: n.link(fmt.Sprintf("session=%d", sid))})
	}
	rows.Close()

	rows, err = db.QueryContext(ctx, `SELECT id,work_item_id,state,exit_code,updated_at FROM managed_sessions
		WHERE (state='failed' OR (state='exited' AND COALESCE(exit_code,0)<>0)) AND updated_at>?`, n.since)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, item, state, at string
		var code sql.NullInt64
		if err := rows.Scan(&id, &item, &state, &code, &at); err != nil {
			rows.Close()
			return nil, err
		}
		add(Alert{Key: "managed:" + id + ":" + state, Title: "需要你：托管会话异常退出", Body: item + " 的托管会话已停止运行", Link: n.link("item=" + url.QueryEscape(item))})
	}
	rows.Close()
	for _, w := range automatic {
		// Formal decisions and session failures already have their own alert above/below.
		if w.AutomaticIssueAt <= n.since || w.AutomaticIssue == "" || w.AutomaticIssueKind == "formal" || w.AutomaticIssueKind == "session" {
			continue
		}
		add(Alert{Key: "routine:" + w.ID + ":" + w.AutomaticIssueKind + ":" + w.AutomaticIssueAt, Title: "自动任务需要检查", Body: w.ID + " 出现卡点、验证失败或长时间无新活动", Link: n.link("item=" + url.QueryEscape(w.ID))})
	}
	return n.C.visibleProjectAlerts(ctx, out)
}

// Check 推送新的条目。先记为已发送再推送：宁可漏一条（面板队列仍在），不重复轰炸。
func (n *Notifier) Check(ctx context.Context) error {
	alerts, err := n.Pending(ctx)
	if err != nil {
		return err
	}
	for _, a := range alerts {
		fresh := false
		err := n.C.St.Tx(ctx, func(tx *sql.Tx) error {
			res, err := tx.Exec(`INSERT INTO notify_sent(key,at) VALUES(?,?) ON CONFLICT(key) DO NOTHING`, a.Key, n.C.St.NowTS())
			if err != nil {
				return err
			}
			k, _ := res.RowsAffected()
			fresh = k > 0
			return nil
		})
		if err != nil {
			return err
		}
		if !fresh {
			continue
		}
		for _, s := range n.Senders {
			if err := s.Send(ctx, a); err != nil {
				log.Printf("推送失败（%T）: %v", s, err)
			}
		}
	}
	// 只保留最近 7 天的去重记录
	return n.C.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`DELETE FROM notify_sent WHERE at < ?`, store.TS(n.C.St.Now().Add(-7*24*time.Hour)))
		return err
	})
}
