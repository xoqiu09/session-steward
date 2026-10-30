package store

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"os"
	"path/filepath"
)

// LatestSessionVersion 只查询现有的会话元数据，不打开 transcript 或读取对话。
func LatestSessionVersion(ctx context.Context, db *sql.DB, provider string) (string, error) {
	var version string
	err := db.QueryRowContext(ctx, `SELECT version FROM sessions WHERE provider=? AND trim(version)<>'' ORDER BY last_activity_at DESC,id DESC LIMIT 1`, provider).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return version, err
}

// ReadLatestSessionVersion 供安装命令使用：只读打开已有数据库，不创建、不迁移。
func ReadLatestSessionVersion(ctx context.Context, path, provider string) (string, error) {
	if _, err := os.Stat(path); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "", nil
		}
		return "", err
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	dsn := (&url.URL{Scheme: "file", Path: abs, RawQuery: "mode=ro&_pragma=query_only(1)&_pragma=busy_timeout(1000)"}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return "", err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	return LatestSessionVersion(ctx, db, provider)
}
