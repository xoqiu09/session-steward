package core

// 规模压测：10 仓库 / 500 工作项 / ~600 依赖 / 300 会话 / 每会话 20–50 事件。
// `go test -short` 时跳过 TestScale*；基准见 BenchmarkSnapshot / BenchmarkIngest。

import (
	"context"
	"fmt"
	"math/rand/v2"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/store"
)

const (
	scaleRepos    = 10
	scaleItems    = 500
	scaleDeps     = 600
	scaleSessions = 300
	scaleWorkers  = 8
)

// scaleLoc 按 cwd 前缀 /scale/repoN/... 返回第 N 个仓库，每个会话一个独立 worktree。
type scaleLoc struct{}

func (scaleLoc) Locate(_ context.Context, cwd string) gitx.Location {
	parts := strings.Split(strings.TrimPrefix(cwd, "/"), "/") // scale, repoN, wt-K
	repo := parts[1]
	wt := "/scale/" + repo
	if len(parts) > 2 {
		wt += "/" + parts[2]
	}
	return gitx.Location{IsGit: true, CommonDir: "/scale/" + repo + "/.git", Worktree: wt, Branch: "main", RepoName: repo}
}

// raceEnabled 判断当前测试二进制是否带 -race。race 插桩会让纯 Go 的 SQLite 慢 20–30 倍，
// 此时阈值断言没有意义，只输出数字。
func raceEnabled() bool {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return false
	}
	for _, s := range bi.Settings {
		if s.Key == "-race" && s.Value == "true" {
			return true
		}
	}
	return false
}

func scaleCore(tb testing.TB) *Core {
	tb.Helper()
	st, err := store.Open(filepath.Join(tb.TempDir(), "scale.sqlite"))
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { st.Close() })
	return New(st, scaleLoc{})
}

type scaleData struct {
	events     int            // 实际灌入（非重复）的事件数
	ingestDur  time.Duration  // 灌入事件的总耗时（不含建工作项/依赖）
	deps       int            // 成功写入的依赖数
	tagged     int            // 通过 WorkTag 绑定的会话数
	openByKind map[string]int // 预期仍未关闭的关注项
	sample     []*event.Event // 用于重复投递校验
}

func scaleItemID(i int) string { return fmt.Sprintf("W-%d", i) }

// scaleSessionEvents 生成第 k 个会话的事件序列（不含 session_start）。
func scaleSessionEvents(k int, base time.Time, seq *int) (evs []*event.Event, tagged bool, openKind string) {
	providers := []string{"claude", "codex", "other"}
	prov := providers[k%3]
	sid := fmt.Sprintf("sess-%03d", k)
	cwd := fmt.Sprintf("/scale/repo%d/wt-%03d", k%scaleRepos, k)
	at := base
	mk := func(kind event.Kind) *event.Event {
		*seq++
		at = at.Add(time.Millisecond)
		return &event.Event{
			EventID: fmt.Sprintf("scale-%d", *seq), SchemaVersion: 1, OccurredAt: at,
			Source: event.Source{Provider: prov, HostID: "h", Client: "cli"}, Kind: kind, SessionID: sid, Cwd: cwd,
		}
	}
	total := 20 + k%31 // 20..50，含 session_start
	p := mk(event.KindPrompt)
	if k%2 == 0 {
		p.WorkTag = scaleItemID((k * 13) % scaleItems)
		tagged = true
	}
	evs = append(evs, p)
	// 结尾事件决定会话留下的关注项
	var tail []*event.Event
	switch k % 10 {
	case 0: // 观察类权限条目：notify_permission 后不再有 tool_post/stop
		n := mk(event.KindNotifyPerm)
		n.Preview, n.Reason = "rm -rf build", "permission_prompt"
		tail, openKind = []*event.Event{n}, "permission"
	case 1: // 以问句结尾 → attention
		s := mk(event.KindStop)
		s.EndsWithAsk, s.Text = true, "要继续吗？"
		tail, openKind = []*event.Event{s}, "attention"
	case 2: // 请求输入 → decision
		n := mk(event.KindNotifyInput)
		n.Reason = "agent_needs_input"
		tail, openKind = []*event.Event{n}, "decision"
	default:
		tail = []*event.Event{mk(event.KindStop)}
	}
	// 中间：tool_pre/tool_post 对，偶尔插入 prompt / compact / 中途的观察权限（随后被 tool_post 关闭）
	for i := 0; len(evs)+len(tail)+1 < total; i++ {
		switch {
		case i%9 == 4:
			evs = append(evs, mk(event.KindPrompt))
		case i%11 == 7 && total-(len(evs)+len(tail)+1) >= 3: // 保证其后至少有一对 tool_pre/tool_post 将其关闭
			evs = append(evs, mk(event.KindNotifyPerm))
		case i%13 == 5:
			evs = append(evs, mk(event.KindCompact))
		default:
			fp := fmt.Sprintf("fp-%d-%d", k, i)
			pre := mk(event.KindToolPre)
			pre.ToolName, pre.Fingerprint, pre.Preview = "Bash", fp, "go test ./..."
			evs = append(evs, pre)
			if len(evs)+len(tail)+1 < total {
				post := mk(event.KindToolPost)
				post.ToolName, post.Fingerprint = "Bash", fp
				evs = append(evs, post)
			}
		}
	}
	// 时间戳按生成顺序递增：tail 在 mk 时已取了较早的时间，这里统一重排
	all := append(evs, tail...)
	t := base
	for _, e := range all {
		t = t.Add(time.Millisecond)
		e.OccurredAt = t
	}
	return all, tagged, openKind
}

