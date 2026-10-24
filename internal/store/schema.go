package store

const schema = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS repos (
  id          INTEGER PRIMARY KEY,
  common_dir  TEXT NOT NULL UNIQUE,   -- 规范化后的 git common dir；无 Git 时为 dir:<abs>
  name        TEXT NOT NULL,
  is_git      INTEGER NOT NULL DEFAULT 1,
  target_ref  TEXT NOT NULL DEFAULT 'main',
  created_at  TEXT NOT NULL
);

-- Retired repository IDs and identity strings remain resolvable for audit/stale clients.
CREATE TABLE IF NOT EXISTS repo_aliases (
 repo_id INTEGER PRIMARY KEY REFERENCES repos(id),
 canonical_id INTEGER NOT NULL REFERENCES repos(id)
);
CREATE TABLE IF NOT EXISTS repo_identities (
 identity TEXT PRIMARY KEY,
 repo_id INTEGER NOT NULL REFERENCES repos(id)
);

CREATE TABLE IF NOT EXISTS work_items (
  id           TEXT PRIMARY KEY,      -- 例如 QM-014
  repo_id      INTEGER REFERENCES repos(id),
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'todo',  -- todo|in_progress|blocked|review|done|abandoned
  acceptance   TEXT NOT NULL DEFAULT '',
  branch       TEXT NOT NULL DEFAULT '',
  merge_state  TEXT NOT NULL DEFAULT 'none',  -- none|not_ready|awaiting|approved|merged
  needs_merge  INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_deps (
  upstream    TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  downstream  TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  cond        TEXT NOT NULL DEFAULT 'accepted',  -- accepted|merged
  PRIMARY KEY (upstream, downstream)
);

-- Stable incident clocks; metadata edits must not create a new blocked incident.
CREATE TABLE IF NOT EXISTS work_item_clocks (
 work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
 status_at TEXT NOT NULL,
 merge_at TEXT NOT NULL,
 dependencies_at TEXT NOT NULL
);
INSERT OR IGNORE INTO work_item_clocks(work_item_id,status_at,merge_at,dependencies_at)
 SELECT id,updated_at,updated_at,created_at FROM work_items;
CREATE TRIGGER IF NOT EXISTS work_item_clock_insert AFTER INSERT ON work_items BEGIN
 INSERT INTO work_item_clocks(work_item_id,status_at,merge_at,dependencies_at)
 VALUES(NEW.id,NEW.created_at,NEW.created_at,NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS work_item_clock_status AFTER UPDATE OF status ON work_items
 WHEN OLD.status<>NEW.status BEGIN
 UPDATE work_item_clocks SET status_at=NEW.updated_at WHERE work_item_id=NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS work_item_clock_merge AFTER UPDATE OF merge_state ON work_items
 WHEN OLD.merge_state<>NEW.merge_state BEGIN
 UPDATE work_item_clocks SET merge_at=NEW.updated_at WHERE work_item_id=NEW.id;
END;

-- Keep raw transitions so Go can apply DepSatisfied without duplicating its rules
-- in SQL. Recovery between notifier polls must not be lost. Existing rows are
-- deliberately not backfilled: pre-upgrade incidents keep their old clock.
CREATE TABLE IF NOT EXISTS work_item_state_changes (
 id INTEGER PRIMARY KEY,
 work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 old_status TEXT NOT NULL,
 old_merge_state TEXT NOT NULL,
 status TEXT NOT NULL,
 merge_state TEXT NOT NULL,
 at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS work_item_state_changes_item ON work_item_state_changes(work_item_id);
CREATE TRIGGER IF NOT EXISTS work_item_state_change AFTER UPDATE OF status,merge_state ON work_items
 WHEN OLD.status<>NEW.status OR OLD.merge_state<>NEW.merge_state BEGIN
 INSERT INTO work_item_state_changes(work_item_id,old_status,old_merge_state,status,merge_state,at)
 VALUES(NEW.id,OLD.status,OLD.merge_state,NEW.status,NEW.merge_state,NEW.updated_at);
END;

CREATE TABLE IF NOT EXISTS sessions (
  id                   INTEGER PRIMARY KEY,
  host_id              TEXT NOT NULL,
  provider             TEXT NOT NULL,
  provider_session_id  TEXT NOT NULL,
  client               TEXT NOT NULL DEFAULT 'unknown',
  version              TEXT NOT NULL DEFAULT '',
  parent_session_id    INTEGER,
  subagent_id          TEXT NOT NULL DEFAULT '',
  cwd                  TEXT NOT NULL DEFAULT '',
  worktree             TEXT NOT NULL DEFAULT '',
  branch               TEXT NOT NULL DEFAULT '',
  repo_id              INTEGER REFERENCES repos(id),
  state                TEXT NOT NULL DEFAULT 'unknown', -- running|waiting_permission|idle|interrupted|error|ended|unknown
  state_reason         TEXT NOT NULL DEFAULT '',
  state_at             TEXT NOT NULL DEFAULT '',  -- 设置当前状态的事件发生时间，用于乱序合并
  data_source          TEXT NOT NULL DEFAULT 'live', -- live|history
  suggested_work_item  TEXT NOT NULL DEFAULT '',
  first_seen_at        TEXT NOT NULL,
  last_activity_at     TEXT NOT NULL DEFAULT '',
  last_progress_at     TEXT NOT NULL DEFAULT '',
  UNIQUE (host_id, provider, provider_session_id)
);
CREATE INDEX IF NOT EXISTS sessions_worktree ON sessions(worktree);

CREATE TABLE IF NOT EXISTS session_titles (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id),
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attributions (
  id TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  plan TEXT NOT NULL,
  work_item_id TEXT NOT NULL DEFAULT '',
  run_id INTEGER NOT NULL DEFAULT 0,
  automatic INTEGER NOT NULL DEFAULT 0,
  created_item INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  decided_at TEXT NOT NULL DEFAULT '',
  UNIQUE(session_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS attributions_status ON attributions(status,session_id);

CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY,
  work_item_id  TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  session_id    INTEGER NOT NULL REFERENCES sessions(id),
  attempt       INTEGER NOT NULL,
  binding       TEXT NOT NULL,      -- manual|tag|inherited|branch_guess
  started_at    TEXT NOT NULL,
  ended_at      TEXT NOT NULL DEFAULT '',
  outcome       TEXT NOT NULL DEFAULT ''  -- delivered|failed|abandoned|handed_off|''(待定)
);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, ended_at);
CREATE INDEX IF NOT EXISTS runs_item ON runs(work_item_id);

CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,      -- permission|merge|decision|attention
  status        TEXT NOT NULL,      -- pending|decided|delivered|confirmed|expired|cancelled
  session_id    INTEGER REFERENCES sessions(id),
  work_item_id  TEXT,
  repo_id       INTEGER,
  fingerprint   TEXT NOT NULL DEFAULT '',
  tool_name     TEXT NOT NULL DEFAULT '',
  preview       TEXT NOT NULL DEFAULT '',
  decision      TEXT NOT NULL DEFAULT '',
  handleable    INTEGER NOT NULL DEFAULT 0,  -- 能否在面板里处理
  payload       TEXT NOT NULL DEFAULT '{}',
  close_reason  TEXT NOT NULL DEFAULT '',
  deadline      TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  decided_at    TEXT NOT NULL DEFAULT '',
  delivered_at  TEXT NOT NULL DEFAULT '',
  confirmed_at  TEXT NOT NULL DEFAULT '',
  closed_at     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS approvals_open ON approvals(status, kind);

CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL UNIQUE,
  session_id   INTEGER,
  kind         TEXT NOT NULL,
  occurred_at  TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  body         TEXT NOT NULL      -- 脱敏后的统一事件 JSON
);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, occurred_at);
CREATE INDEX IF NOT EXISTS events_input_resolution ON events(session_id, occurred_at)
  WHERE kind='prompt' OR (kind='tool_post' AND json_extract(body,'$.source.provider')='claude'
    AND json_extract(body,'$.tool_name') IN ('AskUserQuestion','ExitPlanMode'));

CREATE TABLE IF NOT EXISTS changes (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  topic  TEXT NOT NULL,
  ref    TEXT NOT NULL DEFAULT '',
  at     TEXT NOT NULL
);

-- 工作简报：只追加的版本记录。当前值按字段推导（见 core/brief.go），不存对话正文。
CREATE TABLE IF NOT EXISTS brief_entries (
  id            INTEGER PRIMARY KEY,
  work_item_id  TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  field         TEXT NOT NULL,              -- goal|progress|blocker|next
  text          TEXT NOT NULL,              -- 空串表示该字段被清除
  kind          TEXT NOT NULL,              -- agent|user
  source        TEXT NOT NULL,              -- report|ask|deliver|user|confirm
  session_id    INTEGER,
  event_seq     INTEGER,
  supersedes    INTEGER NOT NULL DEFAULT 0, -- user 条目替换的条目
  flagged       TEXT NOT NULL DEFAULT '',   -- ''|wrong|superseded|undone
  at            TEXT NOT NULL,              -- 内容产生时间
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS brief_item ON brief_entries(work_item_id, field, at);

CREATE TABLE IF NOT EXISTS reporting_hint_versions (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id),
  version INTEGER NOT NULL,
  sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reporting_hints_sent (
 session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
 sent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS project_features (
 repo_id INTEGER NOT NULL REFERENCES repos(id),
 feature_id TEXT NOT NULL,
 title TEXT NOT NULL,
 acceptance TEXT NOT NULL DEFAULT '',
 scope_basis TEXT NOT NULL DEFAULT '',
 scope_status TEXT NOT NULL DEFAULT 'proposed',
 created_at TEXT NOT NULL,
 PRIMARY KEY(repo_id,feature_id)
);
CREATE TABLE IF NOT EXISTS feature_reports (
 id INTEGER PRIMARY KEY,
 repo_id INTEGER NOT NULL,
 feature_id TEXT NOT NULL,
 event_id TEXT NOT NULL,
 session_id INTEGER NOT NULL REFERENCES sessions(id),
 run_id INTEGER NOT NULL REFERENCES runs(id),
 work_item_id TEXT NOT NULL REFERENCES work_items(id),
 body TEXT NOT NULL,
 at TEXT NOT NULL,
 received_at TEXT NOT NULL,
 FOREIGN KEY(repo_id,feature_id) REFERENCES project_features(repo_id,feature_id),
 UNIQUE(event_id,feature_id)
);
CREATE INDEX IF NOT EXISTS feature_reports_current ON feature_reports(repo_id,feature_id,at,id);
CREATE TABLE IF NOT EXISTS feature_acceptances (
 id INTEGER PRIMARY KEY,
 repo_id INTEGER NOT NULL,
 feature_id TEXT NOT NULL,
 candidate TEXT NOT NULL,
 scope_version TEXT NOT NULL,
 decision TEXT NOT NULL,
 actor TEXT NOT NULL,
 at TEXT NOT NULL,
 FOREIGN KEY(repo_id,feature_id) REFERENCES project_features(repo_id,feature_id)
);
CREATE TABLE IF NOT EXISTS feature_scope_decisions (
 id INTEGER PRIMARY KEY, repo_id INTEGER NOT NULL, feature_id TEXT NOT NULL,
 previous_status TEXT NOT NULL, revision TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
 FOREIGN KEY(repo_id,feature_id) REFERENCES project_features(repo_id,feature_id)
);

-- 托管会话：由面板在独立 worktree + tmux 中启动。与 sessions（hooks 观察到的 Agent 会话）分开保存。
CREATE TABLE IF NOT EXISTS managed_sessions (
 id TEXT PRIMARY KEY,
 repo_id INTEGER NOT NULL REFERENCES repos(id),
 agent TEXT NOT NULL,
 command TEXT NOT NULL,             -- JSON argv
 title TEXT NOT NULL,
 work_item_id TEXT NOT NULL REFERENCES work_items(id),
 worktree TEXT NOT NULL UNIQUE,
 branch TEXT NOT NULL,
 base_sha TEXT NOT NULL DEFAULT '',
 tmux_name TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL,               -- starting|running|exited|stopped|failed|archived
 exit_code INTEGER,
 error TEXT NOT NULL DEFAULT '',
 session_id INTEGER REFERENCES sessions(id),
 takeover INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS managed_audit (
 id INTEGER PRIMARY KEY,
 managed_id TEXT NOT NULL,
 action TEXT NOT NULL,              -- launch|stop|archive|takeover_on|takeover_off|input
 detail TEXT NOT NULL DEFAULT '',   -- 不保存输入正文，只记录长度与按键
 actor TEXT NOT NULL,
 at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS managed_audit_id ON managed_audit(managed_id, id);
-- “需要你”推送去重：同一条目只推送一次。
CREATE TABLE IF NOT EXISTS notify_sent (
 key TEXT PRIMARY KEY,
 at TEXT NOT NULL
);

-- 检查门合并：批准后在临时集成 worktree 中合并并运行检查，全部通过才更新本地目标分支。
-- 状态：queued|running|passed|failed|merged|aborted。“已合并”仍只由 Git 扫描确认。
CREATE TABLE IF NOT EXISTS merge_jobs (
 id TEXT PRIMARY KEY,
 approval_id TEXT NOT NULL,
 work_item_id TEXT NOT NULL,
 repo_id INTEGER NOT NULL,
 source_sha TEXT NOT NULL,
 target_ref TEXT NOT NULL,
 target_sha TEXT NOT NULL,
 merge_sha TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL,
 checks TEXT NOT NULL DEFAULT '[]',  -- [{argv, exit_code, seconds, tail}]，输出已截断脱敏
 error TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS merge_jobs_approval ON merge_jobs(approval_id, created_at);

-- 会话 token 用量：只保存计数，来自本机 transcript 的数字字段（默认关闭）。
CREATE TABLE IF NOT EXISTS session_usage (
 session_id INTEGER PRIMARY KEY REFERENCES sessions(id),
 input INTEGER NOT NULL DEFAULT 0,
 output INTEGER NOT NULL DEFAULT 0,
 cache_read INTEGER NOT NULL DEFAULT 0,
 cache_write INTEGER NOT NULL DEFAULT 0,
 updated_at TEXT NOT NULL
);

-- 跨 Agent 交接包：内容只来自工作项简报、功能清单与 Git 元数据，不含对话正文。
CREATE TABLE IF NOT EXISTS handoffs (
 id TEXT PRIMARY KEY,
 work_item_id TEXT NOT NULL REFERENCES work_items(id),
 from_session_id INTEGER,
 from_provider TEXT NOT NULL DEFAULT '',
 to_agent TEXT NOT NULL,
 source_branch TEXT NOT NULL,
 source_sha TEXT NOT NULL,
 package TEXT NOT NULL,
 managed_id TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL,              -- launched|failed
 created_at TEXT NOT NULL
);

-- AI 摘要：由本机配置的命令根据简报/功能/Git 元数据生成，始终标为“推断”，不覆盖简报字段。
CREATE TABLE IF NOT EXISTS ai_summaries (
 id INTEGER PRIMARY KEY,
 work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
 text TEXT NOT NULL,
 basis_hash TEXT NOT NULL,          -- 输入材料的哈希，材料变化后提示可能过期
 command TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_summaries_item ON ai_summaries(work_item_id, id);
`
