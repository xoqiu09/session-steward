package nativecontrol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/store"
)

const secretPrompt = "PRIVATE-SYNTHETIC-PROMPT"

// fakeRPC 是一条合成的 app-server 连接。
type fakeRPC struct {
	mu      sync.Mutex
	thread  string
	events  chan Message
	once    sync.Once
	closed  bool
	calls   map[string]int
	params  map[string]any
	replies map[string]json.RawMessage
	turn    int
	failOn  string
}

func (f *fakeRPC) Call(_ context.Context, method string, p, out any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[method]++
	f.params[method] = p
	if method == f.failOn {
		return errors.New("Codex RPC " + method + ": synthetic failure")
	}
	var result any = map[string]any{}
	switch method {
	case "thread/start":
		result = map[string]any{"thread": map[string]string{"id": f.thread}}
	case "thread/resume":
		result = map[string]any{"thread": map[string]string{"id": p.(map[string]any)["threadId"].(string)}}
	case "turn/start":
		f.turn++
		result = map[string]any{"turn": map[string]string{"id": fmt.Sprintf("%s-turn-%d", f.thread, f.turn)}}
	}
	if out != nil {
		b, _ := json.Marshal(result)
		return json.Unmarshal(b, out)
	}
	return nil
}
func (f *fakeRPC) Notify(string, any) error { return nil }
func (f *fakeRPC) Reply(id json.RawMessage, v any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, _ := json.Marshal(v)
	f.replies[string(id)] = b
	return nil
}
func (f *fakeRPC) Reject(id json.RawMessage) error {
	return f.Reply(id, map[string]string{"error": "unsupported"})
}
func (f *fakeRPC) Events() <-chan Message { return f.events }
func (f *fakeRPC) Close() error {
	f.once.Do(func() { f.mu.Lock(); f.closed = true; f.mu.Unlock(); close(f.events) })
	return nil
}
func (f *fakeRPC) emit(method string, p any, id string) {
	b, _ := json.Marshal(p)
	f.events <- Message{Method: method, Params: b, ID: json.RawMessage(id)}
}
func (f *fakeRPC) count(k string) int { f.mu.Lock(); defer f.mu.Unlock(); return f.calls[k] }
func (f *fakeRPC) reply(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return string(f.replies[id])
}
func (f *fakeRPC) isClosed() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.closed }

type rig struct {
	t       *testing.T
	c       *core.Core
	st      *store.Store
	d       *Desk
	mu      sync.Mutex
	conns   []*fakeRPC
	dirs    []string
	failNew error
	failOn  string
	repos   []int64
}

