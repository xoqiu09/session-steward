// Package store 封装 SQLite。所有写操作经过同一把锁和同一个连接，保证单写者。
package store

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Store struct {
	w   *sql.DB // 单连接写库
	r   *sql.DB // 读库连接池
	mu  sync.Mutex
	Now func() time.Time
}

func Open(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=synchronous(NORMAL)", path)
	w, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	if err := migrate(w, migrations); err != nil {
		w.Close()
		return nil, fmt.Errorf("初始化 schema: %w", err)
	}
	r, err := sql.Open("sqlite", dsn+"&_pragma=query_only(1)")
	if err != nil {
		w.Close()
		return nil, err
	}
	r.SetMaxOpenConns(8)
	return &Store{w: w, r: r, Now: time.Now}, nil
}

func (s *Store) Close() error {
	s.r.Close()
	return s.w.Close()
}

// R 返回只读连接池。
func (s *Store) R() *sql.DB { return s.r }

// Tx 在单写者锁内执行一个写事务。fn 内不得等待外部输入。
func (s *Store) Tx(ctx context.Context, fn func(*sql.Tx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// TS 返回统一的时间字符串格式（UTC、纳秒精度、可按字典序比较）。
func TS(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000000000Z") }

func (s *Store) NowTS() string { return TS(s.Now()) }

// Touch 记录一次变更，SSE 用它作为递增游标。
func Touch(tx *sql.Tx, now, topic, ref string) error {
	_, err := tx.Exec(`INSERT INTO changes(topic, ref, at) VALUES (?,?,?)`, topic, ref, now)
	return err
}

// ChangesSince 返回游标之后的变更。若游标早于已保留的最小序号，reset=true，客户端应重新拉快照。
func (s *Store) ChangesSince(ctx context.Context, cursor int64, limit int) (out []Change, reset bool, err error) {
	var minSeq sql.NullInt64
	if err = s.r.QueryRowContext(ctx, `SELECT MIN(seq) FROM changes`).Scan(&minSeq); err != nil {
		return
	}
	if cursor > 0 && minSeq.Valid && cursor < minSeq.Int64-1 {
		return nil, true, nil
	}
	rows, err := s.r.QueryContext(ctx, `SELECT seq, topic, ref FROM changes WHERE seq > ? ORDER BY seq LIMIT ?`, cursor, limit)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var c Change
		if err = rows.Scan(&c.Seq, &c.Topic, &c.Ref); err != nil {
			return
		}
		out = append(out, c)
	}
	return out, false, rows.Err()
}

// LatestSeq 返回当前最新游标。
func (s *Store) LatestSeq(ctx context.Context) (int64, error) {
	var n sql.NullInt64
	err := s.r.QueryRowContext(ctx, `SELECT MAX(seq) FROM changes`).Scan(&n)
	return n.Int64, err
}

// PruneChanges 只保留最近 keep 条变更记录。
func (s *Store) PruneChanges(ctx context.Context, keep int64) error {
	return s.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`DELETE FROM changes WHERE seq <= (SELECT MAX(seq) FROM changes) - ?`, keep)
		return err
	})
}

type Change struct {
	Seq   int64  `json:"seq"`
	Topic string `json:"topic"`
	Ref   string `json:"ref"`
}

func (s *Store) Meta(ctx context.Context, k string) (string, error) {
	var v string
	err := s.r.QueryRowContext(ctx, `SELECT v FROM meta WHERE k=?`, k).Scan(&v)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return v, err
}

func (s *Store) SetMeta(ctx context.Context, k, v string) error {
	return s.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, k, v)
		return err
	})
}
