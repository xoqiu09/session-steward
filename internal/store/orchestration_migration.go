package store

import "database/sql"

func addOrchestrationSchema(tx *sql.Tx) error {
	_, err := tx.Exec(`
CREATE TABLE IF NOT EXISTS orchestration_mandates (
 work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
 revision TEXT NOT NULL UNIQUE, basis TEXT NOT NULL, request_hash TEXT NOT NULL, expires_at TEXT NOT NULL,
 max_turns INTEGER NOT NULL CHECK(max_turns BETWEEN 1 AND 100), turns INTEGER NOT NULL DEFAULT 0,
 failure_followup INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0,
 event_cursor INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestration_assignments (
 work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
 managed_id TEXT NOT NULL UNIQUE REFERENCES managed_sessions(id), host_id TEXT NOT NULL,
 epoch INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestration_deliveries (
 id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id),
 revision TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0,
 source_id TEXT NOT NULL, kind TEXT NOT NULL, input TEXT NOT NULL DEFAULT '', input_hash TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'queued', reason TEXT NOT NULL DEFAULT '', attempts INTEGER NOT NULL DEFAULT 0,
 due_at TEXT NOT NULL, receipt TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(work_item_id,source_id)
);
CREATE INDEX IF NOT EXISTS orchestration_delivery_queue ON orchestration_deliveries(state,due_at,created_at);
CREATE TABLE IF NOT EXISTS orchestration_findings (
 id TEXT PRIMARY KEY, work_item_id TEXT NOT NULL REFERENCES work_items(id),
 rule TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open',
 fact TEXT NOT NULL, basis TEXT NOT NULL, opened_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(work_item_id,rule,scope)
);
CREATE TABLE IF NOT EXISTS orchestration_audit (
 seq INTEGER PRIMARY KEY, work_item_id TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
 reason TEXT NOT NULL, at TEXT NOT NULL
);
`)
	return err
}
