package store

import (
	"database/sql"
	"fmt"
)

// migration 把库从 version-1 升到 version。每条迁移在一个事务内执行，并在同一事务内写入 PRAGMA user_version，
// 迁移失败时库保持原版本。
type migration struct {
	version int
	apply   func(*sql.Tx) error
}

// migrations 按版本顺序排列，只追加、不修改已发布的条目。改表结构时新增一条，例如：
//
//	{2, execSQL(`ALTER TABLE work_items ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`)},
//
// v1 是首个公开版本的 schema。它全部使用 IF NOT EXISTS，所以引入版本号之前创建的库（user_version=0）
// 执行 v1 后即与新库一致。
var migrations = []migration{
	{1, execSQL(schema)},
	// 托管进程退出后、结束 tmux 会话之前保存的最后画面，面板在会话结束后仍能看到崩溃原因。
	{2, execSQL(`CREATE TABLE IF NOT EXISTS managed_screens (
 managed_id TEXT PRIMARY KEY REFERENCES managed_sessions(id) ON DELETE CASCADE,
 text TEXT NOT NULL,
 captured_at TEXT NOT NULL
)`)},
	// 每个会话按本地日期、模型归档的 token 数（含子 Agent）。只增不删：Agent 清理旧记录后，历史日历里的数字仍在。
	{3, execSQL(`CREATE TABLE IF NOT EXISTS usage_daily (
 session_id INTEGER NOT NULL REFERENCES sessions(id),
 day TEXT NOT NULL,
 model TEXT NOT NULL,
 input INTEGER NOT NULL DEFAULT 0,
 output INTEGER NOT NULL DEFAULT 0,
 cache_read INTEGER NOT NULL DEFAULT 0,
 cache_write INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (session_id, day, model)
);
CREATE INDEX IF NOT EXISTS usage_daily_day ON usage_daily(day)`)},
}

func execSQL(q string) func(*sql.Tx) error {
	return func(tx *sql.Tx) error {
		_, err := tx.Exec(q)
		return err
	}
}

// SchemaVersion 是当前程序支持的最新 schema 版本。
func SchemaVersion() int { return migrations[len(migrations)-1].version }

func userVersion(q interface{ QueryRow(string, ...any) *sql.Row }) (int, error) {
	var v int
	err := q.QueryRow(`PRAGMA user_version`).Scan(&v)
	return v, err
}

// migrate 依次执行库中尚未应用的迁移。库版本高于程序支持的版本时拒绝打开，避免旧程序误写新结构。
func migrate(db *sql.DB, list []migration) error {
	for i, m := range list {
		if m.version != i+1 {
			return fmt.Errorf("迁移列表不连续：第 %d 条版本为 %d", i+1, m.version)
		}
	}
	cur, err := userVersion(db)
	if err != nil {
		return err
	}
	latest := list[len(list)-1].version
	if cur > latest {
		return fmt.Errorf("数据库 schema 版本 %d 高于本程序支持的 %d，请升级 Steward", cur, latest)
	}
	for _, m := range list {
		if m.version <= cur {
			continue
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if err := m.apply(tx); err != nil {
			tx.Rollback()
			return fmt.Errorf("迁移到 v%d: %w", m.version, err)
		}
		// PRAGMA 不支持参数绑定；version 来自代码中的常量
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, m.version)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("迁移到 v%d: %w", m.version, err)
		}
	}
	return nil
}
