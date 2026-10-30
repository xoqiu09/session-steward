package core

import (
	"database/sql"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

// Signal is the public observation header. The local event reference is deliberately absent.
type Signal struct {
	Channel string `json:"channel"`
	At      string `json:"at"`
}

func publicSignal(signal *Signal) *Signal {
	if signal == nil || !event.ValidChannel(signal.Channel) {
		return nil
	}
	at, err := time.Parse(time.RFC3339Nano, signal.At)
	if err != nil {
		return nil
	}
	return &Signal{Channel: event.Channel(signal.Channel), At: store.TS(at)}
}

func newerSignal(next, previous *Signal) bool {
	if next == nil {
		return false
	}
	at, err := time.Parse(time.RFC3339Nano, next.At)
	if err != nil {
		return false
	}
	if previous == nil {
		return true
	}
	before, err := time.Parse(time.RFC3339Nano, previous.At)
	return err != nil || at.After(before) || (at.Equal(before) && event.ChannelPriority(next.Channel) > event.ChannelPriority(previous.Channel))
}

func updateLastSignal(tx *sql.Tx, sid int64, at, channel string) error {
	var previous Signal
	if err := tx.QueryRow(`SELECT last_signal_at,last_signal_channel FROM sessions WHERE id=?`, sid).Scan(&previous.At, &previous.Channel); err != nil {
		return err
	}
	next := &Signal{Channel: event.Channel(channel), At: at}
	if !newerSignal(next, &previous) {
		return nil
	}
	_, err := tx.Exec(`UPDATE sessions SET last_signal_at=?,last_signal_channel=? WHERE id=?`, at, next.Channel, sid)
	return err
}

func readSignals(tx *sql.Tx, snap *Snapshot) error {
	rows, err := tx.Query(`SELECT id,last_signal_at,last_signal_channel FROM sessions WHERE last_signal_at<>''`)
	if err != nil {
		return err
	}
	byID := map[int64]*Signal{}
	for rows.Next() {
		var id int64
		var signal Signal
		if err := rows.Scan(&id, &signal.At, &signal.Channel); err != nil {
			rows.Close()
			return err
		}
		signal.Channel = event.Channel(signal.Channel)
		byID[id] = &signal
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for i := range snap.Sessions {
		snap.Sessions[i].Signal = publicSignal(byID[snap.Sessions[i].ID])
	}
	// A session can move between work items. Only observations inside a run's
	// association interval belong to that work; later work must not refresh old work.
	rows, err = tx.Query(`SELECT r.work_item_id,e.occurred_at,
 CASE WHEN json_valid(e.body) THEN COALESCE(NULLIF(json_extract(e.body,'$.source.channel'),''),'hook') ELSE 'hook' END
 FROM runs r JOIN events e ON e.seq=(SELECT e2.seq FROM events e2
 WHERE e2.session_id=r.session_id AND e2.occurred_at>=r.started_at
 AND (r.ended_at='' OR e2.occurred_at<=r.ended_at)
 AND NOT (r.ended_at<>'' AND e2.occurred_at=r.ended_at AND (e2.kind='begin' OR (e2.kind='claim' AND CASE WHEN json_valid(e2.body) THEN COALESCE(json_extract(e2.body,'$.work_tag'),'')<>r.work_item_id ELSE 1 END)))
 ORDER BY e2.occurred_at DESC,
 CASE WHEN NOT json_valid(e2.body) THEN 3
 WHEN COALESCE(NULLIF(json_extract(e2.body,'$.source.channel'),''),'hook')='hook' THEN 3
 WHEN json_extract(e2.body,'$.source.channel')='transcript' THEN 2
 WHEN json_extract(e2.body,'$.source.channel')='process' THEN 1 ELSE 0 END DESC,e2.seq DESC LIMIT 1)`)
	if err != nil {
		return err
	}
	byItem := map[string]*Signal{}
	for rows.Next() {
		var id string
		var signal Signal
		if err := rows.Scan(&id, &signal.At, &signal.Channel); err != nil {
			rows.Close()
			return err
		}
		if newerSignal(&signal, byItem[id]) {
			value := signal
			byItem[id] = &value
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	// Current explicit bindings also carry signals when an older device/DTO has no run list.
	for _, session := range snap.Sessions {
		if session.WorkItemID != "" && newerSignal(session.Signal, byItem[session.WorkItemID]) {
			byItem[session.WorkItemID] = publicSignal(session.Signal)
		}
	}
	for i := range snap.WorkItems {
		snap.WorkItems[i].Signal = publicSignal(byItem[snap.WorkItems[i].ID])
	}
	return nil
}
