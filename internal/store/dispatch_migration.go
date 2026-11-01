package store

import "database/sql"

// addDispatchSchema 让托管会话既能是 tmux 终端，也能是派活台的 Codex app-server 任务。
// tmux_name 原来是必填且唯一的列约束，SQLite 只能重建表来放开；重建前先把最后画面另存，
// 否则外键开启时删除旧表会级联删除 managed_screens。旧数据的 tmux_name 唯一性改由部分索引保证。
// 和 v5 一样可以重复执行：没有版本号的库会从 v1 重新跑一遍迁移。
func addDispatchSchema(tx *sql.Tx) error {
	hasRunner, err := hasColumn(tx, "managed_sessions", "runner")
	if err != nil {
		return err
	}
	if !hasRunner {
		if err := rebuildManagedSessions(tx); err != nil {
			return err
		}
	}
	hasDevice, err := hasColumn(tx, "managed_audit", "device")
	if err != nil {
		return err
	}
	if !hasDevice {
		// 哪台设备做的动作；旧审计为空。
		if _, err := tx.Exec(`ALTER TABLE managed_audit ADD COLUMN device TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}
	_, err = tx.Exec(`
-- 可派活的项目：只有在 Studio 本机加进来的项目才能派活。
CREATE TABLE IF NOT EXISTS dispatch_projects (
 repo_id INTEGER PRIMARY KEY REFERENCES repos(id),
 added_at TEXT NOT NULL
);
-- 开始一轮的幂等键：同一个键重复提交只执行一次。turn 为空表示已受理、尚未拿到原生轮次。
CREATE TABLE IF NOT EXISTS dispatch_ops (
 managed_id TEXT NOT NULL REFERENCES managed_sessions(id) ON DELETE CASCADE,
 op TEXT NOT NULL,
 turn TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 PRIMARY KEY (managed_id, op)
)`)
	return err
}

func hasColumn(tx *sql.Tx, table, column string) (bool, error) {
	var n int
	err := tx.QueryRow(`SELECT count(*) FROM pragma_table_info(?) WHERE name=?`, table, column).Scan(&n)
	return n > 0, err
}

func rebuildManagedSessions(tx *sql.Tx) error {
	_, err := tx.Exec(`
CREATE TABLE managed_sessions_v6 (
 id TEXT PRIMARY KEY,
 repo_id INTEGER NOT NULL REFERENCES repos(id),
 agent TEXT NOT NULL,
 command TEXT NOT NULL,
 title TEXT NOT NULL,
 work_item_id TEXT NOT NULL REFERENCES work_items(id),
 worktree TEXT NOT NULL UNIQUE,
 branch TEXT NOT NULL,
 base_sha TEXT NOT NULL DEFAULT '',
 tmux_name TEXT NOT NULL DEFAULT '',  -- 仅 tmux 运行方式；派活任务为空
 state TEXT NOT NULL,
 exit_code INTEGER,
 error TEXT NOT NULL DEFAULT '',
 session_id INTEGER REFERENCES sessions(id),
 takeover INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 runner TEXT NOT NULL DEFAULT 'tmux',      -- tmux|codex_app
 native_thread TEXT NOT NULL DEFAULT '',   -- Codex 原生会话号
 native_turn TEXT NOT NULL DEFAULT '',     -- 正在执行的一轮；空表示没有
 native_status TEXT NOT NULL DEFAULT ''    -- ready|starting|running|idle|failed|interrupted|desktop|needs_reconcile|uncertain
);
INSERT INTO managed_sessions_v6(id,repo_id,agent,command,title,work_item_id,worktree,branch,base_sha,tmux_name,state,exit_code,error,session_id,takeover,created_at,updated_at)
 SELECT id,repo_id,agent,command,title,work_item_id,worktree,branch,base_sha,tmux_name,state,exit_code,error,session_id,takeover,created_at,updated_at FROM managed_sessions;
CREATE TEMP TABLE managed_screens_v6 AS SELECT managed_id,text,captured_at FROM managed_screens;
DROP TABLE managed_screens;
DROP TABLE managed_sessions;
ALTER TABLE managed_sessions_v6 RENAME TO managed_sessions;
CREATE UNIQUE INDEX managed_tmux_name ON managed_sessions(tmux_name) WHERE tmux_name<>'';
CREATE UNIQUE INDEX managed_native_thread ON managed_sessions(native_thread) WHERE native_thread<>'';
CREATE TABLE managed_screens (
 managed_id TEXT PRIMARY KEY REFERENCES managed_sessions(id) ON DELETE CASCADE,
 text TEXT NOT NULL,
 captured_at TEXT NOT NULL
);
INSERT INTO managed_screens SELECT managed_id,text,captured_at FROM managed_screens_v6;
DROP TABLE managed_screens_v6`)
	return err
}
