package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

type orchFake struct {
	c       *Core
	mu      sync.Mutex
	calls   int
	seen    map[string]string
	busy    map[string]bool
	outcome string
	before  func()
}

func (f *orchFake) OrchestrationState(_ context.Context, id string) (OrchestrationExecution, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return OrchestrationExecution{Busy: f.busy[id]}, nil
}
func (f *orchFake) OrchestrationDeliver(ctx context.Context, a OrchestrationAssignment, op, input string, allowed func() bool) (OrchestrationReceipt, error) {
	if f.before != nil {
		f.before()
	}
	if !allowed() {
		return OrchestrationReceipt{Outcome: "held"}, nil
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.outcome != "" && f.outcome != "acknowledged" {
		return OrchestrationReceipt{Outcome: f.outcome}, errors.New("SYNTHETIC private transport message")
	}
	if turn := f.seen[op]; turn != "" {
		return OrchestrationReceipt{Outcome: "acknowledged", Turn: turn}, nil
	}
	turn := "turn-" + op[:8]
	f.seen[op] = turn
	f.busy[a.ManagedID] = true
	err := f.c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, e := tx.Exec(`UPDATE managed_sessions SET native_thread=?,native_turn=?,native_status='running',state='running' WHERE id=?`, "thread-"+a.ManagedID, turn, a.ManagedID)
		return e
	})
	return OrchestrationReceipt{Outcome: "acknowledged", Turn: turn}, err
}
func (f *orchFake) count() int { f.mu.Lock(); defer f.mu.Unlock(); return f.calls }
func orchFixture(t *testing.T) (*Core, *orchFake, *time.Time, int64) {
	t.Helper()
	c, _, repo := managedCore(t)
	ctx := context.Background()
	if err := c.SetDispatchProject(ctx, repo, true); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	c.St.Now = func() time.Time { return now }
	c.OrchHostID = "h"
	f := &orchFake{c: c, seen: map[string]string{}, busy: map[string]bool{}}
	c.OrchExecutor = f
	if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "ORC-1", RepoID: repo, Title: "Synthetic bounded task", Acceptance: "Synthetic output meets requirements"}); err != nil {
		t.Fatal(err)
	}
	return c, f, &now, repo
}
func orchGrant(t *testing.T, c *Core, item, rev string) {
	t.Helper()
	if err := c.GrantOrchestration(context.Background(), OrchestrationGrant{WorkItemID: item, Revision: rev, Input: "Synthetic task input", StoreInput: true}); err != nil {
		t.Fatal(err)
	}
}
func orchView(t *testing.T, c *Core) OrchestrationView {
	t.Helper()
	v, e := c.OrchestrationView(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func orchTick(t *testing.T, c *Core) {
	t.Helper()
	if e := c.OrchestrationTick(context.Background()); e != nil {
		t.Fatal(e)
	}
}
func orchEnable(t *testing.T, c *Core) {
	t.Helper()
	if e := c.SetOrchestrationMode(context.Background(), "enabled"); e != nil {
		t.Fatal(e)
	}
}
func orchIdle(t *testing.T, c *Core, f *orchFake, item string) {
	t.Helper()
	a, e := c.orchAssignment(context.Background(), item)
	if e != nil {
		t.Fatal(e)
	}
	f.mu.Lock()
	f.busy[a.ManagedID] = false
	f.mu.Unlock()
	if e = c.St.Tx(context.Background(), func(tx *sql.Tx) error {
		_, e := tx.Exec(`UPDATE managed_sessions SET native_status='idle',native_turn='' WHERE id=?`, a.ManagedID)
		return e
	}); e != nil {
		t.Fatal(e)
	}
}

func TestOrchestrationDisabledObserveAndConcurrentGrant(t *testing.T) {
	c, f, _, _ := orchFixture(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := c.GrantOrchestration(ctx, OrchestrationGrant{WorkItemID: "ORC-1", Revision: "grant-repeat", Input: "Synthetic task input", StoreInput: true}); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	orchTick(t, c)
	if f.count() != 0 || len(orchView(t, c).Assignments) != 0 {
		t.Fatal("disabled executed")
	}
	if e := c.SetOrchestrationMode(ctx, "observe"); e != nil {
		t.Fatal(e)
	}
	orchTick(t, c)
	if f.count() != 0 {
		t.Fatal("observe executed")
	}
	orchEnable(t, c)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := c.OrchestrationTick(ctx); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	v := orchView(t, c)
	if len(v.Mandates) != 1 || len(v.Assignments) != 1 || len(v.Deliveries) != 1 || f.count() != 1 {
		t.Fatalf("duplicate execution: %+v calls %d", v, f.count())
	}
	if v.Deliveries[0].State != "acknowledged" {
		t.Fatal(v.Deliveries)
	}
	b, _ := json.Marshal(v)
	if strings.Contains(string(b), "Synthetic task input") {
		t.Fatal("input leaked in view")
	}
	var input string
	if e := c.St.R().QueryRow(`SELECT input FROM orchestration_deliveries`).Scan(&input); e != nil || input != "" {
		t.Fatal("accepted input retained", e)
	}
}
func TestOrchestrationFeedbackWaitsAndIsIdempotent(t *testing.T) {
	c, f, _, _ := orchFixture(t)
	ctx := context.Background()
	orchGrant(t, c, "ORC-1", "grant-boundary")
	orchEnable(t, c)
	orchTick(t, c)
	for i := 0; i < 100; i++ {
		if e := c.OrchestrationFeedback(ctx, "ORC-1", "grant-boundary", "feedback-repeat", "Synthetic follow-up", true); e != nil {
			t.Fatal(e)
		}
	}
	orchTick(t, c)
	if f.count() != 1 {
		t.Fatal("sent during running")
	}
	v := orchView(t, c)
	if len(v.Deliveries) != 2 {
		t.Fatal(v.Deliveries)
	}
	orchIdle(t, c, f, "ORC-1")
	orchTick(t, c)
	if f.count() != 2 {
		t.Fatal("follow-up not delivered")
	}
	if e := c.OrchestrationFeedback(ctx, "ORC-1", "grant-boundary", "feedback-repeat", "changed content", true); !errors.Is(e, ErrConflict) {
		t.Fatal("same key changed content", e)
	}
	var n int
	c.St.R().QueryRow(`SELECT count(*) FROM work_items WHERE id='ORC-1'`).Scan(&n)
	if n != 1 || len(orchView(t, c).Assignments) != 1 {
		t.Fatal("did not reuse work")
	}
}
func TestOrchestrationRevocationAndTargetChanged(t *testing.T) {
	for _, change := range []string{"revoke", "target", "disabled", "review", "project", "expire"} {
		t.Run(change, func(t *testing.T) {
			c, f, now, repo := orchFixture(t)
			ctx := context.Background()
			orchGrant(t, c, "ORC-1", "grant-revocation")
			orchEnable(t, c)
			switch change {
			case "revoke":
				if e := c.RevokeOrchestration(ctx, "ORC-1", "grant-revocation"); e != nil {
					t.Fatal(e)
				}
			case "target":
				c.St.Tx(ctx, func(tx *sql.Tx) error {
					_, e := tx.Exec(`UPDATE work_items SET acceptance='changed' WHERE id='ORC-1'`)
					return e
				})
			case "disabled":
				c.SetOrchestrationMode(ctx, "disabled")
			case "review":
				c.St.Tx(ctx, func(tx *sql.Tx) error {
					_, e := tx.Exec(`UPDATE work_items SET status='review' WHERE id='ORC-1'`)
					return e
				})
			case "project":
				c.SetDispatchProject(ctx, repo, false)
			case "expire":
				*now = now.Add(5 * time.Hour)
			}
			orchTick(t, c)
			if f.count() != 0 {
				t.Fatal("executed after authority changed")
			}
		})
	}
}
func TestOrchestrationRechecksAfterAdmission(t *testing.T) {
	c, f, _, _ := orchFixture(t)
	orchGrant(t, c, "ORC-1", "grant-race")
	orchEnable(t, c)
	f.before = func() {
		if e := c.RevokeOrchestration(context.Background(), "ORC-1", "grant-race"); e != nil {
			t.Error(e)
		}
	}
	orchTick(t, c)
	if f.count() != 0 {
		t.Fatal("revoked request executed")
	}
}
func TestOrchestrationUnknownRecoveryNeverReplays(t *testing.T) {
	c, f, _, _ := orchFixture(t)
	orchGrant(t, c, "ORC-1", "grant-unknown")
	orchEnable(t, c)
	f.outcome = "uncertain"
	orchTick(t, c)
	if e := c.RecoverOrchestration(context.Background()); e != nil {
		t.Fatal(e)
	}
	orchTick(t, c)
	if f.count() != 1 || orchView(t, c).Deliveries[0].State != "uncertain" {
		t.Fatal("unknown request replayed")
	}
	c.St.Tx(context.Background(), func(tx *sql.Tx) error {
		_, e := tx.Exec(`UPDATE orchestration_deliveries SET state='sending'`)
		return e
	})
	if e := c.RecoverOrchestration(context.Background()); e != nil {
		t.Fatal(e)
	}
	orchTick(t, c)
	if f.count() != 1 {
		t.Fatal("restart replayed admitted operation")
	}
}
func TestOrchestrationSafeRetryBudget(t *testing.T) {
	c, f, now, _ := orchFixture(t)
	orchGrant(t, c, "ORC-1", "grant-retry")
	orchEnable(t, c)
	f.outcome = "unsent"
	for i := 0; i < 5; i++ {
		orchTick(t, c)
		*now = now.Add(time.Minute)
	}
	v := orchView(t, c)
	if f.count() != 3 || v.Mandates[0].Turns != 1 || v.Deliveries[0].Reason != "retry_exhausted" {
		t.Fatalf("unbounded retry: calls %d, %+v", f.count(), v)
	}
}
func TestOrchestrationQueueBoundAndInputConsent(t *testing.T) {
	c, _, _, _ := orchFixture(t)
	ctx := context.Background()
	if e := c.GrantOrchestration(ctx, OrchestrationGrant{WorkItemID: "ORC-1", Revision: "no-consent", Input: "secret task"}); e == nil {
		t.Fatal("stored without consent")
	}
	orchGrant(t, c, "ORC-1", "grant-queue")
	for i := 0; i < 99; i++ {
		if e := c.OrchestrationFeedback(ctx, "ORC-1", "grant-queue", fmt.Sprintf("feedback-%03d", i), "Synthetic follow-up", true); e != nil {
			t.Fatal(e)
		}
	}
	if e := c.OrchestrationFeedback(ctx, "ORC-1", "grant-queue", "overflow-event", "Synthetic follow-up", true); !errors.Is(e, ErrConflict) {
		t.Fatal("queue overflow not refused", e)
	}
	if len(orchView(t, c).Deliveries) != 100 {
		t.Fatal("queue lost an entry")
	}
}
func TestOrchestrationTurnBudgetAndDependencies(t *testing.T) {
	c, f, _, repo := orchFixture(t)
	ctx := context.Background()
	if e := c.CreateWorkItem(ctx, WorkItemInput{ID: "UP-1", RepoID: repo, Title: "upstream", Acceptance: "required"}); e != nil {
		t.Fatal(e)
	}
	if e := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, e := tx.Exec(`INSERT INTO work_deps(upstream,downstream,cond) VALUES('UP-1','ORC-1','accepted')`)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	if e := c.GrantOrchestration(ctx, OrchestrationGrant{WorkItemID: "ORC-1", Revision: "grant-dependency", Input: "Synthetic task input", StoreInput: true, MaxTurns: 1}); e != nil {
		t.Fatal(e)
	}
	orchEnable(t, c)
	orchTick(t, c)
	if f.count() != 0 {
		t.Fatal("ran before dependency")
	}
	c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, e := tx.Exec(`UPDATE work_items SET status='done' WHERE id='UP-1'`)
		return e
	})
	orchTick(t, c)
	if f.count() != 1 {
		t.Fatal("did not run when dependency satisfied")
	}
	orchIdle(t, c, f, "ORC-1")
	if e := c.OrchestrationFeedback(ctx, "ORC-1", "grant-dependency", "over-budget", "Synthetic follow-up", true); e != nil {
		t.Fatal(e)
	}
	orchTick(t, c)
	if f.count() != 1 {
		t.Fatal("exceeded turn budget")
	}
}
func TestOrchestrationProvisionReusesStableWorktree(t *testing.T) {
	c, _, _, _ := orchFixture(t)
	ctx := context.Background()
	orchGrant(t, c, "ORC-1", "grant-provision")
	a, e := c.reserveOrchestration(ctx, "ORC-1")
	if e != nil {
		t.Fatal(e)
	}
	if e = c.ProvisionOrchestration(ctx, a); e != nil {
		t.Fatal(e)
	}
	if e = c.ProvisionOrchestration(ctx, a); e != nil {
		t.Fatal(e)
	}
	other, e := c.reserveOrchestration(ctx, "ORC-1")
	if e != nil || other != a {
		t.Fatal("recovery duplicated reservation")
	}
	if e = c.RevokeOrchestration(ctx, "ORC-1", "grant-provision"); e != nil {
		t.Fatal(e)
	}
	if e = c.ProvisionOrchestration(ctx, a); e == nil {
		t.Fatal("old epoch provisioned")
	}
}
func TestOrchestrationWatchdogDoesNotRunOrReNotify(t *testing.T) {
	c, f, now, _ := orchFixture(t)
	orchGrant(t, c, "ORC-1", "grant-watchdog")
	c.SetOrchestrationMode(context.Background(), "observe")
	*now = now.Add(3 * time.Minute)
	if e := c.checkOrchestration(context.Background()); e != nil {
		t.Fatal(e)
	}
	v := orchView(t, c)
	if len(v.Findings) != 1 || f.count() != 0 {
		t.Fatal("watchdog executed or missing finding", v)
	}
	first := v.Findings[0]
	if e := c.AcknowledgeOrchestrationFinding(context.Background(), first.ID); e != nil {
		t.Fatal(e)
	}
	*now = now.Add(time.Minute)
	if e := c.checkOrchestration(context.Background()); e != nil {
		t.Fatal(e)
	}
	v = orchView(t, c)
	if v.Findings[0].State != "acknowledged" || v.Findings[0].OpenedAt != first.OpenedAt {
		t.Fatal("ack changed episode")
	}
	alerts, e := c.OrchestrationAlerts(context.Background())
	if e != nil || len(alerts) != 0 {
		t.Fatal("acknowledged finding notified")
	}
}
func TestOrchestrationNativeFailureSubscriptionUsesIdentity(t *testing.T) {
	c, f, now, _ := orchFixture(t)
	ctx := context.Background()
	if e := c.GrantOrchestration(ctx, OrchestrationGrant{WorkItemID: "ORC-1", Revision: "grant-failures", Input: "Synthetic task input", StoreInput: true, FailureFollowup: true}); e != nil {
		t.Fatal(e)
	}
	orchEnable(t, c)
	orchTick(t, c)
	a, e := c.orchAssignment(ctx, "ORC-1")
	if e != nil {
		t.Fatal(e)
	}
	if e = c.ProvisionOrchestration(ctx, a); e != nil {
		t.Fatal(e)
	}
	var dir string
	c.St.R().QueryRow(`SELECT worktree FROM managed_sessions WHERE id=?`, a.ManagedID).Scan(&dir)
	for _, host := range []string{"other-device", "h"} {
		kinds := []event.Kind{event.KindPrompt, event.KindToolFail}
		if host == "other-device" {
			kinds = append(kinds, event.KindStop)
		}
		for _, kind := range kinds {
			*now = now.Add(time.Second)
			ev := ev("thread-"+a.ManagedID, kind, *now)
			ev.Source.Provider = "codex"
			ev.Source.HostID = host
			ev.WorkTag = "ORC-1"
			ev.Cwd = dir
			ev.ToolName = "commandExecution"
			ev.Candidate = c.ManagedCandidate(ctx, a.ManagedID)
			ev.Reason = "nonzero_exit"
			if _, e = c.Ingest(ctx, ev); e != nil {
				t.Fatal(e)
			}
		}
	}
	orchTick(t, c)
	v := orchView(t, c)
	if len(v.Deliveries) != 2 {
		t.Fatalf("cross-host or missing routing: %d", len(v.Deliveries))
	}
	if f.count() != 1 {
		t.Fatal("sent failures during busy turn")
	}
}

func TestOrchestrationInputExpiryEvenWhenDisabled(t *testing.T) {
	c, f, now, _ := orchFixture(t)
	orchGrant(t, c, "ORC-1", "grant-retention")
	*now = now.Add(25 * time.Hour)
	orchTick(t, c)
	var input, state, reason string
	if e := c.St.R().QueryRow(`SELECT input,state,reason FROM orchestration_deliveries`).Scan(&input, &state, &reason); e != nil {
		t.Fatal(e)
	}
	if input != "" || state != "held" || reason != "input_expired" || f.count() != 0 {
		t.Fatal("disabled mode retained expired input", state, reason)
	}
}
func TestOrchestrationGrantKeyCannotChangeBudget(t *testing.T) {
	c, _, _, _ := orchFixture(t)
	orchGrant(t, c, "ORC-1", "grant-immutable")
	if e := c.GrantOrchestration(context.Background(), OrchestrationGrant{WorkItemID: "ORC-1", Revision: "grant-immutable", Input: "Synthetic task input", StoreInput: true, MaxTurns: 99}); !errors.Is(e, ErrConflict) {
		t.Fatal("reused key changed semantics", e)
	}
}

func TestOrchestrationUnknownBlocksNewGrantUntilExplicitResolution(t *testing.T) {
	c, f, _, _ := orchFixture(t)
	ctx := context.Background()
	orchGrant(t, c, "ORC-1", "grant-old-unknown")
	orchEnable(t, c)
	f.outcome = "uncertain"
	orchTick(t, c)
	v := orchView(t, c)
	d := v.Deliveries[0]
	orchGrant(t, c, "ORC-1", "grant-new-unknown")
	f.outcome = "acknowledged"
	orchTick(t, c)
	if f.count() != 1 {
		t.Fatal("new grant bypassed unknown operation")
	}
	if e := c.ReconcileOrchestrationDelivery(ctx, d.ID, d.Revision, "verify_receipt"); !errors.Is(e, ErrConflict) {
		t.Fatal("invented receipt", e)
	}
	if e := c.ReconcileOrchestrationDelivery(ctx, d.ID, d.Revision, "close_unknown"); e != nil {
		t.Fatal(e)
	}
	orchTick(t, c)
	if f.count() != 2 {
		t.Fatal("explicitly closed unknown did not release fake runner")
	}
}

func TestOrchestrationGlobalAndProjectSlots(t *testing.T) {
	c, f, _, repo := orchFixture(t)
	ctx := context.Background()
	for i := 2; i <= 4; i++ {
		rid := repo
		if i > 2 {
			dir := gitInit(t)
			e := ev(fmt.Sprintf("extra-repo-%d", i), event.KindSessionStart, c.St.Now())
			e.Cwd = dir
			if _, err := c.Ingest(ctx, e); err != nil {
				t.Fatal(err)
			}
			if err := c.St.R().QueryRow(`SELECT id FROM repos WHERE common_dir=?`, dir+"/.git").Scan(&rid); err != nil {
				t.Fatal(err)
			}
			if err := c.SetDispatchProject(ctx, rid, true); err != nil {
				t.Fatal(err)
			}
		}
		item := fmt.Sprintf("ORC-%d", i)
		if e := c.CreateWorkItem(ctx, WorkItemInput{ID: item, RepoID: rid, Title: "Synthetic queued work", Acceptance: "Synthetic requirement"}); e != nil {
			t.Fatal(e)
		}
		orchGrant(t, c, item, fmt.Sprintf("grant-slot-%d", i))
	}
	orchGrant(t, c, "ORC-1", "grant-slot-1")
	orchEnable(t, c)
	orchTick(t, c)
	if f.count() != 2 {
		t.Fatalf("global/project slots not enforced: %d", f.count())
	}
	v := orchView(t, c)
	repos := map[int64]bool{}
	for _, a := range v.Assignments {
		state, e := f.OrchestrationState(ctx, a.ManagedID)
		if e != nil {
			t.Fatal(e)
		}
		if !state.Busy {
			continue
		}
		var rid int64
		c.St.R().QueryRow(`SELECT repo_id FROM managed_sessions WHERE id=?`, a.ManagedID).Scan(&rid)
		if repos[rid] {
			t.Fatal("same project has two workers")
		}
		repos[rid] = true
	}
	if len(repos) != 2 {
		t.Fatal("expected two distinct project workers")
	}
	// Completing an active worker admits the oldest remaining eligible project without a manual nudge.
	for _, a := range v.Assignments {
		state, _ := f.OrchestrationState(ctx, a.ManagedID)
		if state.Busy {
			orchIdle(t, c, f, a.WorkItemID)
			break
		}
	}
	orchTick(t, c)
	if f.count() != 3 {
		t.Fatal("queued task did not advance after release")
	}
}

func TestOrchestrationFailureQueuedForOldCandidateDoesNotRestartNewCandidate(t *testing.T) {
	c, f, now, _ := orchFixture(t)
	ctx := context.Background()
	if e := c.GrantOrchestration(ctx, OrchestrationGrant{WorkItemID: "ORC-1", Revision: "grant-candidate", Input: "Synthetic task", StoreInput: true, FailureFollowup: true}); e != nil {
		t.Fatal(e)
	}
	orchEnable(t, c)
	orchTick(t, c)
	a, e := c.orchAssignment(ctx, "ORC-1")
	if e != nil {
		t.Fatal(e)
	}
	if e = c.ProvisionOrchestration(ctx, a); e != nil {
		t.Fatal(e)
	}
	var dir string
	c.St.R().QueryRow(`SELECT worktree FROM managed_sessions WHERE id=?`, a.ManagedID).Scan(&dir)
	*now = now.Add(time.Second)
	prompt := ev("thread-"+a.ManagedID, event.KindPrompt, *now)
	prompt.Source.Provider = "codex"
	prompt.WorkTag = "ORC-1"
	prompt.Cwd = dir
	if _, e = c.Ingest(ctx, prompt); e != nil {
		t.Fatal(e)
	}
	*now = now.Add(time.Second)
	failure := ev(prompt.SessionID, event.KindToolFail, *now)
	failure.Source.Provider = "codex"
	failure.WorkTag = "ORC-1"
	failure.Cwd = dir
	failure.Candidate = c.ManagedCandidate(ctx, a.ManagedID)
	failure.Reason = "nonzero_exit"
	if _, e = c.Ingest(ctx, failure); e != nil {
		t.Fatal(e)
	}
	orchTick(t, c)
	if len(orchView(t, c).Deliveries) != 2 {
		t.Fatal("failure not queued")
	}
	if _, e = gitWrite(ctx, dir, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--allow-empty", "-m", "new synthetic candidate"); e != nil {
		t.Fatal(e)
	}
	orchIdle(t, c, f, "ORC-1")
	orchTick(t, c)
	if f.count() != 1 {
		t.Fatal("old candidate failure restarted newer candidate")
	}
	found := false
	for _, d := range orchView(t, c).Deliveries {
		if d.Kind == "execution_failure" {
			found = d.State == "cancelled" && d.Reason == "candidate_changed"
		}
	}
	if !found {
		t.Fatal("old candidate input not closed")
	}
}

func TestOrchestrationWatchdogCandidateAndLongToolSuppression(t *testing.T) {
	c, f, now, _ := orchFixture(t)
	ctx := context.Background()
	orchGrant(t, c, "ORC-1", "grant-watch-evidence")
	orchEnable(t, c)
	orchTick(t, c)
	a, e := c.orchAssignment(ctx, "ORC-1")
	if e != nil {
		t.Fatal(e)
	}
	if e = c.ProvisionOrchestration(ctx, a); e != nil {
		t.Fatal(e)
	}
	var dir string
	c.St.R().QueryRow(`SELECT worktree FROM managed_sessions WHERE id=?`, a.ManagedID).Scan(&dir)
	emit := func(kind event.Kind, tool string) {
		*now = now.Add(time.Second)
		v := ev("thread-"+a.ManagedID, kind, *now)
		v.Source.Provider = "codex"
		v.Cwd = dir
		v.WorkTag = "ORC-1"
		v.ToolName = "commandExecution"
		v.ToolUseID = tool
		v.Candidate = c.ManagedCandidate(ctx, a.ManagedID)
		if kind == event.KindToolFail {
			v.Reason = "nonzero_exit"
		}
		if _, e := c.Ingest(ctx, v); e != nil {
			t.Fatal(e)
		}
	}
	emit(event.KindPrompt, "")
	for i := 0; i < 3; i++ {
		emit(event.KindToolFail, fmt.Sprint(i))
	}
	if e = c.checkOrchestration(ctx); e != nil {
		t.Fatal(e)
	}
	v := orchView(t, c)
	found := false
	for _, finding := range v.Findings {
		found = found || finding.Rule == "repeated_failure" && finding.State == "open"
	}
	if !found {
		t.Fatal("missing same-candidate failure evidence", v.Findings)
	}
	emit(event.KindToolPre, "long-operation")
	*now = now.Add(16 * time.Minute)
	if e = c.checkOrchestration(ctx); e != nil {
		t.Fatal(e)
	}
	for _, finding := range orchView(t, c).Findings {
		if finding.Rule == "progress_evidence_gap" && finding.State == "open" {
			t.Fatal("long operation mistaken for stall")
		}
	}
	emit(event.KindToolPost, "long-operation")
	*now = now.Add(16 * time.Minute)
	if e = c.checkOrchestration(ctx); e != nil {
		t.Fatal(e)
	}
	found = false
	for _, finding := range orchView(t, c).Findings {
		found = found || finding.Rule == "progress_evidence_gap" && finding.State == "open"
	}
	if !found {
		t.Fatal("missing evidence gap")
	}
	if _, e = gitWrite(ctx, dir, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--allow-empty", "-m", "next candidate"); e != nil {
		t.Fatal(e)
	}
	if e = c.checkOrchestration(ctx); e != nil {
		t.Fatal(e)
	}
	for _, finding := range orchView(t, c).Findings {
		if finding.Rule == "repeated_failure" && finding.State == "open" {
			t.Fatal("old failure inherited by new candidate")
		}
	}
	if f.count() != 1 {
		t.Fatal("watchdog performed execution")
	}
}
func TestOrchestrationQueueCursorAvoidsHeldHistoryStarvation(t *testing.T) {
	c, f, _, _ := orchFixture(t)
	ctx := context.Background()
	orchGrant(t, c, "ORC-1", "grant-fairness")
	if e := c.St.Tx(ctx, func(tx *sql.Tx) error {
		// More than one scan batch of expired metadata; none may execute or retain input.
		for i := 0; i < 201; i++ {
			source := fmt.Sprintf("synthetic-expired-%d", i)
			if _, e := tx.Exec(`INSERT INTO orchestration_deliveries(id,work_item_id,revision,source_id,kind,input_hash,state,reason,due_at,created_at,updated_at) VALUES(?,'ORC-1','old-expired',?,'user_feedback','hash','held','input_expired',?,?,?)`, source, source, c.St.NowTS(), c.St.NowTS(), c.St.NowTS()); e != nil {
				return e
			}
		}
		// Move the live initial delivery to the queue tail to test a full rotation.
		_, e := tx.Exec(`UPDATE orchestration_deliveries SET rowid=1000 WHERE kind='initial'`)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	orchEnable(t, c)
	orchTick(t, c)
	orchTick(t, c)
	if f.count() != 1 {
		t.Fatal("expired history starved live work")
	}
}
func TestOrchestrationProjectBindingCannotBeMovedByReplay(t *testing.T) {
	c, f, _, _ := orchFixture(t)
	ctx := context.Background()
	orchGrant(t, c, "ORC-1", "grant-project-bind")
	orchEnable(t, c)
	if e := c.St.Tx(ctx, func(tx *sql.Tx) error { _, e := tx.Exec(`UPDATE repos SET target_ref='a-different-target'`); return e }); e != nil {
		t.Fatal(e)
	}
	orchTick(t, c)
	if f.count() != 0 {
		t.Fatal("changed target executed under old authority")
	}
	if e := c.GrantOrchestration(ctx, OrchestrationGrant{WorkItemID: "ORC-1", Revision: "grant-project-bind", Input: "Synthetic task input", StoreInput: true}); !errors.Is(e, ErrConflict) {
		t.Fatal("old request replay silently accepted changed project binding", e)
	}
}

func TestOrchestrationDoesNotDiscardUnmanagedHistoryOrBranch(t *testing.T) {
	for _, history := range []bool{false, true} {
		t.Run(fmt.Sprint(history), func(t *testing.T) {
			c, f, now, _ := orchFixture(t)
			ctx := context.Background()
			if history {
				v := ev("existing-human-session", event.KindPrompt, *now)
				v.WorkTag = "ORC-1"
				var dir string
				c.St.R().QueryRow(`SELECT common_dir FROM repos LIMIT 1`).Scan(&dir)
				v.Cwd = strings.TrimSuffix(dir, "/.git")
				if _, e := c.Ingest(ctx, v); e != nil {
					t.Fatal(e)
				}
				v = ev("existing-human-session", event.KindStop, now.Add(time.Second))
				v.WorkTag = "ORC-1"
				v.Cwd = strings.TrimSuffix(dir, "/.git")
				if _, e := c.Ingest(ctx, v); e != nil {
					t.Fatal(e)
				}
			} else {
				c.St.Tx(ctx, func(tx *sql.Tx) error {
					_, e := tx.Exec(`UPDATE work_items SET branch='feature/existing-work' WHERE id='ORC-1'`)
					return e
				})
			}
			orchGrant(t, c, "ORC-1", "grant-handoff-guard")
			orchEnable(t, c)
			orchTick(t, c)
			if f.count() != 0 {
				t.Fatal("existing work silently restarted from main")
			}
			v := orchView(t, c)
			if len(v.Deliveries) != 1 || v.Deliveries[0].Reason != "handoff_required" {
				t.Fatal("missing handoff requirement", v.Deliveries)
			}
		})
	}
}
