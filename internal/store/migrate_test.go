package store

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func rawDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	return db
}

func TestNewDatabaseIsAtLatestVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "new.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
	db := rawDB(t, path)
	defer db.Close()
	if v, err := userVersion(db); err != nil || v != SchemaVersion() {
		t.Fatalf("user_version=%d err=%v want %d", v, err, SchemaVersion())
	}
	// 重复打开不重复迁移
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
}

// 引入版本号之前创建的库（user_version=0，表已齐全且有数据）按 v1 兼容处理，数据保留，并继续升到最新版本。
func TestUnversionedDatabaseIsTreatedAsV1(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.sqlite")
	db := rawDB(t, path)
	if _, err := db.Exec(schema); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO meta(k,v) VALUES('synthetic','kept')`); err != nil {
		t.Fatal(err)
	}
	if v, _ := userVersion(db); v != 0 {
		t.Fatalf("前提：旧库无版本号，实际 %d", v)
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var v string
	if err := s.R().QueryRow(`SELECT v FROM meta WHERE k='synthetic'`).Scan(&v); err != nil || v != "kept" {
		t.Fatalf("数据丢失: %q %v", v, err)
	}
	s.Close()
	db = rawDB(t, path)
	defer db.Close()
	if v, _ := userVersion(db); v != SchemaVersion() {
		t.Fatalf("user_version=%d want %d", v, SchemaVersion())
	}
}

func TestMigrationsRunInOrderAndOnlyOnce(t *testing.T) {
	db := rawDB(t, filepath.Join(t.TempDir(), "m.sqlite"))
	defer db.Close()
	var ran []int
	step := func(v int, q string) migration {
		return migration{v, func(tx *sql.Tx) error { ran = append(ran, v); _, err := tx.Exec(q); return err }}
	}
	list := []migration{
		step(1, `CREATE TABLE t (id INTEGER PRIMARY KEY)`),
		step(2, `ALTER TABLE t ADD COLUMN name TEXT NOT NULL DEFAULT ''`),
	}
	if err := migrate(db, list[:1]); err != nil {
		t.Fatal(err)
	}
	if err := migrate(db, list); err != nil {
		t.Fatal(err)
	}
	if err := migrate(db, list); err != nil {
		t.Fatal(err)
	}
	if len(ran) != 2 || ran[0] != 1 || ran[1] != 2 {
		t.Fatalf("执行顺序 %v", ran)
	}
	if _, err := db.Exec(`INSERT INTO t(id,name) VALUES(1,'x')`); err != nil {
		t.Fatal("v2 未生效:", err)
	}
	if v, _ := userVersion(db); v != 2 {
		t.Fatalf("user_version=%d", v)
	}
}

func TestFailedMigrationKeepsVersion(t *testing.T) {
	db := rawDB(t, filepath.Join(t.TempDir(), "f.sqlite"))
	defer db.Close()
	list := []migration{
		{1, execSQL(`CREATE TABLE t (id INTEGER PRIMARY KEY)`)},
		{2, func(tx *sql.Tx) error {
			if _, err := tx.Exec(`CREATE TABLE half (id INTEGER)`); err != nil {
				return err
			}
			return errors.New("synthetic failure")
		}},
	}
	if err := migrate(db, list); err == nil {
		t.Fatal("应返回迁移错误")
	}
	if v, _ := userVersion(db); v != 1 {
		t.Fatalf("失败的迁移不应推进版本: %d", v)
	}
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name='half'`).Scan(&n)
	if n != 0 {
		t.Fatal("失败的迁移应整体回滚")
	}
}

func TestNewerDatabaseIsRejected(t *testing.T) {
	path := filepath.Join(t.TempDir(), "future.sqlite")
	db := rawDB(t, path)
	db.Exec(`PRAGMA user_version = 99`)
	db.Close()
	if _, err := Open(path); err == nil || !strings.Contains(err.Error(), "99") {
		t.Fatalf("应拒绝更新版本的库: %v", err)
	}
}

func TestMigrationListMustBeContiguous(t *testing.T) {
	db := rawDB(t, filepath.Join(t.TempDir(), "g.sqlite"))
	defer db.Close()
	if err := migrate(db, []migration{{1, execSQL(`SELECT 1`)}, {3, execSQL(`SELECT 1`)}}); err == nil {
		t.Fatal("版本跳号应报错")
	}
}
