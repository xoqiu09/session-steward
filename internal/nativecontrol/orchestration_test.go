package nativecontrol

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
)

func nativeOrchWork(t *testing.T, g *rig) {
	t.Helper()
	ctx := context.Background()
	g.c.OrchExecutor = g.d
	if err := g.c.CreateWorkItem(ctx, core.WorkItemInput{ID: "ORC-1", RepoID: g.repos[0], Title: "Synthetic orchestration", Acceptance: "Synthetic acceptance"}); err != nil {
		t.Fatal(err)
	}
	if err := g.c.GrantOrchestration(ctx, core.OrchestrationGrant{WorkItemID: "ORC-1", Revision: "native-grant", Input: "Synthetic original input", StoreInput: true}); err != nil {
		t.Fatal(err)
	}
	if err := g.c.SetOrchestrationMode(ctx, "enabled"); err != nil {
		t.Fatal(err)
	}
}
func nativeOrchTick(t *testing.T, g *rig) {
	t.Helper()
	if err := g.c.OrchestrationTick(context.Background()); err != nil {
		t.Fatal(err)
	}
}
func TestBackgroundOrchestrationUsesOriginalWorkAndExplicitHandover(t *testing.T) {
	g := newRig(t)
	nativeOrchWork(t, g)
	nativeOrchTick(t, g)
	v, err := g.c.OrchestrationView(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Assignments) != 1 || len(v.Deliveries) != 1 || v.Deliveries[0].State != "acknowledged" {
		t.Fatalf("not delivered %+v", v)
	}
	id := v.Assignments[0].ManagedID
	first, _ := g.d.Task(id)
	f := g.conn(0)
	if first.WorkItemID != "ORC-1" || f.count("thread/start") != 1 || f.count("turn/start") != 1 {
		t.Fatal("wrong work or duplicate thread")
	}
	if err = g.c.OrchestrationFeedback(context.Background(), "ORC-1", "native-grant", "native-followup", "Synthetic next input", true); err != nil {
		t.Fatal(err)
	}
	nativeOrchTick(t, g)
	if f.count("turn/start") != 1 {
		t.Fatal("sent during running turn")
	}
	epoch := g.acquire("human-controller")
	complete(f, first.Turn, "completed")
	eventually(t, func() bool { v, _ := g.d.Task(id); return v.Turn == "" })
	nativeOrchTick(t, g)
	if f.count("turn/start") != 1 {
		t.Fatal("background ignored human control")
	}
	if err = g.d.ReleaseBackground("human-controller", epoch, LocalDevice); err != nil {
		t.Fatal(err)
	}
	nativeOrchTick(t, g)
	if f.count("thread/start") != 1 || f.count("turn/start") != 2 {
		t.Fatal("did not reuse original thread after release")
	}
	var count int
	g.st.R().QueryRow(`SELECT count(*) FROM managed_sessions`).Scan(&count)
	if count != 1 {
		t.Fatal("duplicate managed record")
	}
	g.st.R().QueryRow(`SELECT count(*) FROM work_items WHERE id='ORC-1'`).Scan(&count)
	if count != 1 {
		t.Fatal("duplicate work item")
	}
}
func TestBackgroundOrchestrationRestartDoesNotReplay(t *testing.T) {
	g := newRig(t)
	nativeOrchWork(t, g)
	nativeOrchTick(t, g)
	if g.connCount() != 1 {
		t.Fatal("not started")
	}
	g.d.Close()
	g.open()
	g.c.OrchExecutor = g.d
	if err := g.c.RecoverOrchestration(context.Background()); err != nil {
		t.Fatal(err)
	}
	nativeOrchTick(t, g)
	if g.connCount() != 1 {
		t.Fatal("restart replayed old task")
	}
	v, err := g.c.OrchestrationView(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	task, err := g.d.Task(v.Assignments[0].ManagedID)
	if err != nil || task.Status != "needs_reconcile" {
		t.Fatal("lost uncertain execution", task, err)
	}
}
func TestBackgroundOrchestrationTurnStartErrorIsUncertain(t *testing.T) {
	g := newRig(t)
	g.failOn = "turn/start"
	nativeOrchWork(t, g)
	nativeOrchTick(t, g)
	nativeOrchTick(t, g)
	v, err := g.c.OrchestrationView(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if v.Deliveries[0].State != "uncertain" || g.conn(0).count("turn/start") != 1 {
		t.Fatal("retried ambiguous turn/start", v.Deliveries)
	}
}

func TestBackgroundGrantAdoptsUniqueExistingManagedTask(t *testing.T) {
	g := newRig(t)
	epoch := g.acquire("human-controller")
	task := g.create("human-controller", epoch, "existing-operation", g.repos[0])
	f := g.conn(0)
	complete(f, task.Turn, "completed")
	eventually(t, func() bool { v, _ := g.d.Task(task.ID); return v.Turn == "" })
	if e := g.st.Tx(context.Background(), func(tx *sql.Tx) error {
		_, e := tx.Exec(`UPDATE work_items SET acceptance='Synthetic requirement' WHERE id=?`, task.WorkItemID)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	g.c.OrchExecutor = g.d
	if e := g.c.GrantOrchestration(context.Background(), core.OrchestrationGrant{WorkItemID: task.WorkItemID, Revision: "adopt-existing", Input: "Synthetic next task", StoreInput: true}); e != nil {
		t.Fatal(e)
	}
	if e := g.c.SetOrchestrationMode(context.Background(), "enabled"); e != nil {
		t.Fatal(e)
	}
	if e := g.d.ReleaseBackground("human-controller", epoch, LocalDevice); e != nil {
		t.Fatal(e)
	}
	nativeOrchTick(t, g)
	v, e := g.c.OrchestrationView(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	if len(v.Assignments) != 1 || v.Assignments[0].ManagedID != task.ID || f.count("thread/start") != 1 || f.count("turn/start") != 2 {
		t.Fatalf("did not adopt original managed execution %+v", v.Assignments)
	}
}

func TestBackgroundWorkerCanReturnOnlyItsOwnDelivery(t *testing.T) {
	g := newRig(t)
	nativeOrchWork(t, g)
	nativeOrchTick(t, g)
	v, e := g.c.OrchestrationView(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	d := v.Deliveries[0]
	task, _ := g.d.Task(v.Assignments[0].ManagedID)
	if e = g.c.ReturnOrchestrationEvent(context.Background(), "wrong-managed", "ORC-1", d.ID, task.Turn, "unrelated"); e == nil {
		t.Fatal("wrong owner returned delivery")
	}
	if e = g.c.ReturnOrchestrationEvent(context.Background(), task.ID, "ORC-1", d.ID, "wrong-turn", "unrelated"); e == nil {
		t.Fatal("wrong turn returned delivery")
	}
	f := g.conn(0)
	f.emit("item/tool/call", map[string]any{"threadId": task.Thread, "turnId": task.Turn, "tool": "ss_return_event", "arguments": map[string]string{"delivery_id": d.ID, "reason": "unrelated"}}, "17")
	eventually(t, func() bool { return strings.Contains(f.reply("17"), `"success":true`) })
	complete(f, task.Turn, "completed")
	eventually(t, func() bool { v, _ := g.d.Task(task.ID); return v.Turn == "" })
	nativeOrchTick(t, g)
	nativeOrchTick(t, g)
	if f.count("turn/start") != 1 {
		t.Fatal("returned event routed back in a loop")
	}
	v, e = g.c.OrchestrationView(context.Background())
	if e != nil || v.Deliveries[0].Reason != "route_unrelated" {
		t.Fatal("missing handback reason", v.Deliveries, e)
	}
}

// I01: real Core/SQLite/native adapter with three synthetic projects and fake RPC only.
func TestOrchestrationThreeProjectsFeedbackDependencyFailureAndRestart(t *testing.T) {
	g := newRig(t)
	ctx := context.Background()
	g.c.OrchExecutor = g.d
	var clock atomic.Int64
	clock.Store(time.Now().UTC().UnixNano())
	g.st.Now = func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	if e := g.c.SetDispatchProject(ctx, g.repos[2], true); e != nil {
		t.Fatal(e)
	}
	for i, rid := range g.repos {
		item := fmt.Sprintf("ORC-%d", i+1)
		if e := g.c.CreateWorkItem(ctx, core.WorkItemInput{ID: item, RepoID: rid, Title: "Synthetic multi-project work", Acceptance: "Synthetic requirement"}); e != nil {
			t.Fatal(e)
		}
		if i == 1 {
			if e := g.st.Tx(ctx, func(tx *sql.Tx) error {
				_, e := tx.Exec(`INSERT INTO work_deps(upstream,downstream,cond) VALUES('ORC-1','ORC-2','accepted')`)
				return e
			}); e != nil {
				t.Fatal(e)
			}
		}
		if e := g.c.GrantOrchestration(ctx, core.OrchestrationGrant{WorkItemID: item, Revision: fmt.Sprintf("three-grant-%d", i), Input: "Synthetic bounded task", StoreInput: true, FailureFollowup: i == 2}); e != nil {
			t.Fatal(e)
		}
	}
	if e := g.c.SetOrchestrationMode(ctx, "enabled"); e != nil {
		t.Fatal(e)
	}
	nativeOrchTick(t, g)
	if g.connCount() != 2 {
		t.Fatalf("need two workers, dependency must wait: %d", g.connCount())
	}
	v, e := g.c.OrchestrationView(ctx)
	if e != nil {
		t.Fatal(e)
	}
	managed := map[string]string{}
	for _, a := range v.Assignments {
		managed[a.WorkItemID] = a.ManagedID
	}
	one, _ := g.d.Task(managed["ORC-1"])
	three, _ := g.d.Task(managed["ORC-3"])
	if e = g.c.OrchestrationFeedback(ctx, "ORC-1", "three-grant-0", "three-feedback", "Synthetic second instruction", true); e != nil {
		t.Fatal(e)
	}
	nativeOrchTick(t, g)
	if g.conn(0).count("turn/start") != 1 {
		t.Fatal("feedback ignored boundary")
	}
	epoch := g.acquire("three-human-controller")
	for i := 0; i < 3; i++ {
		g.conn(1).emit("item/completed", map[string]any{"threadId": three.Thread, "turnId": three.Turn, "item": map[string]any{"id": fmt.Sprintf("failure-%d", i), "type": "commandExecution", "exitCode": 1}}, "")
	}
	eventually(t, func() bool {
		var n int
		g.st.R().QueryRow(`SELECT count(*) FROM events WHERE kind='tool_fail'`).Scan(&n)
		return n == 3
	})
	complete(g.conn(0), one.Turn, "completed")
	eventually(t, func() bool { v, _ := g.d.Task(one.ID); return v.Turn == "" })
	clock.Add(int64(time.Minute))
	nativeOrchTick(t, g)
	if g.conn(0).count("turn/start") != 1 {
		t.Fatal("background ignored human control")
	}
	v, e = g.c.OrchestrationView(ctx)
	if e != nil {
		t.Fatal(e)
	}
	failureFound := false
	for _, f := range v.Findings {
		failureFound = failureFound || f.WorkItemID == "ORC-3" && f.Rule == "repeated_failure"
	}
	if !failureFound {
		t.Fatal("watchdog missing failure evidence", v.Findings)
	}
	if e = g.d.ReleaseBackground("three-human-controller", epoch, LocalDevice); e != nil {
		t.Fatal(e)
	}
	nativeOrchTick(t, g)
	if g.conn(0).count("thread/start") != 1 || g.conn(0).count("turn/start") != 2 {
		t.Fatal("feedback did not return to same worker")
	}
	one, _ = g.d.Task(one.ID)
	g.conn(0).emit("item/tool/call", map[string]any{"threadId": one.Thread, "turnId": one.Turn, "callId": "three-delivery", "tool": "ss_deliver", "arguments": map[string]string{"summary": "Synthetic delivery for user review"}}, "42")
	eventually(t, func() bool { return strings.Contains(g.conn(0).reply("42"), `"success":true`) })
	var status string
	g.st.R().QueryRow(`SELECT status FROM work_items WHERE id='ORC-1'`).Scan(&status)
	if status != "review" {
		t.Fatal("agent delivery is not review", status)
	}
	complete(g.conn(0), one.Turn, "completed")
	eventually(t, func() bool { v, _ := g.d.Task(one.ID); return v.Turn == "" })
	// The fixture explicitly simulates a user accepting the prerequisite; neither Router nor Watchdog does this.
	if e = g.st.Tx(ctx, func(tx *sql.Tx) error {
		_, e := tx.Exec(`UPDATE work_items SET status='done' WHERE id='ORC-1'`)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	nativeOrchTick(t, g)
	if g.connCount() != 3 {
		t.Fatal("dependency release did not start third worker")
	}
	g.d.Close()
	g.open()
	g.c.OrchExecutor = g.d
	if e = g.c.RecoverOrchestration(ctx); e != nil {
		t.Fatal(e)
	}
	nativeOrchTick(t, g)
	if g.connCount() != 3 {
		t.Fatal("restart replayed uncertain execution")
	}
	var count int
	g.st.R().QueryRow(`SELECT count(*) FROM managed_sessions`).Scan(&count)
	if count != 3 {
		t.Fatal("duplicate worker", count)
	}
	g.st.R().QueryRow(`SELECT count(*) FROM work_items WHERE id LIKE 'ORC-%'`).Scan(&count)
	if count != 3 {
		t.Fatal("duplicate task", count)
	}
}

// I02 measures the actual background notification/timer loop, HTTP is not in this timing window.
// Native RPC is synthetic and immediately acknowledges; there are no model or network calls.
func TestOrchestrationSyntheticQueueLatency(t *testing.T) {
	g := newRig(t)
	ctx, cancel := context.WithCancel(context.Background())
	g.c.OrchExecutor = g.d
	if e := g.c.CreateWorkItem(ctx, core.WorkItemInput{ID: "LAT-1", RepoID: g.repos[0], Title: "Synthetic latency workload", Acceptance: "100 bounded synthetic inputs"}); e != nil {
		t.Fatal(e)
	}
	if e := g.c.SetOrchestrationMode(ctx, "enabled"); e != nil {
		t.Fatal(e)
	}
	done := make(chan struct{})
	go func() { defer close(done); g.c.OrchestrationRun(ctx) }()
	t.Cleanup(func() { cancel(); <-done })
	var samples []time.Duration
	var managed string
	for i := 0; i < 100; i++ {
		source := "grant:latency-grant"
		if i == 0 {
			if e := g.c.GrantOrchestration(ctx, core.OrchestrationGrant{WorkItemID: "LAT-1", Revision: "latency-grant", Input: "Synthetic latency input", StoreInput: true, MaxTurns: 100}); e != nil {
				t.Fatal(e)
			}
		} else {
			key := fmt.Sprintf("latency-feedback-%03d", i)
			source = "user:" + key
			if e := g.c.OrchestrationFeedback(ctx, "LAT-1", "latency-grant", key, "Synthetic latency follow-up", true); e != nil {
				t.Fatal(e)
			}
		}
		var delivery core.OrchestrationDelivery
		eventually(t, func() bool {
			v, e := g.c.OrchestrationView(ctx)
			if e != nil {
				return false
			}
			if len(v.Assignments) > 0 {
				managed = v.Assignments[0].ManagedID
			}
			for _, d := range v.Deliveries {
				if d.SourceID == source && d.State == "acknowledged" {
					delivery = d
					return true
				}
			}
			return false
		})
		enqueued, e := time.Parse(time.RFC3339Nano, delivery.CreatedAt)
		if e != nil {
			t.Fatal(e)
		}
		accepted, e := time.Parse(time.RFC3339Nano, delivery.UpdatedAt)
		if e != nil {
			t.Fatal(e)
		}
		samples = append(samples, accepted.Sub(enqueued))
		task, e := g.d.Task(managed)
		if e != nil {
			t.Fatal(e)
		}
		complete(g.conn(0), task.Turn, "completed")
		eventually(t, func() bool { v, _ := g.d.Task(managed); return v.Turn == "" })
	}
	sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
	p95 := samples[94]
	t.Logf("synthetic queue-to-native-accept: n=100 p50=%s p95=%s max=%s; actual background loop, no model/network", samples[49], p95, samples[99])
	if p95 > 2*time.Second {
		t.Fatalf("offline p95 target exceeded: %s", p95)
	}
	if g.connCount() != 1 || g.conn(0).count("thread/start") != 1 || g.conn(0).count("turn/start") != 100 {
		t.Fatal("latency workload duplicated/lost inputs")
	}
}