// buildScale 灌入完整数据集。workers 个 goroutine 并发灌入，同一会话的事件始终由同一 goroutine 顺序处理。
func buildScale(tb testing.TB, c *Core) scaleData {
	tb.Helper()
	ctx := context.Background()
	base := time.Now().Add(-2 * time.Minute)
	rng := rand.New(rand.NewPCG(1, 2))
	d := scaleData{openByKind: map[string]int{}}
	seq := 0

	starts := make([]*event.Event, scaleSessions)
	rest := make([][]*event.Event, scaleSessions)
	for k := 0; k < scaleSessions; k++ {
		sbase := base.Add(time.Duration(k) * 100 * time.Millisecond)
		seq++
		starts[k] = &event.Event{
			EventID: fmt.Sprintf("scale-%d", seq), SchemaVersion: 1, OccurredAt: sbase,
			Source: event.Source{Provider: []string{"claude", "codex", "other"}[k%3], HostID: "h", Client: "cli"},
			Kind:   event.KindSessionStart, SessionID: fmt.Sprintf("sess-%03d", k), Cwd: fmt.Sprintf("/scale/repo%d/wt-%03d", k%scaleRepos, k),
		}
		evs, tagged, open := scaleSessionEvents(k, sbase, &seq)
		rest[k] = evs
		if tagged {
			d.tagged++
		}
		if open != "" {
			d.openByKind[open]++
		}
		if k%3 == 0 {
			d.sample = append(d.sample, evs[len(evs)/2])
		}
	}

	ingestAll := func(batches [][]*event.Event) time.Duration {
		t0 := time.Now()
		var wg sync.WaitGroup
		var mu sync.Mutex
		var firstErr error
		next := make(chan []*event.Event)
		for w := 0; w < scaleWorkers; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for b := range next {
					for _, e := range b {
						r, err := c.Ingest(ctx, e)
						mu.Lock()
						if err != nil && firstErr == nil {
							firstErr = err
						}
						if err == nil && !r.Duplicate {
							d.events++
						}
						mu.Unlock()
					}
				}
			}()
		}
		for _, b := range batches {
			next <- b
		}
		close(next)
		wg.Wait()
		if firstErr != nil {
			tb.Fatal(firstErr)
		}
		return time.Since(t0)
	}

	// 1. session_start 建出 10 个仓库与 300 个会话
	startBatches := make([][]*event.Event, scaleSessions)
	for k := range starts {
		startBatches[k] = []*event.Event{starts[k]}
	}
	d.ingestDur += ingestAll(startBatches)

	// 2. 工作项（按仓库均分）与依赖（只从小编号指向大编号，必然无环）
	repoIDs := map[string]int64{}
	rows, err := c.St.R().Query(`SELECT id, name FROM repos`)
	if err != nil {
		tb.Fatal(err)
	}
	for rows.Next() {
		var id int64
		var name string
		rows.Scan(&id, &name)
		repoIDs[name] = id
	}
	rows.Close()
	if len(repoIDs) != scaleRepos {
		tb.Fatalf("仓库数应为 %d，实际 %d", scaleRepos, len(repoIDs))
	}
	for i := 0; i < scaleItems; i++ {
		if err := c.CreateWorkItem(ctx, WorkItemInput{ID: scaleItemID(i), RepoID: repoIDs[fmt.Sprintf("repo%d", i%scaleRepos)], Title: fmt.Sprintf("任务 %d 行情页", i)}); err != nil {
			tb.Fatal(err)
		}
	}
	seen := map[[2]int]bool{}
	for len(seen) < scaleDeps {
		a, b := rng.IntN(scaleItems), rng.IntN(scaleItems)
		if a == b {
			continue
		}
		if a > b {
			a, b = b, a
		}
		if seen[[2]int{a, b}] {
			continue
		}
		seen[[2]int{a, b}] = true
		cond := "accepted"
		if rng.IntN(4) == 0 {
			cond = "merged"
		}
		if err := c.AddDep(ctx, scaleItemID(a), scaleItemID(b), cond); err != nil {
			tb.Fatalf("AddDep %d→%d: %v", a, b, err)
		}
	}
	d.deps = len(seen)

	// 3. 其余事件
	d.ingestDur += ingestAll(rest)
	return d
}