func gitInit(t *testing.T, name string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), name)
	for _, args := range [][]string{{"init", "-q", "-b", "main", dir}, {"-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	real, _ := filepath.EvalSymlinks(dir)
	return real
}

// newRig 准备三个合成 Git 项目，前两个加入可派活的项目，第三个不加。
func newRig(t *testing.T) *rig {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "steward.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	c := core.New(st, gitx.NewLocator())
	c.WorktreeRoot = filepath.Join(t.TempDir(), "wt")
	g := &rig{t: t, c: c, st: st}
	for i, name := range []string{"alpha", "beta", "gamma"} {
		repo := gitInit(t, name)
		e := &event.Event{EventID: "seed-" + name, SchemaVersion: 1, OccurredAt: time.Now().UTC(), Source: event.Source{Provider: "claude", HostID: "synthetic-host"}, SessionID: "seed-" + name, Cwd: repo, Kind: event.KindSessionStart}
		if _, err := c.Ingest(context.Background(), e); err != nil {
			t.Fatal(err)
		}
		var id int64
		if err := st.R().QueryRow(`SELECT id FROM repos WHERE name=?`, name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		g.repos = append(g.repos, id)
		if i < 2 {
			if err := c.SetDispatchProject(context.Background(), id, true); err != nil {
				t.Fatal(err)
			}
		}
	}
	g.open()
	t.Cleanup(func() { g.d.Close(); st.Close() })
	return g
}

func (g *rig) open() {
	d, err := NewDesk(context.Background(), g.c, g.factory, "synthetic-host", "Synthetic Studio", "codex-cli 0.0.0-synthetic")
	if err != nil {
		g.t.Fatal(err)
	}
	g.d = d
}

func (g *rig) factory(_ context.Context, dir string) (Transport, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.failNew != nil {
		return nil, g.failNew
	}
	f := &fakeRPC{thread: fmt.Sprintf("native-thread-%d", len(g.conns)+1), events: make(chan Message, 32), calls: map[string]int{}, params: map[string]any{}, replies: map[string]json.RawMessage{}, failOn: g.failOn}
	g.conns = append(g.conns, f)
	g.dirs = append(g.dirs, dir)
	return f, nil
}

func (g *rig) conn(i int) *fakeRPC { g.mu.Lock(); defer g.mu.Unlock(); return g.conns[i] }
func (g *rig) connCount() int      { g.mu.Lock(); defer g.mu.Unlock(); return len(g.conns) }

func (g *rig) acquire(client string) int {
	v, err := g.d.Acquire(client, LocalDevice, false)
	if err != nil {
		g.t.Fatal(err)
	}
	return v.Epoch
}

func (g *rig) create(client string, epoch int, op string, repo int64) TaskView {
	g.t.Helper()
	v, err := g.d.Create(client, epoch, LocalDevice, op, repo, "合成任务 "+op, secretPrompt)
	if err != nil {
		g.t.Fatal(err)
	}
	return v
}

func eventually(t *testing.T, fn func() bool) {
	t.Helper()
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		if fn() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition not reached")
}

func complete(f *fakeRPC, turn, status string) {
	f.emit("turn/completed", map[string]any{"threadId": f.thread, "turn": map[string]string{"id": turn, "status": status}}, "")
}

func (g *rig) task(id string) TaskView {
	v, err := g.d.Task(id)
	if err != nil {
		g.t.Fatal(err)
	}
	return v
}

func TestTwoAuthorizedProjectsRunIndependentlyUnauthorizedRefused(t *testing.T) {
	g := newRig(t)
	epoch := g.acquire("controller-one")
	a := g.create("controller-one", epoch, "operation-a1", g.repos[0])
	b := g.create("controller-one", epoch, "operation-b1", g.repos[1])
	if a.Status != "running" || b.Status != "running" || a.Turn == "" || b.Turn == "" {
		t.Fatalf("两件任务都应在执行：%+v %+v", a, b)
	}
	if a.Thread == b.Thread || a.Worktree == b.Worktree || a.Branch == b.Branch || a.WorkItemID == b.WorkItemID {
		t.Fatal("两件任务共享了会话、目录、分支或工作项")
	}
	if g.dirs[0] != a.Worktree || g.dirs[1] != b.Worktree {
		t.Fatalf("Codex 没有在各自的 worktree 里启动：%v", g.dirs)
	}
	if p := g.conn(0).params["turn/start"].(map[string]any); p["sandboxPolicy"].(map[string]any)["writableRoots"].([]string)[0] != a.Worktree {
		t.Fatal("可写目录不是任务自己的 worktree")
	}
	// 一件结束不影响另一件
	complete(g.conn(0), a.Turn, "completed")
	eventually(t, func() bool { return g.task(a.ID).Status == "idle" })
	if g.task(b.ID).Status != "running" {
		t.Fatal("另一件任务被影响了")
	}
	if _, err := g.d.Create("controller-one", epoch, LocalDevice, "operation-c1", g.repos[2], "未授权", secretPrompt); !errors.Is(err, core.ErrForbidden) {
		t.Fatalf("未授权项目应拒绝：%v", err)
	}
	if g.connCount() != 2 {
		t.Fatal("未授权项目不应启动 Codex")
	}
	// 任务文字不进库
	for _, q := range []string{`SELECT count(*) FROM events WHERE body LIKE '%' || ? || '%'`, `SELECT count(*) FROM managed_audit WHERE detail LIKE '%' || ? || '%'`, `SELECT count(*) FROM managed_sessions WHERE title LIKE '%' || ? || '%' OR error LIKE '%' || ? || '%'`} {
		var n int
		args := []any{secretPrompt}
		if strings.Count(q, "?") == 2 {
			args = append(args, secretPrompt)
		}
		if err := g.st.R().QueryRow(q, args...).Scan(&n); err != nil || n != 0 {
			t.Fatalf("任务文字进了数据库：%s n=%d err=%v", q, n, err)
		}
	}
	var device string
	g.st.R().QueryRow(`SELECT device FROM managed_audit WHERE managed_id=? AND action='create'`, a.ID).Scan(&device)
	if device != LocalDevice {
		t.Fatalf("审计没有记设备：%q", device)
	}
}

func TestSameOperationCreatesAndRunsOnce(t *testing.T) {
	g := newRig(t)
	epoch := g.acquire("controller-one")
	a := g.create("controller-one", epoch, "operation-once", g.repos[0])
	again := g.create("controller-one", epoch, "operation-once", g.repos[0])
	if again.ID != a.ID || g.connCount() != 1 || g.conn(0).count("turn/start") != 1 {
		t.Fatal("同一个 operation 建了两件或执行了两次")
	}
	complete(g.conn(0), a.Turn, "completed")
	eventually(t, func() bool { return g.task(a.ID).Status == "idle" })
	if _, err := g.d.Start("controller-one", epoch, LocalDevice, a.ID, "operation-next", "next step"); err != nil {
		t.Fatal(err)
	}
	if _, err := g.d.Start("controller-one", epoch, LocalDevice, a.ID, "operation-next", "next step"); err != nil {
		t.Fatal(err)
	}
	if g.conn(0).count("turn/start") != 2 || g.conn(0).count("thread/start") != 1 {
		t.Fatal("下一步应在同一会话里只执行一次")
	}
}

func TestClosingPageKeepsRunningAndRestartDoesNotRerun(t *testing.T) {
	g := newRig(t)
	epoch := g.acquire("controller-one")
	a := g.create("controller-one", epoch, "operation-restart", g.repos[0])
	// 页面关掉只是不再请求；任务照常收到事件
	g.conn(0).emit("item/completed", map[string]any{"threadId": a.Thread, "turnId": a.Turn, "item": map[string]any{"id": "cmd-1", "type": "commandExecution", "exitCode": 0}}, "")
	eventually(t, func() bool {
		for _, e := range g.task(a.ID).Events {
			if e.Action == "tool_post:commandExecution" {
				return true
			}
		}
		return false
	})
	// 服务重启：这一轮结果不明，不自动重跑
	g.d.Close()
	g.open()
	v := g.task(a.ID)
	if v.Status != "needs_reconcile" || v.Thread != a.Thread || g.connCount() != 1 {
		t.Fatalf("重启后应标待核对且不重连：%+v conns=%d", v, g.connCount())
	}
	epoch = g.acquire("controller-two")
	if _, err := g.d.Start("controller-two", epoch, LocalDevice, a.ID, "operation-after", "x"); !errors.Is(err, ErrState) {
		t.Fatalf("待核对时不能直接派下一步：%v", err)
	}
	v, err := g.d.Resume("controller-two", epoch, LocalDevice, a.ID)
	if err != nil || v.Status != "idle" || v.Turn != "" {
		t.Fatalf("恢复同一会话失败：%+v %v", v, err)
	}
	f := g.conn(1)
	if f.count("thread/resume") != 1 || f.count("thread/start") != 0 || f.count("turn/start") != 0 {
		t.Fatal("恢复应只连回原会话，不新开、不重跑")
	}
	if f.params["thread/resume"].(map[string]any)["threadId"] != a.Thread {
		t.Fatal("恢复的不是同一条会话")
	}
}

func TestInterruptAndDeliveryNeverMarkHandled(t *testing.T) {
	g := newRig(t)
	epoch := g.acquire("controller-one")
	a := g.create("controller-one", epoch, "operation-stop", g.repos[0])
	f := g.conn(0)
	if _, err := g.d.Interrupt("controller-one", epoch, LocalDevice, a.ID); err != nil {
		t.Fatal(err)
	}
	if f.count("turn/interrupt") != 1 {
		t.Fatal("没有请求停止本轮")
	}
	complete(f, a.Turn, "interrupted")
	eventually(t, func() bool { return g.task(a.ID).Status == "interrupted" })
	if g.task(a.ID).WorkStatus == "done" {
		t.Fatal("停止不应标已处理")
	}
	v, err := g.d.Start("controller-one", epoch, LocalDevice, a.ID, "operation-deliver", "finish")
	if err != nil {
		t.Fatal(err)
	}
	f.emit("item/tool/call", map[string]any{"threadId": a.Thread, "turnId": v.Turn, "callId": "call-1", "tool": "ss_deliver", "arguments": map[string]string{"summary": "合成交付摘要"}}, "41")
	eventually(t, func() bool { return strings.Contains(f.reply("41"), `"success":true`) })
	complete(f, v.Turn, "completed")
	eventually(t, func() bool { v = g.task(a.ID); return v.Status == "idle" })
	if v.WorkStatus != "review" || v.DeliverySummary != "合成交付摘要" {
		t.Fatalf("Agent 交付应进入待验收：%s %q", v.WorkStatus, v.DeliverySummary)
	}
}

func approvalRequest(f *fakeRPC, thread, turn, id, command string) {
	f.emit("item/commandExecution/requestApproval", map[string]any{"threadId": thread, "turnId": turn, "itemId": "item-" + id, "command": command}, id)
}

func TestApprovalAllowOnceDenyAndDuplicateConflict(t *testing.T) {
	g := newRig(t)
	epoch := g.acquire("controller-one")
	a := g.create("controller-one", epoch, "operation-approve", g.repos[0])
	f := g.conn(0)
	approvalRequest(f, a.Thread, a.Turn, "7", "git status")
	var p *Pending
	eventually(t, func() bool {
		if v := g.task(a.ID); len(v.Pending) == 1 {
			p = v.Pending[0]
		}
		return p != nil
	})
	if p.Details != "git status" || !p.Approvable {
		t.Fatalf("派活台应能看到命令并允许：%+v", p)
	}
	if list := g.d.View().Tasks[0].Pending; len(list) != 1 || list[0].Details != "" {
		t.Fatal("任务列表里不应带命令正文")
	}
	if !g.d.OwnsApproval(p.ID) {
		t.Fatal("普通审批接口应被拦住")
	}
	if _, err := g.d.Decide("controller-one", epoch, LocalDevice, a.ID, p.ID, p.Fingerprint, "allow"); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return f.reply("7") == `{"decision":"accept"}` })
	if _, err := g.d.Decide("controller-one", epoch, LocalDevice, a.ID, p.ID, p.Fingerprint, "deny"); !errors.Is(err, core.ErrConflict) {
		t.Fatalf("重复决定应冲突：%v", err)
	}
	approvalRequest(f, a.Thread, a.Turn, "8", "rm -rf build")
	p = nil
	eventually(t, func() bool {
		if v := g.task(a.ID); len(v.Pending) == 1 {
			p = v.Pending[0]
		}
		return p != nil
	})
	if _, err := g.d.Decide("controller-one", epoch, LocalDevice, a.ID, p.ID, p.Fingerprint, "deny"); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return f.reply("8") == `{"decision":"decline"}` })
	var n int
	g.st.R().QueryRow(`SELECT count(*) FROM managed_audit WHERE detail LIKE '%git status%' OR detail LIKE '%rm -rf%'`).Scan(&n)
	if n != 0 {
		t.Fatal("命令正文进了审计")
	}
}

