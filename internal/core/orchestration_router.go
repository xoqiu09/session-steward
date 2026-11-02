package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/store"
)

func (c *Core) orchEligibility(ctx context.Context, item, revision string) (OrchestrationMandate, string, error) {
	var m OrchestrationMandate
	err := c.St.R().QueryRowContext(ctx, `SELECT work_item_id,revision,basis,expires_at,max_turns,turns,failure_followup,revoked,event_cursor,created_at FROM orchestration_mandates WHERE work_item_id=?`, item).Scan(&m.WorkItemID, &m.Revision, &m.Basis, &m.ExpiresAt, &m.MaxTurns, &m.Turns, &m.FailureFollowup, &m.Revoked, &m.EventCursor, &m.CreatedAt)
	if err != nil {
		return m, "", err
	}
	if m.Revision != revision || m.Revoked {
		return m, "revoked", nil
	}
	if m.ExpiresAt <= c.St.NowTS() {
		return m, "expired", nil
	}
	basis, repo, status, err := orchBasis(c.St.R(), item)
	if err != nil {
		if errors.Is(err, ErrBadRequest) || errors.Is(err, ErrNotFound) {
			return m, "target_unavailable", nil
		}
		return m, "target_unavailable", err
	}
	if basis != m.Basis {
		return m, "target_changed", nil
	}
	switch status {
	case "done", "abandoned":
		return m, "work_closed", nil
	case "review":
		return m, "awaiting_review", nil
	}
	var allowed int
	err = c.St.R().QueryRowContext(ctx, `SELECT count(*) FROM dispatch_projects WHERE repo_id=? AND NOT EXISTS(SELECT 1 FROM meta WHERE k='repo_archive:'||? AND v<>'')`, repo, repo).Scan(&allowed)
	if err != nil {
		return m, "", err
	}
	if allowed == 0 {
		return m, "project_not_allowed", nil
	}
	snap, err := c.Snapshot(ctx)
	if err != nil {
		return m, "", err
	}
	for _, w := range snap.WorkItems {
		if w.ID != item {
			continue
		}
		if w.Management != nil && (w.Management.State == "paused" || w.Management.State == "delegated") {
			return m, "user_managed", nil
		}
		if !w.Ready {
			return m, "dependency_wait", nil
		}
	}
	for _, a := range snap.Approvals {
		if a.Status == "pending" && a.WorkItemID != nil && *a.WorkItemID == item {
			return m, "approval_wait", nil
		}
	}

	var wrongHost int
	if e := c.St.R().QueryRowContext(ctx, `SELECT count(*) FROM orchestration_assignments WHERE work_item_id=? AND host_id<>?`, item, c.OrchHostID).Scan(&wrongHost); e != nil {
		return m, "", e
	}
	if wrongHost > 0 {
		return m, "execution_host_changed", nil
	}
	var unknown int
	if e := c.St.R().QueryRowContext(ctx, `SELECT count(*) FROM orchestration_deliveries WHERE work_item_id=? AND state='uncertain'`, item).Scan(&unknown); e != nil {
		return m, "", e
	}
	if unknown > 0 {
		return m, "execution_unknown", nil
	}
	var other int
	err = c.St.R().QueryRowContext(ctx, `SELECT count(*) FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.work_item_id=? AND r.ended_at='' AND s.state IN ('running','waiting_permission') AND NOT EXISTS(SELECT 1 FROM orchestration_assignments a JOIN managed_sessions m ON m.id=a.managed_id WHERE a.work_item_id=r.work_item_id AND m.native_thread=s.provider_session_id AND s.provider='codex' AND s.host_id=a.host_id)`, item).Scan(&other)
	if err != nil {
		return m, "", err
	}
	if other > 0 {
		return m, "existing_worker", nil
	}
	// Never restart an existing unmanaged task from main and silently lose its context.
	var sourceBranch, assignedBranch string
	if e := c.St.R().QueryRowContext(ctx, `SELECT w.branch,COALESCE((SELECT m.branch FROM orchestration_assignments a JOIN managed_sessions m ON m.id=a.managed_id WHERE a.work_item_id=w.id),'') FROM work_items w WHERE w.id=?`, item).Scan(&sourceBranch, &assignedBranch); e != nil {
		return m, "", e
	}
	if distinctBranch(sourceBranch) && sourceBranch != assignedBranch {
		return m, "handoff_required", nil
	}
	var priorUnmanaged int
	if e := c.St.R().QueryRowContext(ctx, `SELECT count(*) FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.work_item_id=? AND s.host_id=? AND NOT EXISTS(SELECT 1 FROM orchestration_assignments a JOIN managed_sessions m ON m.id=a.managed_id WHERE a.work_item_id=r.work_item_id AND m.native_thread=s.provider_session_id AND s.provider='codex' AND a.host_id=s.host_id)`, item, c.OrchHostID).Scan(&priorUnmanaged); e != nil {
		return m, "", e
	}
	if priorUnmanaged > 0 {
		return m, "handoff_required", nil
	}
	return m, "", nil
}
func (c *Core) orchAssignment(ctx context.Context, item string) (OrchestrationAssignment, error) {
	var a OrchestrationAssignment
	err := c.St.R().QueryRowContext(ctx, `SELECT work_item_id,managed_id,epoch,host_id FROM orchestration_assignments WHERE work_item_id=?`, item).Scan(&a.WorkItemID, &a.ManagedID, &a.Epoch, &a.HostID)
	return a, err
}

