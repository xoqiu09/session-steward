package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

func TestStaleWorkItemReviewKeepsStatusAndRuns(t *testing.T) {
	for _, tc := range []struct {
		name           string
		returned       bool
		deliveredAgain bool
		status         string
		management     bool
	}{
		{name: "accept_after_return", returned: true, status: "done"},
		{name: "accept_after_redelivery", returned: true, deliveredAgain: true, status: "done"},
		{name: "return_after_new_delivery_with_same_time", deliveredAgain: true, status: "in_progress"},
		{name: "mark_handled_after_redelivery", returned: true, deliveredAgain: true, management: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st, err := store.Open(filepath.Join(t.TempDir(), "review.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { st.Close() })
			ctx := context.Background()
			c := core.New(st, nil)
			at := seedCollectedSignal(t, c).Add(2 * time.Hour)
			h := (&Server{Core: c, PanelToken: "pan"}).Handler()

			deliver := func(id string) {
				t.Helper()
				e := collectedSignalEvent(id, event.KindDeliver, "hook", at)
				if _, err := c.Ingest(ctx, &e); err != nil {
					t.Fatal(err)
				}
			}
			type state struct {
				Cursor    int64
				Runs      []core.Run
				WorkItems []struct {
					core.WorkItem
					Revision string `json:"review_revision"`
				} `json:"work_items"`
			}
			read := func() state {
				t.Helper()
				w := liveDo(h, "GET", local, "/api/snapshot", cookieName, "pan", "", false)
				var s state
				if err := json.Unmarshal(w.Body.Bytes(), &s); w.Code != http.StatusOK || err != nil {
					t.Fatalf("读取工作状态失败：HTTP %d，%s，%v", w.Code, w.Body, err)
				}
				if len(s.WorkItems) != 1 || len(s.Runs) != 1 || s.Runs[0].EndedAt != "" {
					t.Fatalf("测试需要一个工作项和一个进行中的运行：%+v", s)
				}
				return s
			}
			patch := func(body string) (int, string) {
				w := liveDo(h, "PATCH", local, "/api/work-items/SIG-1", cookieName, "pan", body, true)
				return w.Code, strings.TrimSpace(w.Body.String())
			}
			review := func(status, revision string) (int, string) {
				return patch(fmt.Sprintf(`{"status":%q,"expected_review_revision":%q}`, status, revision))
			}

			deliver("first-delivery")
			old := read().WorkItems[0].Revision
			if tc.returned {
				if code, body := review("in_progress", old); code != http.StatusOK {
					t.Fatalf("本轮退回失败：HTTP %d，%s", code, body)
				}
			}
			wantStatus := "in_progress"
			if tc.deliveredAgain {
				deliver("second-delivery")
				wantStatus = "review"
			}
			before := read()
			if got := before.WorkItems[0].Status; got != wantStatus {
				t.Fatalf("错误的测试初始状态：得到 %s，预期 %s", got, wantStatus)
			}
			request := fmt.Sprintf(`{"status":%q,"expected_review_revision":%q}`, tc.status, old)
			if tc.management {
				request = fmt.Sprintf(`{"management":{"state":"accepted"},"expected_review_revision":%q}`, old)
				if code, body := patch(`{"management":{"state":"accepted"}}`); code != http.StatusConflict {
					t.Errorf("未带交付版本的已处理应被拒绝：HTTP %d，%s", code, body)
				}
			}
			if code, body := patch(request); code != http.StatusConflict || !strings.Contains(body, "重新查看") {
				t.Fatalf("旧交付操作应返回 HTTP 409 并提示重新查看：得到 HTTP %d，%s", code, body)
			}
			if after := read(); !reflect.DeepEqual(before, after) {
				t.Fatalf("旧请求改变了工作状态或运行：之前 %+v，之后 %+v", before, after)
			}
			if old == "" {
				t.Fatal("第一轮交付没有版本")
			}

			if tc.deliveredAgain {
				if code, body := patch(`{"status":"done"}`); code != http.StatusConflict {
					t.Fatalf("未带交付版本的验收应被拒绝：HTTP %d，%s", code, body)
				}
				if after := read(); !reflect.DeepEqual(before, after) {
					t.Fatal("未带交付版本的验收改变了工作状态或运行")
				}
				request := fmt.Sprintf(`{"status":"done","expected_review_revision":%q}`, before.WorkItems[0].Revision)
				if tc.management {
					request = fmt.Sprintf(`{"management":{"state":"accepted"},"expected_review_revision":%q}`, before.WorkItems[0].Revision)
				}
				if code, body := patch(request); code != http.StatusOK {
					t.Fatalf("验收当前交付失败：HTTP %d，%s", code, body)
				}
				snap, err := c.Snapshot(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if snap.WorkItems[0].Status != "done" || snap.Runs[0].EndedAt == "" || snap.Runs[0].Outcome != "delivered" {
					t.Fatalf("当前交付的验收没有完成工作和运行：%+v，%+v", snap.WorkItems[0], snap.Runs[0])
				}
				if tc.management && (snap.WorkItems[0].Management == nil || snap.WorkItems[0].Management.State != "accepted") {
					t.Fatal("当前交付未留下已处理记录")
				}
			}
		})
	}
}

func TestWorkItemReviewWithLateDeliveryOrLegacyReturn(t *testing.T) {
	for _, lateDelivery := range []bool{false, true} {
		name := "legacy_return_after_acceptance"
		if lateDelivery {
			name = "late_older_delivery_keeps_current_revision"
		}
		t.Run(name, func(t *testing.T) {
			st, err := store.Open(filepath.Join(t.TempDir(), "review.sqlite"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { st.Close() })
			ctx := context.Background()
			c := core.New(st, nil)
			at := seedCollectedSignal(t, c).Add(2 * time.Hour)
			h := (&Server{Core: c, PanelToken: "pan"}).Handler()
			patch := func(body string) *httptest.ResponseRecorder {
				return liveDo(h, "PATCH", local, "/api/work-items/SIG-1", cookieName, "pan", body, true)
			}
			read := func() *core.Snapshot {
				t.Helper()
				s, err := c.Snapshot(ctx)
				if err != nil {
					t.Fatal(err)
				}
				return s
			}
			deliver := func(id string, when time.Time) {
				t.Helper()
				e := collectedSignalEvent(id, event.KindDeliver, "hook", when)
				e.Brief["summary"] = id
				if _, err := c.Ingest(ctx, &e); err != nil {
					t.Fatal(err)
				}
			}
			deliver("current", at)
			current := read().WorkItems[0]
			if current.ReviewRevision == "" {
				t.Fatal("当前交付没有版本")
			}
			if lateDelivery {
				deliver("late-older", at.Add(-time.Hour))
				item := read().WorkItems[0]
				if item.Brief.LastDeliveredAt != store.TS(at) || item.Brief.Fields["summary"].Text != "current" {
					t.Fatalf("页面上的交付不是当前交付：%+v", item.Brief)
				}
				if item.ReviewRevision != current.ReviewRevision {
					t.Errorf("迟到的旧交付改变了当前编号：%q → %q", current.ReviewRevision, item.ReviewRevision)
				}
			}
			if w := patch(fmt.Sprintf(`{"status":"done","expected_review_revision":%q}`, current.ReviewRevision)); w.Code != http.StatusOK {
				t.Fatalf("当前交付应可验收：HTTP %d，%s", w.Code, w.Body)
			}
			if lateDelivery {
				return
			}
			accepted := read()
			if w := patch(`{"status":"in_progress"}`); w.Code != http.StatusConflict {
				t.Errorf("旧网页的退回应被拒绝：HTTP %d，%s", w.Code, w.Body)
			}
			after := read()
			if !reflect.DeepEqual(accepted.WorkItems, after.WorkItems) || !reflect.DeepEqual(accepted.Runs, after.Runs) {
				t.Fatal("旧网页的退回改变了验收或运行记录")
			}
			if w := patch(`{"status":"in_progress","expected_status":"done"}`); w.Code != http.StatusOK || read().WorkItems[0].Status != "in_progress" {
				t.Fatalf("明确要求重开已完成任务应成功：HTTP %d，%s", w.Code, w.Body)
			}
		})
	}
}

func TestSnapshotKeepsAcceptanceTimeAfterTitleEdit(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "review.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ctx := context.Background()
	c := core.New(st, nil)
	h := (&Server{Core: c, PanelToken: "pan"}).Handler()
	const id = "DEMO-1"
	acceptedAt := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)
	now := acceptedAt.Add(-time.Hour)
	st.Now = func() time.Time { return now }
	if err := c.CreateWorkItem(ctx, core.WorkItemInput{ID: id, Title: "旧标题"}); err != nil {
		t.Fatal(err)
	}
	now = acceptedAt
	done := "done"
	if err := c.UpdateWorkItem(ctx, id, core.WorkItemPatch{Status: &done}); err != nil {
		t.Fatal(err)
	}
	now = acceptedAt.Add(24 * time.Hour)
	if w := liveDo(h, "PATCH", local, "/api/work-items/"+id, cookieName, "pan", `{"title":"新标题"}`, true); w.Code != http.StatusOK {
		t.Fatalf("edit title: HTTP %d %s", w.Code, w.Body)
	}
	w := liveDo(h, "GET", local, "/api/snapshot", cookieName, "pan", "", false)
	var snapshot struct {
		WorkItems []struct {
			Title           string `json:"title"`
			UpdatedAt       string `json:"updated_at"`
			StatusChangedAt string `json:"status_changed_at"`
		} `json:"work_items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &snapshot); w.Code != http.StatusOK || err != nil || len(snapshot.WorkItems) != 1 {
		t.Fatalf("read snapshot: HTTP %d %s (%v)", w.Code, w.Body, err)
	}
	item := snapshot.WorkItems[0]
	if item.Title != "新标题" || item.UpdatedAt != store.TS(now) {
		t.Fatalf("title edit not reflected in snapshot: %+v", item)
	}
	if item.StatusChangedAt != store.TS(acceptedAt) {
		t.Errorf("snapshot status_changed_at = %q, want acceptance time %q", item.StatusChangedAt, store.TS(acceptedAt))
	}
}