func TestTakeoverNeedsForceAndFencesOldController(t *testing.T) {
	g := newRig(t)
	epoch := g.acquire("controller-one")
	a := g.create("controller-one", epoch, "operation-lease", g.repos[0])
	approvalRequest(g.conn(0), a.Thread, a.Turn, "9", "git diff")
	eventually(t, func() bool { return len(g.task(a.ID).Pending) == 1 })
	if _, err := g.d.Acquire("controller-two", LocalDevice, false); !errors.Is(err, ErrLease) {
		t.Fatalf("别人正在控制时不应悄悄接走：%v", err)
	}
	v, err := g.d.Acquire("controller-two", LocalDevice, true)
	if err != nil || v.Owner != "controller-two" || v.Epoch == epoch {
		t.Fatalf("接过来失败：%+v %v", v, err)
	}
	if _, err := g.d.Interrupt("controller-one", epoch, LocalDevice, a.ID); !errors.Is(err, ErrLease) {
		t.Fatalf("旧控制者应只能看：%v", err)
	}
	// 审批属于这一轮，换人控制后仍在，由新控制者决定
	p := g.task(a.ID).Pending
	if len(p) != 1 {
		t.Fatal("换人控制不应取消等待中的审批")
	}
	if _, err := g.d.Decide("controller-two", v.Epoch, LocalDevice, a.ID, p[0].ID, p[0].Fingerprint, "allow"); err != nil {
		t.Fatal(err)
	}
}

