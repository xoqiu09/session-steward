// Package core 实现事件落库、四类对象状态机、归属与审批规则。
package core

import (
	"context"
	"database/sql"
	"sync"
	"time"

	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/store"
)

// Locator 抽象 Git 定位，测试时可替换。
type Locator interface {
	Locate(ctx context.Context, cwd string) gitx.Location
}

type Core struct {
	St  *store.Store
	Loc Locator

	// StaleAfter：运行中但超过该时长没有事件，界面显示“长时间无活动”。
	StaleAfter time.Duration
	// 简报“可能过期”：最近进展之后的工具事件数或持续时长超过阈值。
	BriefStaleEvents int
	BriefStaleAfter  time.Duration

	// 托管会话：Agents 为面板可启动的 Agent 名→命令（只来自服务配置）。Term 为 nil 时不可启动。
	Agents       map[string]AgentSpec
	Term         Terminal
	StewardHome  string
	ManagedEnv   []string
	WorktreeRoot string
	launchMu     sync.Mutex
	// 检查门合并：仓库名或 common dir → 检查命令；AutoMerge 时批准后自动运行。
	Checks       map[string][][]string
	AutoMerge    bool
	CheckTimeout time.Duration
	JobContext   context.Context // 服务退出时取消检查；测试可省略。
	jobs         sync.WaitGroup
	// AI 摘要（默认关闭）：本机命令与允许的仓库；SummaryRun 供测试替换。
	SummaryCmd              []string
	SummaryRepos            []string
	AutomaticMemoryProjects []string
	SummaryRun              func(ctx context.Context, argv []string, stdin string) (string, error)
	// UsageDetail 为 nil 时不读 token 明细（用量统计默认关闭）。
	UsageDetail DetailSource
	jobMu       sync.Mutex
	jobsClosing bool
	mergeMu     sync.Mutex // 批准/撤回、扫描与最终更新 Git 在服务内串行。
	mergeSyncMu sync.Mutex // 网络核对不占用 mergeMu 或数据库事务。

	mu      sync.Mutex
	waiters map[string]chan Decision // 等待中的权限请求，key 为 approval id
	subs    map[chan struct{}]struct{}
}

func New(st *store.Store, loc Locator) *Core {
	return &Core{
		St:               st,
		Loc:              loc,
		StaleAfter:       10 * time.Minute,
		BriefStaleEvents: 20,
		BriefStaleAfter:  60 * time.Minute,
		waiters:          map[string]chan Decision{},
		subs:             map[chan struct{}]struct{}{},
	}
}

// Subscribe 返回一个变更通知通道；有新变更时非阻塞地发送信号。
func (c *Core) Subscribe() (ch chan struct{}, cancel func()) {
	ch = make(chan struct{}, 1)
	c.mu.Lock()
	c.subs[ch] = struct{}{}
	c.mu.Unlock()
	return ch, func() {
		c.mu.Lock()
		delete(c.subs, ch)
		c.mu.Unlock()
	}
}

func (c *Core) notify() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for ch := range c.subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// Startup 在服务启动时调用：重启前未完成的权限请求全部失效。
func (c *Core) Startup(ctx context.Context) error {
	if err := c.ReconcileRepos(ctx); err != nil {
		return err
	}
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.Exec(`UPDATE approvals SET status='expired', close_reason='server_restart', closed_at=?
			WHERE kind='permission' AND handleable=1 AND status IN ('pending','decided')`, now)
		if err != nil {
			return err
		}
		if err := reconcileLegacyNativePermissions(tx, now); err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			return store.Touch(tx, now, "approval", "")
		}
		return nil
	})
	c.notify()
	return err
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullInt(n int64) any {
	if n == 0 {
		return nil
	}
	return n
}
