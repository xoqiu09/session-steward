package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestLegacyDatabaseGetsStableStateClocks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE work_items (
id TEXT PRIMARY KEY,repo_id INTEGER,title TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'todo',
acceptance TEXT NOT NULL DEFAULT '',branch TEXT NOT NULL DEFAULT '',merge_state TEXT NOT NULL DEFAULT 'none',
needs_merge INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
INSERT INTO work_items(id,title,status,created_at,updated_at) VALUES('MIG-1','Synthetic legacy task','blocked','2026-10-20T00:00:00Z','2026-10-21T00:00:00Z');`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var status, statusAt, depsAt string
	if err = s.R().QueryRow(`SELECT w.status,k.status_at,k.dependencies_at FROM work_items w JOIN work_item_clocks k ON k.work_item_id=w.id WHERE w.id='MIG-1'`).Scan(&status, &statusAt, &depsAt); err != nil {
		t.Fatal(err)
	}
	if status != "blocked" || statusAt != "2026-10-21T00:00:00Z" || depsAt != "2026-10-20T00:00:00Z" {
		t.Fatal(status, statusAt, depsAt)
	}
	err = s.Tx(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE work_items SET title='New synthetic wording',updated_at='2026-10-22T00:00:00Z' WHERE id='MIG-1'`)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if err = s.R().QueryRow(`SELECT status_at FROM work_item_clocks WHERE work_item_id='MIG-1'`).Scan(&statusAt); err != nil {
		t.Fatal(err)
	}
	if statusAt != "2026-10-21T00:00:00Z" {
		t.Fatal("reopen reseeded the incident clock", statusAt)
	}
	err = s.Tx(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE work_items SET status='in_progress',updated_at='2026-10-23T00:00:00Z' WHERE id='MIG-1'`)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.R().QueryRow(`SELECT status_at FROM work_item_clocks WHERE work_item_id='MIG-1'`).Scan(&statusAt); err != nil {
		t.Fatal(err)
	}
	if statusAt != "2026-10-23T00:00:00Z" {
		t.Fatal("real state change did not move clock", statusAt)
	}
	var count int
	var oldStatus, newStatus string
	if err = s.R().QueryRow(`SELECT COUNT(*),old_status,status FROM work_item_state_changes WHERE work_item_id='MIG-1'`).Scan(&count, &oldStatus, &newStatus); err != nil {
		t.Fatal(err)
	}
	if count != 1 || oldStatus != "blocked" || newStatus != "in_progress" {
		t.Fatalf("only the real post-upgrade transition should be journaled: %d %s -> %s", count, oldStatus, newStatus)
	}
}
