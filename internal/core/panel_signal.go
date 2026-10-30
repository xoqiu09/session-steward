package core

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

type panelSignalKey struct{}
type panelSignal struct{ action, object, id string }

// PanelSignalContext accepts only controlled route templates, never request bodies.
// The Core methods below opt into panelTx; unrelated writes and background verifiers stay unchanged.
func PanelSignalContext(ctx context.Context, pattern, id string) context.Context {
	var spec panelSignal
	switch pattern {
	case "POST /api/work-items":
		spec = panelSignal{"work_item.create", "create", ""}
	case "PATCH /api/work-items/{id}":
		spec = panelSignal{"work_item.update", "item", id}
	case "POST /api/work-items/{id}/brief":
		spec = panelSignal{"work_item.brief", "item", id}
	case "POST /api/sessions/{id}/bind":
		spec = panelSignal{"session.bind", "session", id}
	case "POST /api/sessions/{id}/unbind":
		spec = panelSignal{"session.unbind", "session", id}
	case "POST /api/runs/{id}/outcome":
		spec = panelSignal{"run.outcome", "run", id}
	case "POST /api/approvals/{id}/decide":
		spec = panelSignal{"approval.decide", "approval", id}
	case "POST /api/approvals/{id}/dismiss":
		spec = panelSignal{"approval.dismiss", "approval", id}
	case "POST /api/approvals/{id}/approve-merge":
		spec = panelSignal{"approval.approve_merge", "approval", id}
	case "POST /api/approvals/{id}/reject-merge":
		spec = panelSignal{"approval.reject_merge", "approval", id}
	default:
		return ctx
	}
	return context.WithValue(ctx, panelSignalKey{}, spec)
}

func panelFingerprint(tx *sql.Tx, spec panelSignal) (string, error) {
	var queries []string
	switch spec.object {
	case "create":
		queries = []string{`SELECT COUNT(*),COALESCE(MAX(rowid),0) FROM work_items`}
	case "item":
		queries = []string{
			`SELECT repo_id,title,status,acceptance,branch,merge_state,needs_merge FROM work_items WHERE id=?`,
			`SELECT id FROM brief_entries WHERE work_item_id=? ORDER BY id`,
			`SELECT v FROM meta WHERE k='work_management:'||?`,
		}
	case "session":
		queries = []string{`SELECT id,work_item_id,binding,started_at,ended_at,outcome FROM runs WHERE session_id=? ORDER BY id`}
	case "run":
		queries = []string{`SELECT work_item_id,binding,started_at,ended_at,outcome FROM runs WHERE id=?`}
	case "approval":
		queries = []string{`SELECT kind,status,decision,close_reason FROM approvals WHERE id=?`}
	default:
		return "", fmt.Errorf("unknown panel observation")
	}
	h := sha256.New()
	for _, query := range queries {
		var args []any
		if spec.object != "create" {
			args = []any{spec.id}
		}
		rows, err := tx.Query(query, args...)
		if err != nil {
			return "", err
		}
		columns, err := rows.Columns()
		if err != nil {
			rows.Close()
			return "", err
		}
		for rows.Next() {
			values := make([]any, len(columns))
			pointers := make([]any, len(columns))
			for i := range values {
				pointers[i] = &values[i]
			}
			if err := rows.Scan(pointers...); err != nil {
				rows.Close()
				return "", err
			}
			b, err := json.Marshal(values)
			if err != nil {
				rows.Close()
				return "", err
			}
			h.Write(b)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return "", err
		}
		rows.Close()
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// panelTx adds an observation only when a whitelisted panel operation changed its
// business object. The operation, observation and recent-signal update commit atomically.
func (c *Core) panelTx(ctx context.Context, fn func(*sql.Tx) error) error {
	spec, ok := ctx.Value(panelSignalKey{}).(panelSignal)
	if !ok {
		return c.St.Tx(ctx, fn)
	}
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		before, err := panelFingerprint(tx, spec)
		if err != nil {
			return err
		}
		if err = fn(tx); err != nil {
			return err
		}
		after, err := panelFingerprint(tx, spec)
		if err != nil {
			return err
		}
		if before == after {
			return nil
		}
		return c.recordPanelSignal(tx, spec)
	})
}

func (c *Core) recordPanelSignal(tx *sql.Tx, spec panelSignal) error {
	var sid int64
	switch spec.object {
	case "session":
		sid, _ = strconv.ParseInt(spec.id, 10, 64)
	case "run":
		if err := tx.QueryRow(`SELECT session_id FROM runs WHERE id=?`, spec.id).Scan(&sid); err != nil && err != sql.ErrNoRows {
			return err
		}
	case "approval":
		if err := tx.QueryRow(`SELECT COALESCE(session_id,0) FROM approvals WHERE id=?`, spec.id).Scan(&sid); err != nil && err != sql.ErrNoRows {
			return err
		}
	}
	var session, provider, host string
	if sid != 0 {
		if err := tx.QueryRow(`SELECT provider_session_id,provider,host_id FROM sessions WHERE id=?`, sid).Scan(&session, &provider, &host); err != nil {
			return err
		}
	}
	if provider == "" {
		provider = "other"
		host = "local"
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	at := c.St.Now()
	stamp := store.TS(at)
	ref := "panel:" + spec.action
	if spec.id != "" {
		ref += ":" + spec.id
	}
	e := event.Event{EventID: "user-" + hex.EncodeToString(random[:]), SchemaVersion: event.SchemaVersion, OccurredAt: at, ReceivedAt: at,
		Source: event.Source{Provider: provider, HostID: host, Client: "panel", Channel: "user", Ref: ref}, Kind: "user_action", RawName: spec.action, SessionID: session}
	body, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO events(event_id,session_id,kind,occurred_at,received_at,body) VALUES(?,?,?,?,?,?)`, e.EventID, nullInt(sid), e.Kind, stamp, stamp, string(body)); err != nil {
		return err
	}
	if sid != 0 {
		return updateLastSignal(tx, sid, stamp, "user")
	}
	return nil
}
