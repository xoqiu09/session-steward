package store

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func TestReadLatestSessionVersionDoesNotCreateOrMigrate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "synthetic legacy # version.sqlite")
	if got, err := ReadLatestSessionVersion(context.Background(), path, "claude"); err != nil || got != "" {
		t.Fatalf("missing: %q %v", got, err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("读取时创建了数据库")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE TABLE sessions(id INTEGER PRIMARY KEY,provider TEXT,version TEXT,last_activity_at TEXT);
PRAGMA user_version=3;
INSERT INTO sessions VALUES(1,'claude','2.1.33','2026-10-30T01:00:00Z'),(2,'claude','2.1.83','2026-10-30T02:00:00Z'),(3,'codex','0.164.0','2026-10-30T03:00:00Z'),(4,'claude','','2026-10-30T04:00:00Z');`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	before, _ := os.ReadFile(path)
	if got, err := ReadLatestSessionVersion(context.Background(), path, "claude"); err != nil || got != "2.1.83" {
		t.Fatalf("latest nonempty Claude: %q %v", got, err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("只读查询改变了数据库文件")
	}
}