// Reserve a stable managed ID before any directory side effect. No second task/session store.
func (c *Core) reserveOrchestration(ctx context.Context, item string) (OrchestrationAssignment, error) {
	if a, err := c.orchAssignment(ctx, item); err == nil {
		return a, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return a, err
	}
	var common, name, target, title string
	var repo int64
	err := c.St.R().QueryRowContext(ctx, `SELECT r.id,r.common_dir,r.name,r.target_ref,w.title FROM work_items w JOIN repos r ON r.id=w.repo_id WHERE w.id=? AND r.is_git=1`, item).Scan(&repo, &common, &name, &target, &title)
	if err != nil {
		return OrchestrationAssignment{}, err
	}
	base := gitx.RevParse(ctx, common, target)
	if base == "" {
		return OrchestrationAssignment{}, fmt.Errorf("%w: 无法核实项目基线", ErrConflict)
	}
	id := shortID()
	if c.OrchHostID == "" {
		return OrchestrationAssignment{}, ErrForbidden
	}
	a := OrchestrationAssignment{WorkItemID: item, ManagedID: id, Epoch: 1, HostID: c.OrchHostID}
	dir := c.worktreeDir(common, name, id)
	branch := "steward/" + id
	now := c.St.NowTS()
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		var existing OrchestrationAssignment
		e := tx.QueryRow(`SELECT work_item_id,managed_id,epoch,host_id FROM orchestration_assignments WHERE work_item_id=?`, item).Scan(&existing.WorkItemID, &existing.ManagedID, &existing.Epoch, &existing.HostID)
		if e == nil {
			a = existing
			return nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		_, e = tx.Exec(`INSERT INTO managed_sessions(id,repo_id,agent,command,title,work_item_id,worktree,branch,base_sha,tmux_name,state,created_at,updated_at,runner,native_status) VALUES(?,?,'codex','["codex","app-server"]',?,?,?,?,?,'','starting',?,?,'codex_app','ready')`, id, repo, title, item, dir, branch, base, now, now)
		if e != nil {
			return e
		}
		if _, e = tx.Exec(`INSERT INTO orchestration_assignments(work_item_id,managed_id,epoch,host_id,created_at) VALUES(?,?,1,?,?)`, item, id, c.OrchHostID, now); e != nil {
			return e
		}
		return orchAudit(tx, item, "assignment_reserved", id, now)
	})
	return a, err
}

// ProvisionOrchestration reuses the recorded branch/path. It never removes a worktree.
func (c *Core) ProvisionOrchestration(ctx context.Context, a OrchestrationAssignment) error {
	c.launchMu.Lock()
	defer c.launchMu.Unlock()
	var dir, branch, base, common string
	err := c.St.R().QueryRowContext(ctx, `SELECT m.worktree,m.branch,m.base_sha,r.common_dir FROM orchestration_assignments a JOIN managed_sessions m ON m.id=a.managed_id JOIN repos r ON r.id=m.repo_id WHERE a.work_item_id=? AND a.managed_id=? AND a.epoch=?`, a.WorkItemID, a.ManagedID, a.Epoch).Scan(&dir, &branch, &base, &common)
	if err != nil {
		return err
	}
	if st, e := os.Lstat(dir); e == nil {
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return ErrConflict
		}
		b, e := gitWrite(ctx, dir, "symbolic-ref", "--short", "HEAD")
		if e != nil || b != branch {
			return ErrConflict
		}
		cd, e := gitWrite(ctx, dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
		if e != nil {
			return e
		}
		got, e := filepath.EvalSymlinks(cd)
		if e != nil {
			return e
		}
		want, e := filepath.EvalSymlinks(common)
		if e != nil || got != want {
			return ErrConflict
		}
		_, e = gitWrite(ctx, dir, "merge-base", "--is-ancestor", base, "HEAD")
		return e
	} else if !errors.Is(e, os.ErrNotExist) {
		return e
	}
	if err = os.MkdirAll(filepath.Dir(dir), 0755); err != nil {
		return err
	}
	if previous := gitx.RevParse(ctx, common, "refs/heads/"+branch); previous != "" {
		if previous != base {
			return ErrConflict
		}
		_, err = gitWrite(ctx, common, "--git-dir="+common, "worktree", "add", dir, branch)
	} else {
		_, err = gitWrite(ctx, common, "--git-dir="+common, "worktree", "add", "-b", branch, dir, base)
	}
	return err
}

