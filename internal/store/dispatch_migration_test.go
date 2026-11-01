package store

import (
	"path/filepath"
	"testing"
)

// 带 tmux 托管会话和最后画面的旧库升到 v6：数据都在，旧会话仍是 tmux，tmux_name 仍唯一，派活任务可以不填。
func TestDispatchMigrationKeepsTmuxSessions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	db := rawDB(t, path)
	if err := migrate(db, migrations[:5]); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO repos(id,common_dir,name,created_at) VALUES(1,'/synthetic/demo/.git','demo','2026-10-30T00:00:00Z');
 INSERT INTO work_items(id,repo_id,title,created_at,updated_at) VALUES('DEMO-1',1,'synthetic','2026-10-30T00:00:00Z','2026-10-30T00:00:00Z');
 INSERT INTO managed_sessions(id,repo_id,agent,command,title,work_item_id,worktree,branch,tmux_name,state,created_at,updated_at)
  VALUES('aaaa1111',1,'claude','["claude"]','synthetic','DEMO-1','/synthetic/wt/a','steward/aaaa1111','steward-aaaa1111','exited','2026-10-30T00:00:00Z','2026-10-30T00:00:00Z');
 INSERT INTO managed_screens(managed_id,text,captured_at) VALUES('aaaa1111','last screen','2026-10-30T00:01:00Z');
 INSERT INTO managed_audit(managed_id,action,detail,actor,at) VALUES('aaaa1111','launch','','panel','2026-10-30T00:00:00Z');`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := Open(path) // 外键开启，与正式服务相同
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var runner, tmuxName, screen, device string
	if err := s.R().QueryRow(`SELECT runner,tmux_name FROM managed_sessions WHERE id='aaaa1111'`).Scan(&runner, &tmuxName); err != nil || runner != "tmux" || tmuxName != "steward-aaaa1111" {
		t.Fatalf("runner=%q tmux=%q err=%v", runner, tmuxName, err)
	}
	if err := s.R().QueryRow(`SELECT text FROM managed_screens WHERE managed_id='aaaa1111'`).Scan(&screen); err != nil || screen != "last screen" {
		t.Fatalf("最后画面丢失：%q %v", screen, err)
	}
	if err := s.R().QueryRow(`SELECT device FROM managed_audit WHERE managed_id='aaaa1111'`).Scan(&device); err != nil || device != "" {
		t.Fatalf("device=%q err=%v", device, err)
	}
	w := s.w
	if _, err := w.Exec(`INSERT INTO managed_sessions(id,repo_id,agent,command,title,work_item_id,worktree,branch,tmux_name,state,created_at,updated_at)
  VALUES('bbbb2222',1,'claude','["claude"]','dup','DEMO-1','/synthetic/wt/b','steward/bbbb2222','steward-aaaa1111','running','t','t')`); err == nil {
		t.Fatal("旧 tmux 名称应仍然唯一")
	}
	for _, id := range []string{"cccc3333", "dddd4444"} {
		if _, err := w.Exec(`INSERT INTO managed_sessions(id,repo_id,agent,command,title,work_item_id,worktree,branch,state,created_at,updated_at,runner,native_status)
  VALUES(?,1,'codex','["codex","app-server"]','dispatch','DEMO-1',?,'steward/'||?,'running','t','t','codex_app','ready')`, id, "/synthetic/wt/"+id, id); err != nil {
			t.Fatalf("派活任务不应需要 tmux 名称：%v", err)
		}
	}
	if _, err := w.Exec(`UPDATE managed_sessions SET native_thread='thread-synthetic' WHERE id IN ('cccc3333','dddd4444')`); err == nil {
		t.Fatal("同一原生会话号不应属于两个任务")
	}
	if _, err := w.Exec(`INSERT INTO dispatch_projects(repo_id,added_at) VALUES(1,'t'); INSERT INTO dispatch_ops(managed_id,op,created_at) VALUES('cccc3333','op-1','t')`); err != nil {
		t.Fatal(err)
	}
}

// 没有版本号的库会从 v1 重跑全部迁移；已经是 v6 结构时不能报错，也不能丢数据。
func TestDispatchMigrationCanRepeat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "repeat.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.w.Exec(`INSERT INTO repos(id,common_dir,name,created_at) VALUES(7,'/synthetic/r/.git','r','t'); INSERT INTO dispatch_projects(repo_id,added_at) VALUES(7,'t'); PRAGMA user_version = 0`); err != nil {
		t.Fatal(err)
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var n int
	if err := s.R().QueryRow(`SELECT count(*) FROM dispatch_projects`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("n=%d err=%v", n, err)
	}
}