func TestHandoffReleasesWriterAndStopsDispatch(t *testing.T) {
	g := newRig(t)
	epoch := g.acquire("controller-one")
	a := g.create("controller-one", epoch, "operation-hand", g.repos[0])
	f := g.conn(0)
	if _, err := g.d.Handoff("controller-one", epoch, LocalDevice, a.ID); !errors.Is(err, ErrState) {
		t.Fatalf("本轮没结束时不能交回电脑：%v", err)
	}
	complete(f, a.Turn, "completed")
	eventually(t, func() bool { return g.task(a.ID).Status == "idle" })
	v, err := g.d.Handoff("controller-one", epoch, LocalDevice, a.ID)
	if err != nil || !v.Desktop || !f.isClosed() {
		t.Fatalf("交回电脑应释放写入并关掉 app-server：%+v %v", v, err)
	}
	if _, err := g.d.Start("controller-one", epoch, LocalDevice, a.ID, "operation-after-hand", "x"); !errors.Is(err, ErrState) {
		t.Fatalf("交给电脑后派活台不再写这条会话：%v", err)
	}
	if v.Thread != a.Thread || g.connCount() != 1 {
		t.Fatal("交回电脑不应新开会话")
	}
}

func TestConnectFailureBeforeTurnCanRetrySameOperation(t *testing.T) {
	g := newRig(t)
	epoch := g.acquire("controller-one")
	g.failOn = "thread/start"
	v, err := g.d.Create("controller-one", epoch, LocalDevice, "operation-retry", g.repos[0], "合成任务", secretPrompt)
	if err == nil || v.Status != "ready" || v.Error == "" {
		t.Fatalf("没连上 Codex 时应回到可重试：%+v %v", v, err)
	}
	g.failOn = ""
	v, err = g.d.Start("controller-one", epoch, LocalDevice, v.ID, "operation-retry", secretPrompt)
	if err != nil || v.Status != "running" {
		t.Fatalf("同一个 operation 应能重试：%+v %v", v, err)
	}
}

func TestUncertainAfterTurnStartIsNotRetried(t *testing.T) {
	g := newRig(t)
	epoch := g.acquire("controller-one")
	g.failOn = "turn/start"
	v, err := g.d.Create("controller-one", epoch, LocalDevice, "operation-uncertain", g.repos[0], "合成任务", secretPrompt)
	if !errors.Is(err, ErrState) || v.Status != "uncertain" {
		t.Fatalf("turn/start 发出后失败应标结果不明：%+v %v", v, err)
	}
	g.failOn = ""
	again, err := g.d.Start("controller-one", epoch, LocalDevice, v.ID, "operation-uncertain", secretPrompt)
	if err != nil || again.Status != "uncertain" || g.connCount() != 1 {
		t.Fatalf("同一个 operation 不应自动重发：%+v %v", again, err)
	}
}
