package store

import (
	"path/filepath"
	"testing"
)

func TestSignalMigrationKeepsLegacyBodiesAndCanRepeat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	db := rawDB(t, path)
	if err := migrate(db, migrations[:4]); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO sessions(id,host_id,provider,provider_session_id,first_seen_at) VALUES(1,'synthetic','claude','legacy','2026-10-30T00:00:00Z');
 INSERT INTO events(event_id,session_id,kind,occurred_at,received_at,body) VALUES
 ('old',1,'tool_post','2026-10-30T10:00:00+08:00','2026-10-30T02:01:00Z','{"source":{"provider":"claude"}}'),
 ('latest',1,'tool_post','2026-10-30T02:00:00.000000001Z','2026-10-30T02:01:00Z','{"source":{"channel":"process"}}'),
 ('same',1,'tool_post','2026-10-30T02:00:00.000000001Z','2026-10-30T02:02:00Z','{"source":{"channel":"transcript"}}');`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(db, migrations); err != nil {
		t.Fatal(err)
	}
	var at, channel, body string
	if err := db.QueryRow(`SELECT last_signal_at,last_signal_channel FROM sessions WHERE id=1`).Scan(&at, &channel); err != nil {
		t.Fatal(err)
	}
	if at != "2026-10-30T02:00:00.000000001Z" || channel != "transcript" {
		t.Fatalf("%s %s", at, channel)
	}
	db.QueryRow(`SELECT body FROM events WHERE event_id='old'`).Scan(&body)
	if body != `{"source":{"provider":"claude"}}` {
		t.Fatal("old body was rewritten")
	}
	for i := 0; i < 2; i++ {
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if err = addSignalColumns(tx); err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		if err = tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	s.Close()
}

func TestSignalMigrationLeavesMetadataOnlySessionsUnknown(t *testing.T) {
	db := rawDB(t, filepath.Join(t.TempDir(), "metadata.sqlite"))
	defer db.Close()
	if err := migrate(db, migrations[:4]); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO sessions(host_id,provider,provider_session_id,first_seen_at,last_activity_at,data_source) VALUES('synthetic','codex','history','2026-10-30T00:00:00Z','2026-10-30T01:00:00Z','history')`); err != nil {
		t.Fatal(err)
	}
	if err := migrate(db, migrations); err != nil {
		t.Fatal(err)
	}
	var at, channel string
	db.QueryRow(`SELECT last_signal_at,last_signal_channel FROM sessions`).Scan(&at, &channel)
	if at != "" || channel != "" {
		t.Fatal("history scan became a fabricated hook signal")
	}
}