func percentile(ds []time.Duration, p float64) time.Duration {
	s := append([]time.Duration(nil), ds...)
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	idx := int(float64(len(s)-1) * p)
	return s[idx]
}

func TestScaleSnapshotAndIngest(t *testing.T) {
	if testing.Short() {
		t.Skip("-short：跳过规模压测")
	}
	c := scaleCore(t)
	ctx := context.Background()
	d := buildScale(t, c)
	eps := float64(d.events) / d.ingestDur.Seconds()
	t.Logf("灌入 %d 事件（%d 并发）耗时 %v，吞吐 %.0f 事件/秒", d.events, scaleWorkers, d.ingestDur, eps)

	// 正确性
	var dbEvents, distinct int
	c.St.R().QueryRow(`SELECT COUNT(1), COUNT(DISTINCT event_id) FROM events`).Scan(&dbEvents, &distinct)
	if dbEvents != d.events || distinct != dbEvents {
		t.Fatalf("事件数不一致：灌入 %d，库内 %d，去重后 %d", d.events, dbEvents, distinct)
	}
	for _, e := range d.sample {
		r, err := c.Ingest(ctx, e)
		if err != nil || !r.Duplicate {
			t.Fatalf("重复投递应被识别: %v %v", r, err)
		}
	}
	c.St.R().QueryRow(`SELECT COUNT(1) FROM events`).Scan(&dbEvents)
	if dbEvents != d.events {
		t.Fatalf("重复投递后事件数变化：%d → %d", d.events, dbEvents)
	}

	snap, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Repos) != scaleRepos || len(snap.WorkItems) != scaleItems || len(snap.Sessions) != scaleSessions || len(snap.Deps) != d.deps {
		t.Fatalf("快照规模不符: repos=%d items=%d sessions=%d deps=%d(期望 %d)", len(snap.Repos), len(snap.WorkItems), len(snap.Sessions), len(snap.Deps), d.deps)
	}
	ids := map[string]bool{}
	for _, w := range snap.WorkItems {
		if ids[w.ID] {
			t.Fatalf("工作项重复: %s", w.ID)
		}
		ids[w.ID] = true
	}
	sids, bound := map[int64]bool{}, 0
	for _, s := range snap.Sessions {
		if sids[s.ID] {
			t.Fatalf("会话重复: %d（可能某会话有多个未结束 run）", s.ID)
		}
		sids[s.ID] = true
		if s.WorkItemID != "" {
			bound++
		}
		if s.WorktreeConflict {
			t.Fatalf("每个会话独立 worktree，不应报冲突: %s", s.Worktree)
		}
	}
	if bound != d.tagged {
		t.Fatalf("绑定会话数 %d，期望 %d", bound, d.tagged)
	}
	open := map[string]int{}
	for _, a := range snap.Approvals {
		if a.Status == "pending" {
			open[a.Kind]++
		}
	}
	for k, n := range d.openByKind {
		if open[k] != n {
			t.Fatalf("未关闭的 %s 关注项 %d，期望 %d（全部: %v）", k, open[k], n, open)
		}
	}
	notReady := 0
	for _, w := range snap.WorkItems {
		if !w.Ready {
			notReady++
		}
	}
	t.Logf("快照: repos=%d items=%d sessions=%d deps=%d runs=%d approvals=%d（pending %v） 未就绪工作项=%d",
		len(snap.Repos), len(snap.WorkItems), len(snap.Sessions), len(snap.Deps), len(snap.Runs), len(snap.Approvals), open, notReady)

	// Snapshot 延迟
	const n = 30
	lat := make([]time.Duration, n)
	for i := range lat {
		t0 := time.Now()
		if _, err := c.Snapshot(ctx); err != nil {
			t.Fatal(err)
		}
		lat[i] = time.Since(t0)
	}
	p50, p95 := percentile(lat, 0.5), percentile(lat, 0.95)
	t.Logf("Snapshot %d 次: p50=%v p95=%v max=%v", n, p50, p95, percentile(lat, 1))

	if raceEnabled() {
		t.Logf("-race 构建：跳过性能阈值断言（正确性断言照常执行）")
		return
	}
	if p95 > 300*time.Millisecond {
		t.Errorf("Snapshot p95 %v 超过 300ms", p95)
	}
	if eps < 500 {
		t.Errorf("Ingest 吞吐 %.0f 事件/秒 低于 500", eps)
	}
}