func (c *Core) orchDeliveryState(ctx context.Context, id, state, reason string) error {
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE orchestration_deliveries SET state=?,reason=?,updated_at=? WHERE id=? AND state NOT IN ('acknowledged','uncertain','sending','cancelled') AND (state<>? OR reason<>?)`, state, reason, c.St.NowTS(), id, state, reason)
		return err
	})
}
func (c *Core) pumpOrchestrationEvents(ctx context.Context, m OrchestrationMandate) error {
	if !m.FailureFollowup {
		return nil
	}
	a, err := c.orchAssignment(ctx, m.WorkItemID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	// Only this worker's bound execution metadata. No event text, no arbitrary user prompts.
	rows, err := c.St.R().QueryContext(ctx, `SELECT DISTINCT e.seq,e.event_id,e.kind,e.occurred_at,COALESCE(json_extract(e.body,'$.candidate'),'') FROM events e JOIN runs r ON r.session_id=e.session_id JOIN sessions s ON s.id=e.session_id JOIN managed_sessions ms ON ms.native_thread=s.provider_session_id AND s.provider='codex' JOIN orchestration_assignments oa ON oa.managed_id=ms.id AND oa.work_item_id=r.work_item_id AND s.host_id=oa.host_id WHERE r.work_item_id=? AND ms.id=? AND e.seq>? AND e.occurred_at>=r.started_at AND (r.ended_at='' OR e.occurred_at<=r.ended_at) ORDER BY e.seq LIMIT 100`, m.WorkItemID, a.ManagedID, m.EventCursor)
	if err != nil {
		return err
	}
	type entry struct {
		seq                     int64
		id, kind, at, candidate string
	}
	var entries []entry
	for rows.Next() {
		var e entry
		if err = rows.Scan(&e.seq, &e.id, &e.kind, &e.at, &e.candidate); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	candidate := c.ManagedCandidate(ctx, a.ManagedID)
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		for _, e := range entries {
			if e.kind == "tool_fail" && e.at >= m.CreatedAt && candidate != "" && e.candidate == candidate {
				if err := orchEnqueue(tx, m.WorkItemID, m.Revision, "event:"+e.id, "execution_failure", "本工作项执行工具出现失败观察。请核对当前候选、最近执行和原目标，在原授权内决定是否还需要处理；不要把旧候选失败当成新候选结论。", c.St.NowTS()); err != nil {
					if errors.Is(err, ErrConflict) {
						break
					}
					return err
				}
			}
			if _, err := tx.Exec(`UPDATE orchestration_mandates SET event_cursor=? WHERE work_item_id=? AND revision=?`, e.seq, m.WorkItemID, m.Revision); err != nil {
				return err
			}
		}
		return nil
	})
}
func (c *Core) OrchestrationRun(ctx context.Context) {
	ch, cancel := c.Subscribe()
	defer cancel()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ch:
		case <-tick.C:
		}
		if ctx.Err() != nil {
			return
		}
		_ = c.OrchestrationTick(ctx)
	}
}
func (c *Core) OrchestrationTick(ctx context.Context) error {
	if !c.orchMu.TryLock() {
		return nil
	}
	defer c.orchMu.Unlock()
	if err := c.purgeOrchestrationInputs(ctx); err != nil {
		return err
	}
	mode, err := c.OrchestrationMode(ctx)
	if err != nil || mode == "disabled" {
		return err
	}
	view, err := c.OrchestrationView(ctx)
	if err != nil {
		return err
	}
	for _, m := range view.Mandates {
		if _, reason, e := c.orchEligibility(ctx, m.WorkItemID, m.Revision); e == nil && reason == "" {
			if err = c.pumpOrchestrationEvents(ctx, m); err != nil {
				return err
			}
		}
	}
	if mode == "enabled" && c.OrchExecutor != nil {
		// Query durable queue directly; the bounded UI history is not the dispatch queue.
		cursorText, e := c.St.Meta(ctx, "orchestration:dispatch_cursor")
		if e != nil {
			return e
		}
		cursor, _ := strconv.ParseInt(cursorText, 10, 64)
		rows, e := c.St.R().QueryContext(ctx, `SELECT id,rowid FROM orchestration_deliveries WHERE state IN ('queued','waiting_boundary','retry_wait','held') AND due_at<=? ORDER BY CASE WHEN rowid>? THEN 0 ELSE 1 END,rowid LIMIT 200`, c.St.NowTS(), cursor)
		if e != nil {
			return e
		}
		var ids []string
		var lastRow int64
		for rows.Next() {
			var id string
			if e = rows.Scan(&id, &lastRow); e != nil {
				rows.Close()
				return e
			}
			ids = append(ids, id)
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return e
		}
		for _, id := range ids {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if err = c.deliverOrchestration(ctx, id); err != nil {
				return err
			}
		}
		if len(ids) > 0 {
			if err = c.St.SetMeta(ctx, "orchestration:dispatch_cursor", strconv.FormatInt(lastRow, 10)); err != nil {
				return err
			}
		}
	}
	if c.orchWatchAt.IsZero() || c.St.Now().Sub(c.orchWatchAt) >= time.Minute {
		if err = c.checkOrchestration(ctx); err != nil {
			return err
		}
		c.orchWatchAt = c.St.Now()
	}
	return nil
}
func (c *Core) deliverOrchestration(ctx context.Context, id string) error {
	var d OrchestrationDelivery
	err := c.St.R().QueryRowContext(ctx, `SELECT id,work_item_id,revision,epoch,source_id,kind,input,input_hash,state,reason,attempts,due_at,receipt,created_at,updated_at FROM orchestration_deliveries WHERE id=?`, id).Scan(&d.ID, &d.WorkItemID, &d.Revision, &d.Epoch, &d.SourceID, &d.Kind, &d.Input, &d.InputHash, &d.State, &d.Reason, &d.Attempts, &d.DueAt, &d.Receipt, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		return err
	}
	if d.Reason == "input_expired" || d.Reason == "retry_exhausted" || strings.HasPrefix(d.Reason, "route_") {
		return nil
	}
	created, e := time.Parse(time.RFC3339Nano, d.CreatedAt)
	if e != nil {
		return e
	}
	if c.St.Now().Sub(created) >= 24*time.Hour {
		return c.St.Tx(ctx, func(tx *sql.Tx) error {
			_, e := tx.Exec(`UPDATE orchestration_deliveries SET input='',state='held',reason='input_expired',updated_at=? WHERE id=?`, c.St.NowTS(), id)
			return e
		})
	}
	m, reason, err := c.orchEligibility(ctx, d.WorkItemID, d.Revision)
	if err != nil {
		return err
	}
	if reason != "" {
		return c.orchDeliveryState(ctx, id, "held", reason)
	}
	if d.Attempts == 0 && m.Turns >= m.MaxTurns {
		return c.orchDeliveryState(ctx, id, "held", "turn_budget")
	}
	// Count observed activity from existing managed records, including unknown in-flight work.
	snap, err := c.Snapshot(ctx)
	if err != nil {
		return err
	}
	var repo int64
	for _, w := range snap.WorkItems {
		if w.ID == d.WorkItemID && w.RepoID != nil {
			repo = *w.RepoID
		}
	}
	active := 0
	projectBusy := false
	nativeRows, err := c.DispatchRows(ctx)
	if err != nil {
		return err
	}

	for _, ms := range snap.Managed {
		if ms.State == "running" || ms.State == "starting" {
			active++
			if ms.RepoID == repo {
				projectBusy = true
			}
		}
	}
	for _, row := range nativeRows {
		state, e := c.OrchExecutor.OrchestrationState(ctx, row.ID)
		if e != nil {
			return e
		}
		if state.Busy || state.Held == "needs_reconcile" || state.Held == "uncertain" {
			active++
			if row.RepoID == repo {
				projectBusy = true
			}
		}
	}
	a, e := c.orchAssignment(ctx, d.WorkItemID)
	if e != nil && !errors.Is(e, sql.ErrNoRows) {
		return e
	}
	if e == nil {
		state, e := c.OrchExecutor.OrchestrationState(ctx, a.ManagedID)
		if e != nil {
			return e
		}
		if state.Busy {
			return c.orchDeliveryState(ctx, id, "waiting_boundary", "worker_busy")
		}
		if state.Held != "" {
			return c.orchDeliveryState(ctx, id, "held", state.Held)
		}
	}
	if active >= 2 || projectBusy {
		return c.orchDeliveryState(ctx, id, "held", "capacity_wait")
	}
	if a.ManagedID == "" {
		a, e = c.reserveOrchestration(ctx, d.WorkItemID)
		if e != nil {
			return c.orchDeliveryState(ctx, id, "held", "baseline_unavailable")
		}
	}

	boundCandidate := ""
	if d.Kind == "execution_failure" {
		if e := c.St.R().QueryRowContext(ctx, `SELECT COALESCE(json_extract(body,'$.candidate'),'') FROM events WHERE event_id=?`, strings.TrimPrefix(d.SourceID, "event:")).Scan(&boundCandidate); e != nil {
			return e
		}
		current := c.ManagedCandidate(ctx, a.ManagedID)
		if boundCandidate == "" || current == "" {
			return c.orchDeliveryState(ctx, id, "held", "candidate_unavailable")
		}
		if boundCandidate != current {
			return c.St.Tx(ctx, func(tx *sql.Tx) error {
				_, e := tx.Exec(`UPDATE orchestration_deliveries SET state='cancelled',reason='candidate_changed',input='',updated_at=? WHERE id=? AND state IN ('queued','held','waiting_boundary','retry_wait')`, c.St.NowTS(), id)
				return e
			})
		}
	}
	admitted := false
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		var mode string
		if e := tx.QueryRow(`SELECT v FROM meta WHERE k=?`, orchModeKey).Scan(&mode); e != nil {
			return e
		}
		if mode != "enabled" {
			return nil
		}
		var revision string
		var revoked bool
		var expires string
		var turns, max int
		if e := tx.QueryRow(`SELECT revision,revoked,expires_at,turns,max_turns FROM orchestration_mandates WHERE work_item_id=?`, d.WorkItemID).Scan(&revision, &revoked, &expires, &turns, &max); e != nil {
			return e
		}
		if revision != d.Revision || revoked || expires <= c.St.NowTS() || d.Attempts == 0 && turns >= max {
			return nil
		}
		var epoch int
		if e := tx.QueryRow(`SELECT epoch FROM orchestration_assignments WHERE work_item_id=?`, d.WorkItemID).Scan(&epoch); e != nil {
			return e
		}
		if epoch != a.Epoch {
			return nil
		}
		var occupied, projectOccupied, sameWork int
		if e := tx.QueryRow(`SELECT count(*) FROM orchestration_deliveries WHERE work_item_id=? AND id<>? AND state IN ('sending','uncertain')`, d.WorkItemID, id).Scan(&sameWork); e != nil {
			return e
		}
		if sameWork > 0 {
			return nil
		}
		if e := tx.QueryRow(`SELECT count(*),COALESCE(SUM(CASE WHEN m.repo_id=? THEN 1 ELSE 0 END),0) FROM managed_sessions m WHERE m.id<>? AND ((m.runner='tmux' AND m.state IN ('starting','running')) OR (m.runner='codex_app' AND (m.native_status IN ('starting','running','needs_reconcile','uncertain') OR EXISTS(SELECT 1 FROM orchestration_assignments a JOIN orchestration_deliveries d ON d.work_item_id=a.work_item_id WHERE a.managed_id=m.id AND d.state IN ('sending','uncertain')))))`, repo, a.ManagedID).Scan(&occupied, &projectOccupied); e != nil {
			return e
		}
		if occupied >= 2 || projectOccupied >= 1 {
			return nil
		}

		res, e := tx.Exec(`UPDATE orchestration_deliveries SET state='sending',reason='',epoch=?,attempts=attempts+1,updated_at=? WHERE id=? AND state IN ('queued','held','waiting_boundary','retry_wait')`, a.Epoch, c.St.NowTS(), id)
		if e != nil {
			return e
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return nil
		}
		if d.Attempts == 0 {
			if _, e = tx.Exec(`UPDATE orchestration_mandates SET turns=turns+1 WHERE work_item_id=?`, d.WorkItemID); e != nil {
				return e
			}
		}
		admitted = true
		return orchAudit(tx, d.WorkItemID, "input_admitted", d.ID, c.St.NowTS())
	})
	if err != nil || !admitted {
		return err
	}
	authorize := func() bool {
		mode, e := c.OrchestrationMode(ctx)
		if e != nil || mode != "enabled" {
			return false
		}
		_, r, e := c.orchEligibility(ctx, d.WorkItemID, d.Revision)
		if e != nil || r != "" {
			return false
		}
		current, e := c.orchAssignment(ctx, d.WorkItemID)
		if e != nil || current != a {
			return false
		}
		return boundCandidate == "" || c.ManagedCandidate(ctx, a.ManagedID) == boundCandidate
	}
	receipt, sendErr := c.OrchExecutor.OrchestrationDeliver(ctx, a, d.ID, d.Input, authorize)
	// Errors are classified by the adapter; absence of an explicit safe result is uncertain.
	state, reason, due := "uncertain", "execution_unknown", c.St.NowTS()
	switch receipt.Outcome {
	case "acknowledged":
		if receipt.Turn != "" {
			state, reason = "acknowledged", "native_accepted"
		}
	case "held":
		state, reason = "held", "control_or_state_wait"
	case "unsent":
		if d.Attempts < 2 {
			state, reason = "retry_wait", "transport_unsent"
			due = store.TS(c.St.Now().Add(time.Duration(15*(1<<d.Attempts)) * time.Second))
		} else {
			state, reason = "held", "retry_exhausted"
		}
	}
	_ = sendErr // Raw tool/network errors may contain private data; only the category is persisted.
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		input := d.Input
		if state == "acknowledged" {
			input = ""
		}
		_, e := tx.Exec(`UPDATE orchestration_deliveries SET state=?,reason=?,due_at=?,receipt=?,input=?,updated_at=? WHERE id=? AND state='sending'`, state, reason, due, receipt.Turn, input, c.St.NowTS(), id)
		if e != nil {
			return e
		}
		if receipt.Outcome == "held" && d.Attempts == 0 {
			if _, e = tx.Exec(`UPDATE orchestration_mandates SET turns=MAX(0,turns-1) WHERE work_item_id=? AND revision=?`, d.WorkItemID, d.Revision); e != nil {
				return e
			}
			if _, e = tx.Exec(`UPDATE orchestration_deliveries SET attempts=0 WHERE id=?`, id); e != nil {
				return e
			}
		}
		return orchAudit(tx, d.WorkItemID, "input_result", state, c.St.NowTS())
	})
	c.notify()
	return err
}

func (c *Core) OrchestrationAlerts(ctx context.Context) ([]Alert, error) {
	v, err := c.OrchestrationView(ctx)
	if err != nil {
		return nil, err
	}
	if v.Mode == "disabled" {
		return nil, nil
	}
	out := []Alert{}
	for _, f := range v.Findings {
		if f.State != "open" {
			continue
		}
		out = append(out, Alert{Key: "orchestration:" + f.ID + ":" + f.OpenedAt, Title: "需要你：核对工作进展", Body: f.WorkItemID + " · " + f.Fact, Link: "/?view=dispatch"})
	}
	return out, nil
}

// Retention runs even while execution is disabled. Unknown outcomes remain unknown.
func (c *Core) purgeOrchestrationInputs(ctx context.Context) error {
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, e := tx.Exec(`UPDATE orchestration_deliveries SET input='',state=CASE WHEN state IN ('sending','uncertain') THEN state ELSE 'held' END,reason=CASE WHEN state IN ('sending','uncertain') THEN reason ELSE 'input_expired' END,updated_at=? WHERE input<>'' AND created_at<=?`, c.St.NowTS(), store.TS(c.St.Now().Add(-24*time.Hour)))
		return e
	})
}

// ManagedCandidate returns a commit only for a verified clean recorded worktree.
// Dirty or unreadable worktrees have no exact commit candidate for automatic failure routing.
func (c *Core) ManagedCandidate(ctx context.Context, id string) string {
	var dir string
	if e := c.St.R().QueryRowContext(ctx, `SELECT worktree FROM managed_sessions WHERE id=?`, id).Scan(&dir); e != nil {
		return ""
	}
	status, e := gitWrite(ctx, dir, "status", "--porcelain")
	if e != nil || status != "" {
		return ""
	}
	return gitx.RevParse(ctx, dir, "HEAD")
}
