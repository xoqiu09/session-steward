package hook

import (
	"fmt"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func spoolWith(t *testing.T, n int) *Spool {
	t.Helper()
	s := &Spool{Dir: t.TempDir(), Max: 5000}
	for i := 0; i < n; i++ {
		s.Append(&event.Event{EventID: fmt.Sprintf("e%04d", i)})
	}
	return s
}

func ids(list []event.Event) map[string]bool {
	m := map[string]bool{}
	for _, e := range list {
		m[e.EventID] = true
	}
	return m
}

// 补发期间（网络发送中）不持有暂存锁：其他 hook 进程的 Append 立即完成，且新事件不会被补发的写回覆盖。
func TestDrainDoesNotHoldLockWhileSending(t *testing.T) {
	s := spoolWith(t, 3)
	other := &Spool{Dir: s.Dir, Max: s.Max}
	calls := 0
	s.Drain(func(batch []event.Event) map[string]bool {
		calls++
		if calls == 1 {
			done := make(chan struct{})
			go func() { other.Append(&event.Event{EventID: "late"}); close(done) }()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("发送期间 Append 被暂存锁阻塞")
			}
		}
		return ids(batch)
	})
	left := s.read()
	if len(left) != 0 {
		t.Fatalf("补发期间追加的事件也应在同一轮补发: %v", left)
	}
	if calls != 2 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestDrainKeepsUnackedAndStopsOnFailure(t *testing.T) {
	s := spoolWith(t, 450)
	var batches []int
	s.Drain(func(batch []event.Event) map[string]bool {
		batches = append(batches, len(batch))
		switch len(batches) {
		case 1: // 第一批只确认偶数号
			ok := map[string]bool{}
			for i, e := range batch {
				if i%2 == 0 {
					ok[e.EventID] = true
				}
			}
			return ok
		case 2:
			return ids(batch)
		default:
			return nil // 第三批发送失败
		}
	})
	if len(batches) != 3 || batches[0] != drainBatch || batches[1] != drainBatch || batches[2] != 50 {
		t.Fatalf("批次 %v", batches)
	}
	left := s.read()
	if len(left) != 100+50 {
		t.Fatalf("剩余 %d 条，应为第一批未确认的 100 条加发送失败的 50 条", len(left))
	}
	if left[0].EventID != "e0001" || left[len(left)-1].EventID != "e0449" {
		t.Fatalf("顺序错误: %s..%s", left[0].EventID, left[len(left)-1].EventID)
	}
	// 未确认的事件本轮不重发，下一次补发再试
	n := 0
	s.Drain(func(batch []event.Event) map[string]bool { n += len(batch); return ids(batch) })
	if n != 150 || len(s.read()) != 0 {
		t.Fatalf("第二轮补发 %d 条，剩余 %d", n, len(s.read()))
	}
}

// 已有进程在补发时，另一个进程不重复发送同一批事件。
func TestConcurrentDrainIsSkipped(t *testing.T) {
	s := spoolWith(t, 2)
	other := &Spool{Dir: s.Dir, Max: s.Max}
	otherCalls := 0
	s.Drain(func(batch []event.Event) map[string]bool {
		other.Drain(func([]event.Event) map[string]bool { otherCalls++; return nil })
		return ids(batch)
	})
	if otherCalls != 0 {
		t.Fatal("并发补发应跳过")
	}
	if len(s.read()) != 0 {
		t.Fatal("应全部确认")
	}
}