// TestScaleSnapshotDuringIngest：写入持续进行时读快照，检查读写互不阻塞且无数据竞争。
func TestScaleSnapshotDuringIngest(t *testing.T) {
	if testing.Short() {
		t.Skip("-short：跳过规模压测")
	}
	c := scaleCore(t)
	ctx := context.Background()
	done := make(chan scaleData)
	go func() { done <- buildScale(t, c) }()
	var lat []time.Duration
	var d scaleData
loop:
	for {
		select {
		case d = <-done:
			break loop
		default:
		}
		t0 := time.Now()
		if _, err := c.Snapshot(ctx); err != nil {
			t.Fatal(err)
		}
		lat = append(lat, time.Since(t0))
		time.Sleep(20 * time.Millisecond)
	}
	if len(lat) > 0 {
		t.Logf("灌入期间 Snapshot %d 次: p50=%v p95=%v max=%v（灌入 %d 事件耗时 %v）",
			len(lat), percentile(lat, 0.5), percentile(lat, 0.95), percentile(lat, 1), d.events, d.ingestDur)
	}
}

// benchScale 为基准准备满载数据集（每个基准各建一份，数据在 b.TempDir()）。
func benchScale(b *testing.B) *Core {
	b.Helper()
	c := scaleCore(b)
	buildScale(b, c)
	return c
}

func BenchmarkSnapshot(b *testing.B) {
	c := benchScale(b)
	ctx := context.Background()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := c.Snapshot(ctx); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkIngest：在满载数据集上单线程灌入新事件（tool_pre/tool_post 交替）。
func BenchmarkIngest(b *testing.B) {
	c := benchScale(b)
	ctx := context.Background()
	base := time.Now()
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		k := i % scaleSessions
		kind := event.KindToolPre
		if i%2 == 1 {
			kind = event.KindToolPost
		}
		e := &event.Event{
			EventID: fmt.Sprintf("bench-%d", i), SchemaVersion: 1, OccurredAt: base.Add(time.Duration(i) * time.Millisecond),
			Source: event.Source{Provider: []string{"claude", "codex", "other"}[k%3], HostID: "h", Client: "cli"},
			Kind:   kind, SessionID: fmt.Sprintf("sess-%03d", k), Cwd: fmt.Sprintf("/scale/repo%d/wt-%03d", k%scaleRepos, k),
			ToolName: "Bash", Fingerprint: fmt.Sprintf("bfp-%d", i/2),
		}
		if _, err := c.Ingest(ctx, e); err != nil {
			b.Fatal(err)
		}
	}
}
