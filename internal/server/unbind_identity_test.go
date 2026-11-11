package server

import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/xoqiu09/session-steward/internal/core"
)

func testUnbindTarget(t *testing.T, c *core.Core, sid int64) core.UnbindTarget {
	t.Helper()
	var target core.UnbindTarget
	if err := c.St.R().QueryRow(`SELECT id,work_item_id FROM runs WHERE session_id=? AND ended_at=''`, sid).Scan(&target.RunID, &target.WorkItemID); err != nil {
		t.Fatal(err)
	}
	return target
}

func TestUnbindRequiresIdentityAndPreservesSuccessfulRetry(t *testing.T) {
	ts, c, _ := start(t)
	seedCollectedSignal(t, c)
	snap, _ := c.Snapshot(context.Background())
	sid := snap.Sessions[0].ID
	target := testUnbindTarget(t, c, sid)
	path := fmt.Sprintf("/api/sessions/%d/unbind", sid)
	if code, body := panelReq(t, ts, "POST", path, map[string]string{"outcome": "delivered"}); code != http.StatusConflict || !strings.Contains(string(body), "刷新") {
		t.Fatalf("legacy panel must refresh instead of ending an unobserved run: %d %s", code, body)
	}
	if got := testUnbindTarget(t, c, sid); got != target {
		t.Fatal("missing identity ended the current run")
	}
	if code, body := panelReq(t, ts, "POST", path, map[string]any{"outcome": "delivered", "expected_run_id": "invalid", "expected_work_item_id": target.WorkItemID}); code != http.StatusBadRequest {
		t.Fatalf("malformed identity must not be silently ignored: %d %s", code, body)
	}
	if got := testUnbindTarget(t, c, sid); got != target {
		t.Fatal("malformed identity ended the current run")
	}
	request := map[string]any{"outcome": "delivered", "expected_run_id": target.RunID, "expected_work_item_id": target.WorkItemID}
	for i := 0; i < 2; i++ {
		if code, body := panelReq(t, ts, "POST", path, request); code != http.StatusOK {
			t.Fatalf("exact target and its retry must succeed: %d %s", code, body)
		}
	}
	var outcome, status string
	if err := c.St.R().QueryRow(`SELECT outcome FROM runs WHERE id=? AND ended_at<>''`, target.RunID).Scan(&outcome); err != nil || outcome != "delivered" {
		t.Fatalf("expected only this run to be delivered: %s %v", outcome, err)
	}
	if err := c.St.R().QueryRow(`SELECT status FROM work_items WHERE id=?`, target.WorkItemID).Scan(&status); err != nil || status == "done" {
		t.Fatalf("ending a run must not accept the work item: %s %v", status, err)
	}
}

func TestStaleUnbindCannotEndAnotherWorkItem(t *testing.T) {
	ts, c, _ := start(t)
	seedCollectedSignal(t, c)
	ctx := context.Background()
	before, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	sid := before.Sessions[0].ID
	var oldRun int64
	if err := c.St.R().QueryRow(`SELECT id FROM runs WHERE session_id=? AND work_item_id='SIG-1' AND ended_at=''`, sid).Scan(&oldRun); err != nil {
		t.Fatal(err)
	}
	var secondRepo int64
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		result, err := tx.Exec(`INSERT INTO repos(common_dir,name,is_git,target_ref,created_at) VALUES('/synthetic/project-b/.git','合成项目B',1,'main',?)`, c.St.NowTS())
		if err != nil {
			return err
		}
		secondRepo, err = result.LastInsertId()
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := c.CreateWorkItem(ctx, core.WorkItemInput{ID: "SIG-2", Title: "合成另一项目工作", RepoID: secondRepo}); err != nil {
		t.Fatal(err)
	}
	if err := c.BindManual(ctx, sid, "SIG-2"); err != nil {
		t.Fatal(err)
	}
	path := fmt.Sprintf("/api/sessions/%d/unbind", sid)
	code, body := panelReq(t, ts, "POST", path, map[string]any{"outcome": "delivered", "expected_run_id": oldRun, "expected_work_item_id": "SIG-1"})
	var activeB int
	if err := c.St.R().QueryRow(`SELECT COUNT(*) FROM runs WHERE session_id=? AND work_item_id='SIG-2' AND ended_at=''`, sid).Scan(&activeB); err != nil {
		t.Fatal(err)
	}
	if code != http.StatusConflict || activeB != 1 {
		t.Fatalf("旧A页面的解绑必须被拒绝且保留B运行：status=%d active_B=%d response=%s", code, activeB, body)
	}
}
