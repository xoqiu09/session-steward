package nativecontrol

import (
	"context"
	"errors"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
)

func (d *Desk) backgroundCurrent(epoch int) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return !d.closed && d.owner == "" && d.epoch == epoch
}

// ReleaseBackground is explicit: closing a browser or expiry does not grant automation control.
func (d *Desk) ReleaseBackground(client string, epoch int, device string) error {
	if err := d.lease(client, epoch); err != nil {
		return err
	}
	d.mu.Lock()
	if d.owner != client || d.epoch != epoch {
		d.mu.Unlock()
		return ErrLease
	}
	d.owner = ""
	d.epoch++
	d.until = time.Time{}
	d.mu.Unlock()
	return d.Core.DispatchAudit(d.ctx, deskAuditID, "background_released", "ok", "panel", device)
}
func (d *Desk) OrchestrationState(ctx context.Context, id string) (core.OrchestrationExecution, error) {
	d.mu.Lock()
	owned := d.owner != ""
	t := d.tasks[id]
	d.mu.Unlock()
	if t == nil {
		if owned {
			return core.OrchestrationExecution{Held: "user_control"}, nil
		}
		return core.OrchestrationExecution{}, nil
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.row.Turn != "" && t.row.Status != "needs_reconcile" {
		return core.OrchestrationExecution{Busy: true}, nil
	}
	switch t.row.Status {
	case "needs_reconcile", "uncertain", "desktop":
		return core.OrchestrationExecution{Held: t.row.Status}, nil
	}
	if t.inflight != nil {
		return core.OrchestrationExecution{Busy: true}, nil
	}
	if owned {
		return core.OrchestrationExecution{Held: "user_control"}, nil
	}
	return core.OrchestrationExecution{}, nil
}
func (d *Desk) OrchestrationDeliver(ctx context.Context, a core.OrchestrationAssignment, op, input string, allowed func() bool) (core.OrchestrationReceipt, error) {
	d.mu.Lock()
	epoch := d.epoch
	held := d.owner != "" || d.closed
	d.mu.Unlock()
	if held || !allowed() {
		return core.OrchestrationReceipt{Outcome: "held"}, nil
	}
	if err := d.Core.ProvisionOrchestration(ctx, a); err != nil {
		return core.OrchestrationReceipt{Outcome: "uncertain"}, err
	}
	rows, err := d.Core.DispatchRows(ctx)
	if err != nil {
		return core.OrchestrationReceipt{Outcome: "unsent"}, err
	}
	d.mu.Lock()
	t := d.tasks[a.ManagedID]
	if t == nil {
		for _, r := range rows {
			if r.ID == a.ManagedID && r.WorkItemID == a.WorkItemID {
				t = newTask(d, r)
				d.tasks[r.ID] = t
				break
			}
		}
	}
	d.mu.Unlock()
	if t == nil {
		return core.OrchestrationReceipt{Outcome: "uncertain"}, core.ErrNotFound
	}
	t.mu.Lock()
	if turn, ok := t.row.Ops[op]; ok && turn != "" {
		t.mu.Unlock()
		return core.OrchestrationReceipt{Outcome: "acknowledged", Turn: turn}, nil
	}
	if !d.backgroundCurrent(epoch) || !allowed() {
		t.mu.Unlock()
		return core.OrchestrationReceipt{Outcome: "held"}, nil
	}
	if closed, e := t.workClosed(); e != nil || closed {
		t.mu.Unlock()
		return core.OrchestrationReceipt{Outcome: "held"}, e
	}
	if t.inflight != nil || t.row.Turn != "" || t.row.Status == "desktop" || t.row.Status == "needs_reconcile" || t.row.Status == "uncertain" || len(t.row.Ops) >= maxOps {
		t.mu.Unlock()
		return core.OrchestrationReceipt{Outcome: "held"}, ErrState
	}
	if err = d.Core.SetDispatchOp(ctx, t.row.ID, op, ""); err != nil {
		t.mu.Unlock()
		return core.OrchestrationReceipt{Outcome: "unsent"}, err
	}
	t.row.Ops[op] = ""
	_, err = t.begin(&nativeRequest{background: true, allowed: allowed, epoch: epoch, op: op, transport: t.transport}, "SS 投递编号："+op+"。如输入与本工作无关或缺少范围/依据，可用 ss_return_event 退回这条编号，不得扩大权限。\n\n"+input)
	t.mu.Lock()
	turn := t.row.Ops[op]
	status := t.row.Status
	t.mu.Unlock()
	if turn != "" {
		return core.OrchestrationReceipt{Outcome: "acknowledged", Turn: turn}, err
	}
	if status == "uncertain" || status == "needs_reconcile" {
		return core.OrchestrationReceipt{Outcome: "uncertain"}, err
	}
	if errors.Is(err, ErrLease) || errors.Is(err, ErrState) {
		return core.OrchestrationReceipt{Outcome: "held"}, err
	}
	return core.OrchestrationReceipt{Outcome: "unsent"}, err
}
