package core

import (
	"context"

	"github.com/xoqiu09/session-steward/internal/store"
)

// LatestClaudeVersion 直接使用 Core 已有只读连接，不扫描历史或重开数据库。
func (c *Core) LatestClaudeVersion(ctx context.Context) (string, error) {
	return store.LatestSessionVersion(ctx, c.St.R(), "claude")
}
