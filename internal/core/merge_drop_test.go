package core

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

// “不再合并”关掉整组审批、工作项改为不需要合并，状态和验收不变；之后的扫描不会再把它排进合并队列。
func TestDropMergeClosesGroupAndKeepsWorkStatus(t *testing.T) {
	c := groupFixture(t)
	ctx := context.Background()
	if err := c.DropMerge(ctx, "A-1"); err != nil {
		t.Fatal(err)
	}
	var open, dropped, needs, review int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE id IN ('A-1','A-2') AND status IN ('pending','decided')`).Scan(&open)
	c.St.R().QueryRow(`SELECT COUNT(*) FROM approvals WHERE id IN ('A-1','A-2') AND close_reason='not_merging'`).Scan(&dropped)
	c.St.R().QueryRow(`SELECT COUNT(*) FROM work_items WHERE id IN ('A-1','A-2') AND needs_merge=1`).Scan(&needs)
	c.St.R().QueryRow(`SELECT COUNT(*) FROM work_items WHERE id IN ('A-1','A-2') AND status='review'`).Scan(&review)
	if open != 0 || dropped != 2 || needs != 0 || review != 2 {
		t.Fatal("drop scope", open, dropped, needs, review)
	}
	var other string
	c.St.R().QueryRow(`SELECT status FROM approvals WHERE id='B-1'`).Scan(&other)
	if other != "pending" {
		t.Fatal("another repository's approval was touched", other)
	}
	if items, err := c.mergeItems(ctx, 1); err != nil || len(items) != 0 {
		t.Fatal("dropped work is still queued for merge scanning", items, err)
	}
	if err := c.DropMerge(ctx, "A-1"); !errors.Is(err, ErrConflict) {
		t.Fatal("dropping a closed approval twice", err)
	}
}

func TestMergeSyncBacksOffAfterRepeatedFailures(t *testing.T) {
	cases := []struct {
		s    MergeSyncStatus
		want time.Duration
	}{
		{MergeSyncStatus{State: "checked"}, time.Minute},
		{MergeSyncStatus{State: "failed", Failures: 1}, time.Minute},
		{MergeSyncStatus{State: "failed", Failures: 2}, 2 * time.Minute},
		{MergeSyncStatus{State: "failed", Failures: 4}, 8 * time.Minute},
		{MergeSyncStatus{State: "failed", Failures: 30}, 15 * time.Minute},
	}
	for _, c := range cases {
		if got := mergeSyncWait(c.s); got != c.want {
			t.Errorf("%+v: got %v, want %v", c.s, got, c.want)
		}
	}
}

func TestReadableFetchError(t *testing.T) {
	cases := map[string]string{
		"signal: killed": "超时",
		"exit status 128: remote: Repository not found.":                                                "没有权限",
		"exit status 128: fatal: unable to access 'https://github.com/x/y.git/': TLS handshake timeout": "网络",
	}
	for in, want := range cases {
		if got := readableFetchError(errors.New(in)); !strings.Contains(got, want) {
			t.Errorf("%q → %q，应包含 %q", in, got, want)
		}
	}
}
