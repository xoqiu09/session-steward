package core

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

const OrchestrationContract = "ss-orchestration/v1"
const orchModeKey = "orchestration:mode"

var orchKey = regexp.MustCompile(`^[A-Za-z0-9_-]{8,80}$`)

type OrchestrationGrant struct {
	WorkItemID      string `json:"work_item_id"`
	Revision        string `json:"revision"`
	Input           string `json:"input"`
	StoreInput      bool   `json:"store_input"`
	MaxTurns        int    `json:"max_turns"`
	ExpiresMinutes  int    `json:"expires_minutes"`
	FailureFollowup bool   `json:"failure_followup"`
}
type OrchestrationMandate struct {
	WorkItemID      string `json:"work_item_id"`
	Revision        string `json:"revision"`
	Basis           string `json:"basis"`
	ExpiresAt       string `json:"expires_at"`
	MaxTurns        int    `json:"max_turns"`
	Turns           int    `json:"turns"`
	FailureFollowup bool   `json:"failure_followup"`
	Revoked         bool   `json:"revoked"`
	EventCursor     int64  `json:"-"`
	CreatedAt       string `json:"created_at"`
}
type OrchestrationAssignment struct {
	HostID string `json:"host_id"`

	WorkItemID string `json:"work_item_id"`
	ManagedID  string `json:"managed_id"`
	Epoch      int    `json:"epoch"`
}
type OrchestrationDelivery struct {
	ID         string `json:"id"`
	WorkItemID string `json:"work_item_id"`
	Revision   string `json:"revision"`
	Epoch      int    `json:"epoch"`
	SourceID   string `json:"source_id"`
	Kind       string `json:"kind"`
	Input      string `json:"-"`
	InputHash  string `json:"-"`
	State      string `json:"state"`
	Reason     string `json:"reason"`
	Attempts   int    `json:"attempts"`
	DueAt      string `json:"due_at"`
	Receipt    string `json:"receipt"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}
type OrchestrationFinding struct {
	ID         string `json:"id"`
	WorkItemID string `json:"work_item_id"`
	Rule       string `json:"rule"`
	Scope      string `json:"scope"`
	State      string `json:"state"`
	Fact       string `json:"fact"`
	Basis      string `json:"basis"`
	OpenedAt   string `json:"opened_at"`
	UpdatedAt  string `json:"updated_at"`
}
type OrchestrationView struct {
	Contract    string                    `json:"contract"`
	Mode        string                    `json:"mode"`
	Available   bool                      `json:"available"`
	Mandates    []OrchestrationMandate    `json:"mandates"`
	Assignments []OrchestrationAssignment `json:"assignments"`
	Deliveries  []OrchestrationDelivery   `json:"deliveries"`
	Findings    []OrchestrationFinding    `json:"findings"`
	TokenUsage  string                    `json:"token_usage"`
	Steer       string                    `json:"steer"`
	RealCI      string                    `json:"real_ci"`
}

// Execution state is observation, never work completion or user acceptance.
type OrchestrationExecution struct {
	Busy bool
	Held string
}
type OrchestrationReceipt struct {
	Outcome string
	Turn    string
} // acknowledged|unsent|held|uncertain
// Executor receives no permission to approve tools. authorize is rechecked immediately before turn/start.
type OrchestrationExecutor interface {
	OrchestrationState(context.Context, string) (OrchestrationExecution, error)
	OrchestrationDeliver(context.Context, OrchestrationAssignment, string, string, func() bool) (OrchestrationReceipt, error)
}

func orchHash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func orchAudit(tx *sql.Tx, item, action, reason, now string) error {
	_, err := tx.Exec(`INSERT INTO orchestration_audit(work_item_id,action,reason,at) VALUES(?,?,?,?)`, item, action, reason, now)
	if err != nil {
		return err
	}
	return store.Touch(tx, now, "orchestration", item)
}
func (c *Core) OrchestrationMode(ctx context.Context) (string, error) {
	v, err := c.St.Meta(ctx, orchModeKey)
	if v == "" {
		v = "disabled"
	}
	return v, err
}
func (c *Core) SetOrchestrationMode(ctx context.Context, mode string) error {
	if mode != "disabled" && mode != "observe" && mode != "enabled" {
		return fmt.Errorf("%w: 无效编排模式", ErrBadRequest)
	}
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, orchModeKey, mode)
		if err != nil {
			return err
		}
		return orchAudit(tx, "", "mode", mode, c.St.NowTS())
	})
	c.notify()
	return err
}
func orchBasis(q interface{ QueryRow(string, ...any) *sql.Row }, item string) (string, int64, string, error) {
	var title, acceptance, status, goal, common, target string
	var repo int64
	err := q.QueryRow(`SELECT w.title,w.acceptance,w.status,COALESCE(w.repo_id,0),COALESCE(r.common_dir,''),COALESCE(r.target_ref,'') FROM work_items w LEFT JOIN repos r ON r.id=w.repo_id WHERE w.id=?`, item).Scan(&title, &acceptance, &status, &repo, &common, &target)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, "", ErrNotFound
	}
	if err != nil {
		return "", 0, "", err
	}
	if strings.TrimSpace(acceptance) == "" {
		return "", 0, "", fmt.Errorf("%w: 请先为工作项填写验收条件", ErrBadRequest)
	}
	err = q.QueryRow(`SELECT text FROM brief_entries WHERE work_item_id=? AND field='goal' AND flagged='' ORDER BY at DESC,id DESC LIMIT 1`, item).Scan(&goal)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", 0, "", err
	}
	return orchHash(fmt.Sprint(repo) + "\x00" + common + "\x00" + target + "\x00" + title + "\x00" + acceptance + "\x00" + goal), repo, status, nil
}
func orchInput(s string, allow bool) error {
	if strings.TrimSpace(s) == "" || !utf8.ValidString(s) || utf8.RuneCountInString(s) > 4096 || !allow || event.Redact(s) != s {
		return fmt.Errorf("%w: 请允许暂存不含凭据且不超过4096字的任务要求", ErrBadRequest)
	}
	return nil
}

// GrantOrchestration is a trusted local-user entry point. It is never exposed to hooks or hub.
func (c *Core) GrantOrchestration(ctx context.Context, g OrchestrationGrant) error {
	if !orchKey.MatchString(g.Revision) {
		return fmt.Errorf("%w: 无效授权操作号", ErrBadRequest)
	}
	if err := orchInput(g.Input, g.StoreInput); err != nil {
		return err
	}
	if g.MaxTurns == 0 {
		g.MaxTurns = 10
	}
	if g.ExpiresMinutes == 0 {
		g.ExpiresMinutes = 240
	}
	if g.MaxTurns < 1 || g.MaxTurns > 100 || g.ExpiresMinutes < 1 || g.ExpiresMinutes > 240 {
		return ErrBadRequest
	}
	encoded, _ := json.Marshal(g)
	requestHash := orchHash(string(encoded))
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		basis, repo, status, err := orchBasis(tx, g.WorkItemID)
		if err != nil {
			return err
		}
		if status == "done" || status == "abandoned" || status == "review" {
			return fmt.Errorf("%w: 先在工作项明确退回或重开，再授权", ErrConflict)
		}
		var allowed int
		if err = tx.QueryRow(`SELECT count(*) FROM dispatch_projects WHERE repo_id=?`, repo).Scan(&allowed); err != nil {
			return err
		}
		if allowed != 1 {
			return ErrForbidden
		}
		var old string
		err = tx.QueryRow(`SELECT revision FROM orchestration_mandates WHERE work_item_id=?`, g.WorkItemID).Scan(&old)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if old == g.Revision {
			var hash, previousBasis string
			if err = tx.QueryRow(`SELECT request_hash,basis FROM orchestration_mandates WHERE work_item_id=? AND revision=?`, g.WorkItemID, g.Revision).Scan(&hash, &previousBasis); err != nil {
				return err
			}
			if hash != requestHash || previousBasis != basis {
				return ErrConflict
			}
			return nil
		}
		_, err = tx.Exec(`UPDATE orchestration_deliveries SET state='cancelled',reason='authorization_changed',input='',updated_at=? WHERE work_item_id=? AND state NOT IN ('acknowledged','uncertain','sending')`, now, g.WorkItemID)
		if err != nil {
			return err
		}
		var cursor int64
		if err = tx.QueryRow(`SELECT COALESCE(MAX(seq),0) FROM events`).Scan(&cursor); err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT INTO orchestration_mandates(work_item_id,revision,basis,request_hash,expires_at,max_turns,failure_followup,event_cursor,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(work_item_id) DO UPDATE SET revision=excluded.revision,basis=excluded.basis,request_hash=excluded.request_hash,expires_at=excluded.expires_at,max_turns=excluded.max_turns,turns=0,failure_followup=excluded.failure_followup,event_cursor=excluded.event_cursor,revoked=0,created_at=excluded.created_at`, g.WorkItemID, g.Revision, basis, requestHash, store.TS(c.St.Now().Add(time.Duration(g.ExpiresMinutes)*time.Minute)), g.MaxTurns, g.FailureFollowup, cursor, now)
		if err != nil {
			return err
		}

		// An explicit grant can adopt the unique existing native managed execution of this work item.
		var existingCount int
		if err = tx.QueryRow(`SELECT count(*) FROM managed_sessions WHERE work_item_id=? AND runner='codex_app' AND state<>'archived'`, g.WorkItemID).Scan(&existingCount); err != nil {
			return err
		}
		if existingCount > 1 {
			return fmt.Errorf("%w: 工作项存在多份原生托管记录，请先核对归属", ErrConflict)
		}
		if existingCount == 1 && c.OrchHostID != "" {
			_, err = tx.Exec(`INSERT INTO orchestration_assignments(work_item_id,managed_id,epoch,host_id,created_at) SELECT work_item_id,id,1,?,? FROM managed_sessions WHERE work_item_id=? AND runner='codex_app' AND state<>'archived' ON CONFLICT(work_item_id) DO NOTHING`, c.OrchHostID, now, g.WorkItemID)
			if err != nil {
				return err
			}
		}
		_, err = tx.Exec(`UPDATE orchestration_assignments SET epoch=epoch+1 WHERE work_item_id=?`, g.WorkItemID)
		if err != nil {
			return err
		}
		if err = orchEnqueue(tx, g.WorkItemID, g.Revision, "grant:"+g.Revision, "initial", g.Input, now); err != nil {
			return err
		}
		return orchAudit(tx, g.WorkItemID, "grant", g.Revision, now)
	})
	c.notify()
	return err
}
func orchEnqueue(tx *sql.Tx, item, rev, source, kind, input, now string) error {
	var hash string
	err := tx.QueryRow(`SELECT input_hash FROM orchestration_deliveries WHERE work_item_id=? AND source_id=?`, item, source).Scan(&hash)
	if err == nil {
		if hash != orchHash(input) {
			return ErrConflict
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var count int
	if err = tx.QueryRow(`SELECT count(*) FROM orchestration_deliveries WHERE work_item_id=? AND state IN ('queued','waiting_boundary','retry_wait','sending','held','uncertain')`, item).Scan(&count); err != nil {
		return err
	}
	if count >= 100 {
		return fmt.Errorf("%w: 收件箱已满，事件尚未接纳", ErrConflict)
	}
	_, err = tx.Exec(`INSERT INTO orchestration_deliveries(id,work_item_id,revision,source_id,kind,input,input_hash,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`, orchHash(item+"\x00"+source), item, rev, source, kind, input, orchHash(input), now, now, now)
	return err
}
func (c *Core) OrchestrationFeedback(ctx context.Context, item, rev, source, input string, allow bool) error {
	if !orchKey.MatchString(source) {
		return ErrBadRequest
	}
	if err := orchInput(input, allow); err != nil {
		return err
	}
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		var current string
		var revoked bool
		var expires string
		if err := tx.QueryRow(`SELECT revision,revoked,expires_at FROM orchestration_mandates WHERE work_item_id=?`, item).Scan(&current, &revoked, &expires); err != nil {
			return err
		}
		if current != rev || revoked || expires <= c.St.NowTS() {
			return ErrConflict
		}
		var status string
		if err := tx.QueryRow(`SELECT status FROM work_items WHERE id=?`, item).Scan(&status); err != nil {
			return err
		}
		if status == "review" || status == "done" || status == "abandoned" {
			return fmt.Errorf("%w: 先在工作项明确退回修改", ErrConflict)
		}
		if err := orchEnqueue(tx, item, rev, "user:"+source, "user_feedback", input, c.St.NowTS()); err != nil {
			return err
		}
		return orchAudit(tx, item, "feedback", "user", c.St.NowTS())
	})
	c.notify()
	return err
}
func (c *Core) RevokeOrchestration(ctx context.Context, item, revision string) error {
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.Exec(`UPDATE orchestration_mandates SET revoked=1 WHERE work_item_id=? AND revision=?`, item, revision)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n != 1 {
			return ErrConflict
		}
		if _, err = tx.Exec(`UPDATE orchestration_assignments SET epoch=epoch+1 WHERE work_item_id=?`, item); err != nil {
			return err
		}
		if _, err = tx.Exec(`UPDATE orchestration_deliveries SET state='cancelled',reason='revoked',input='',updated_at=? WHERE work_item_id=? AND state NOT IN ('acknowledged','uncertain','sending')`, now, item); err != nil {
			return err
		}
		return orchAudit(tx, item, "revoke", revision, now)
	})
	c.notify()
	return err
}
func (c *Core) OrchestrationView(ctx context.Context) (OrchestrationView, error) {
	mode, err := c.OrchestrationMode(ctx)
	v := OrchestrationView{Contract: OrchestrationContract, Mode: mode, Available: c.OrchExecutor != nil, Mandates: []OrchestrationMandate{}, Assignments: []OrchestrationAssignment{}, Deliveries: []OrchestrationDelivery{}, Findings: []OrchestrationFinding{}, TokenUsage: "unknown", Steer: "unsupported", RealCI: "not_verified"}
	if err != nil {
		return v, err
	}
	rows, err := c.St.R().QueryContext(ctx, `SELECT work_item_id,revision,basis,expires_at,max_turns,turns,failure_followup,revoked,event_cursor,created_at FROM orchestration_mandates ORDER BY created_at,work_item_id`)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var m OrchestrationMandate
		if err = rows.Scan(&m.WorkItemID, &m.Revision, &m.Basis, &m.ExpiresAt, &m.MaxTurns, &m.Turns, &m.FailureFollowup, &m.Revoked, &m.EventCursor, &m.CreatedAt); err != nil {
			rows.Close()
			return v, err
		}
		v.Mandates = append(v.Mandates, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	rows, err = c.St.R().QueryContext(ctx, `SELECT work_item_id,managed_id,epoch,host_id FROM orchestration_assignments`)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var a OrchestrationAssignment
		if err = rows.Scan(&a.WorkItemID, &a.ManagedID, &a.Epoch, &a.HostID); err != nil {
			rows.Close()
			return v, err
		}
		v.Assignments = append(v.Assignments, a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	rows, err = c.St.R().QueryContext(ctx, `SELECT id,work_item_id,revision,epoch,source_id,kind,input_hash,state,reason,attempts,due_at,receipt,created_at,updated_at FROM orchestration_deliveries WHERE state NOT IN ('acknowledged','cancelled') OR id IN (SELECT id FROM orchestration_deliveries ORDER BY rowid DESC LIMIT 500) ORDER BY created_at DESC,id`)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var d OrchestrationDelivery
		if err = rows.Scan(&d.ID, &d.WorkItemID, &d.Revision, &d.Epoch, &d.SourceID, &d.Kind, &d.InputHash, &d.State, &d.Reason, &d.Attempts, &d.DueAt, &d.Receipt, &d.CreatedAt, &d.UpdatedAt); err != nil {
			rows.Close()
			return v, err
		}
		v.Deliveries = append(v.Deliveries, d)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	rows, err = c.St.R().QueryContext(ctx, `SELECT id,work_item_id,rule,scope,state,fact,basis,opened_at,updated_at FROM orchestration_findings ORDER BY opened_at DESC LIMIT 100`)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var f OrchestrationFinding
		if err = rows.Scan(&f.ID, &f.WorkItemID, &f.Rule, &f.Scope, &f.State, &f.Fact, &f.Basis, &f.OpenedAt, &f.UpdatedAt); err != nil {
			rows.Close()
			return v, err
		}
		v.Findings = append(v.Findings, f)
	}
	err = rows.Err()
	rows.Close()
	return v, err
}

// RecoverOrchestration never replays an RPC whose result was not durably acknowledged.
func (c *Core) RecoverOrchestration(ctx context.Context) error {
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE orchestration_deliveries SET state='uncertain',reason='restart_after_admission',updated_at=? WHERE state='sending'`, c.St.NowTS())
		return err
	})
}

// ReconcileOrchestrationDelivery is explicit local-user reconciliation, never an automatic retry.
func (c *Core) ReconcileOrchestrationDelivery(ctx context.Context, id, revision, action string) error {
	if action != "verify_receipt" && action != "close_unknown" {
		return ErrBadRequest
	}
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		var item, rev, state string
		if e := tx.QueryRow(`SELECT work_item_id,revision,state FROM orchestration_deliveries WHERE id=?`, id).Scan(&item, &rev, &state); e != nil {
			return e
		}
		if revision != rev || state != "uncertain" {
			return ErrConflict
		}
		to, reason, turn := "cancelled", "user_closed_unknown", ""
		if action == "verify_receipt" {
			if e := tx.QueryRow(`SELECT o.turn FROM dispatch_ops o JOIN orchestration_assignments a ON a.managed_id=o.managed_id WHERE a.work_item_id=? AND o.op=?`, item, id).Scan(&turn); e != nil {
				return fmt.Errorf("%w: 尚无可核对的原生接纳回执", ErrConflict)
			}
			if turn == "" {
				return fmt.Errorf("%w: 尚无可核对的原生接纳回执", ErrConflict)
			}
			to, reason = "acknowledged", "native_accepted"
		}
		if _, e := tx.Exec(`UPDATE orchestration_deliveries SET state=?,reason=?,receipt=?,input='',updated_at=? WHERE id=? AND state='uncertain'`, to, reason, turn, c.St.NowTS(), id); e != nil {
			return e
		}
		findingState := "closed_by_user"
		if action == "verify_receipt" {
			findingState = "resolved"
		}
		if _, e := tx.Exec(`UPDATE orchestration_findings SET state=?,updated_at=? WHERE work_item_id=? AND rule='delivery_unknown' AND scope=?`, findingState, c.St.NowTS(), item, id); e != nil {
			return e
		}

		return orchAudit(tx, item, "user_reconcile", reason, c.St.NowTS())
	})
	c.notify()
	return err
}

// ReturnOrchestrationEvent is used only by a currently bound native execution tool.
// It records a routing question; it neither changes work completion nor grants a new task.
func (c *Core) ReturnOrchestrationEvent(ctx context.Context, managed, item, id, turn, reason string) error {
	if reason != "unrelated" && reason != "missing_scope" && reason != "missing_evidence" {
		return ErrBadRequest
	}
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		var state, currentReason string
		var epoch, ownerEpoch int
		if e := tx.QueryRow(`SELECT d.state,d.reason,d.epoch,a.epoch FROM orchestration_deliveries d JOIN orchestration_assignments a ON a.work_item_id=d.work_item_id WHERE d.id=? AND d.work_item_id=? AND a.managed_id=?`, id, item, managed).Scan(&state, &currentReason, &epoch, &ownerEpoch); e != nil {
			return ErrForbidden
		}
		if epoch != ownerEpoch {
			return ErrConflict
		}
		if state == "held" && strings.HasPrefix(currentReason, "route_") {
			return nil
		}
		if state != "acknowledged" && state != "sending" {
			return ErrConflict
		}
		var recorded string
		if e := tx.QueryRow(`SELECT turn FROM dispatch_ops WHERE managed_id=? AND op=?`, managed, id).Scan(&recorded); e != nil || recorded == "" || recorded != turn {
			return ErrConflict
		}
		if _, e := tx.Exec(`UPDATE orchestration_deliveries SET state='held',reason=?,receipt=?,input='',updated_at=? WHERE id=?`, "route_"+reason, turn, c.St.NowTS(), id); e != nil {
			return e
		}
		return orchAudit(tx, item, "event_returned", reason+":"+id, c.St.NowTS())
	})
}
