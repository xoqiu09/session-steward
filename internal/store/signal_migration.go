package store

import (
	"database/sql"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func addSignalColumns(tx *sql.Tx) error {
	rows, err := tx.Query(`PRAGMA table_info(sessions)`)
	if err != nil {
		return err
	}
	columns := map[string]bool{}
	for rows.Next() {
		var cid, notnull, pk int
		var name, kind string
		var def any
		if err := rows.Scan(&cid, &name, &kind, &notnull, &def, &pk); err != nil {
			rows.Close()
			return err
		}
		columns[name] = true
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, name := range []string{"last_signal_at", "last_signal_channel"} {
		if !columns[name] {
			if _, err := tx.Exec(`ALTER TABLE sessions ADD COLUMN ` + name + ` TEXT NOT NULL DEFAULT ''`); err != nil {
				return err
			}
		}
	}
	// Normalize the indexed observation clock, preserving the original event body.
	// This makes legacy second precision and timezone offsets comparable to current TS values.
	rows, err = tx.Query(`SELECT seq,session_id,occurred_at,CASE WHEN json_valid(body) THEN COALESCE(NULLIF(json_extract(body,'$.source.channel'),''),'hook') ELSE 'hook' END FROM events`)
	if err != nil {
		return err
	}
	type observation struct {
		seq         int64
		sid         sql.NullInt64
		at, channel string
		original    string
	}
	var all []observation
	for rows.Next() {
		var o observation
		if err := rows.Scan(&o.seq, &o.sid, &o.original, &o.channel); err != nil {
			rows.Close()
			return err
		}
		at, err := time.Parse(time.RFC3339Nano, o.original)
		if err != nil {
			continue
		}
		o.at = TS(at)
		if !event.ValidChannel(o.channel) {
			o.channel = "hook"
		}
		all = append(all, o)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	latest := map[int64]observation{}
	for _, o := range all {
		if o.original != o.at {
			if _, err := tx.Exec(`UPDATE events SET occurred_at=? WHERE seq=?`, o.at, o.seq); err != nil {
				return err
			}
		}
		if o.sid.Valid {
			old := latest[o.sid.Int64]
			if o.at > old.at || (o.at == old.at && event.ChannelPriority(o.channel) > event.ChannelPriority(old.channel)) {
				latest[o.sid.Int64] = o
			}
		}
	}
	for sid, o := range latest {
		if _, err := tx.Exec(`UPDATE sessions SET last_signal_at=?,last_signal_channel=? WHERE id=? AND last_signal_at=''`, o.at, o.channel, sid); err != nil {
			return err
		}
	}
	return nil
}
