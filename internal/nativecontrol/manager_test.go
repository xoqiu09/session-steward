package nativecontrol

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/server"
	"github.com/xoqiu09/session-steward/internal/store"
)

type fakeRPC struct {
	mu                sync.Mutex
	events            chan Message
	once              sync.Once
	calls             map[string]int
	replies           map[string]json.RawMessage
	resumed           string
	interruptedThread string
	interruptedTurn   string
	turn              int
}

func newFake() *fakeRPC {
	return &fakeRPC{events: make(chan Message, 32), calls: map[string]int{}, replies: map[string]json.RawMessage{}}
}
func (f *fakeRPC) Call(_ context.Context, method string, p, out any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[method]++
	var result any = map[string]any{}
	switch method {
	case "thread/start":
		result = map[string]any{"thread": map[string]string{"id": "native-thread-synthetic"}}
	case "thread/resume":
		f.resumed = p.(map[string]any)["threadId"].(string)
		result = map[string]any{"thread": map[string]string{"id": f.resumed}}
	case "turn/start":
		f.turn++
		result = map[string]any{"turn": map[string]string{"id": "turn-" + string(rune('0'+f.turn))}}
	case "turn/interrupt":
		in := p.(map[string]string)
		f.interruptedThread = in["threadId"]
		f.interruptedTurn = in["turnId"]
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
func (f *fakeRPC) Close() error           { f.once.Do(func() { close(f.events) }); return nil }
func (f *fakeRPC) emit(method string, p any, id string) {
	b, _ := json.Marshal(p)
	f.events <- Message{Method: method, Params: b, ID: json.RawMessage(id)}
}
func (f *fakeRPC) count(k string) int { f.mu.Lock(); defer f.mu.Unlock(); return f.calls[k] }
func fixture(t *testing.T) (*Manager, *fakeRPC, string) {
	f := newFake()
	m, home := fixtureTransport(t, f)
	return m, f, home
}
func fixtureTransport(t *testing.T, tr Transport) (*Manager, string) {
	t.Helper()
	root := t.TempDir()
	workspace := filepath.Join(root, "synthetic-project")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(root, "steward.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	c := core.New(st, gitx.NewLocator())
	home := filepath.Join(root, "state")
	m, err := New(context.Background(), c, func(context.Context) (Transport, error) { return tr, nil }, home, workspace, "synthetic-host", "Synthetic Mac Studio")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close(); st.Close() })
	return m, home
}
func start(t *testing.T, m *Manager) (State, int) {
	t.Helper()
	s, err := m.Acquire("controller-one")
	if err != nil {
		t.Fatal(err)
	}
	s, err = m.Start("controller-one", s.Epoch, "operation-one", "Synthetic local task", "PRIVATE-SYNTHETIC-PROMPT")
	if err != nil {
		t.Fatal(err)
	}
	return s, s.Epoch
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
func complete(f *fakeRPC, turn string) {
	f.emit("turn/completed", map[string]any{"threadId": "native-thread-synthetic", "turn": map[string]string{"id": turn, "status": "completed"}}, "")
}

func TestNativeIdentityExplicitDeliveryAndNoConversationStorage(t *testing.T) {
	m, f, home := fixture(t)
	s, epoch := start(t, m)
	if s.ThreadID != "native-thread-synthetic" || s.SessionID == 0 || s.WorkItem == "" {
		t.Fatalf("missing binding: %+v", s)
	}
	f.emit("item/agentMessage/delta", map[string]any{"threadId": s.ThreadID, "turnId": s.Turn, "delta": "PRIVATE-SYNTHETIC-REPLY"}, "")
	complete(f, s.Turn)
	eventually(t, func() bool { return m.Snapshot().Turn == "" })
	if got := m.Snapshot(); got.WorkStatus != "in_progress" {
		t.Fatalf("turn completion falsely delivered: %+v", got)
	}
	s, err := m.Start("controller-one", epoch, "operation-two", "", "continue this same thread")
	if err != nil {
		t.Fatal(err)
	}
	f.emit("item/tool/call", map[string]any{"threadId": s.ThreadID, "turnId": s.Turn, "callId": "delivery-call", "tool": "ss_deliver", "arguments": map[string]string{"summary": "Synthetic deliverable ready for user review"}}, "9")
	eventually(t, func() bool { return m.Snapshot().WorkStatus == "review" })
	if f.count("thread/start") != 1 {
		t.Fatal("continuation created another native thread")
	}
	complete(f, s.Turn)
	eventually(t, func() bool { return m.Snapshot().Turn == "" })
	b, err := os.ReadFile(filepath.Join(home, "native-session.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "PRIVATE-SYNTHETIC") {
		t.Fatal("conversation persisted")
	}
	var n int
	if err = m.Core.St.R().QueryRow(`SELECT count(*) FROM events WHERE body LIKE '%PRIVATE-SYNTHETIC%'`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("private body persisted: %d %v", n, err)
	}
	if got := m.Snapshot(); got.WorkStatus == "done" {
		t.Fatal("agent accepted work")
	}
}
func TestLeaseFencingIdempotentStartAndLateTurn(t *testing.T) {
	m, f, _ := fixture(t)
	s, epoch := start(t, m)
	if _, err := m.Acquire("controller-two"); !errors.Is(err, ErrLease) {
		t.Fatal("second writer admitted")
	}
	if _, err := m.Start("controller-one", epoch+1, "operation-bad", "", "duplicate"); !errors.Is(err, ErrLease) {
		t.Fatal("stale lease admitted")
	}
	if _, err := m.Start("controller-one", epoch, "operation-one", "", "repeat"); err != nil {
		t.Fatal(err)
	}
	if f.count("turn/start") != 1 {
		t.Fatal("repeated HTTP request executed twice")
	}
	if _, err := m.Start("controller-one", epoch, "operation-other", "", "second"); !errors.Is(err, ErrState) {
		t.Fatal("concurrent turn admitted")
	}
	complete(f, s.Turn)
	eventually(t, func() bool { return m.Snapshot().Turn == "" })
	second, err := m.Start("controller-one", epoch, "operation-next", "", "next")
	if err != nil {
		t.Fatal(err)
	}
	complete(f, s.Turn)
	time.Sleep(20 * time.Millisecond)
	if m.Snapshot().Turn != second.Turn {
		t.Fatal("late completion overwrote newer turn")
	}
}
func TestDisconnectDoesNotCancelAndResumeKeepsNativeID(t *testing.T) {
	m, f, home := fixture(t)
	lease, err := m.Acquire("controller-one")
	if err != nil {
		t.Fatal(err)
	}
	h := (&HTTP{Manager: m, Token: "native-token"}).Handler(http.NotFoundHandler())
	body, _ := json.Marshal(map[string]any{"client": "controller-one", "epoch": lease.Epoch, "operation": "disconnected-request", "title": "Synthetic local task", "prompt": "synthetic task"})
	ctx, cancel := context.WithCancel(context.Background())
	r := httptest.NewRequest("POST", "http://localhost/native/api/start", strings.NewReader(string(body))).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer native-token")
	r.Header.Set("X-Steward-Native", "1")
	cancel()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || f.count("turn/start") != 1 {
		t.Fatalf("accepted request tied to disconnected page: %d %s", w.Code, w.Body.String())
	}
	s := m.Snapshot()
	complete(f, s.Turn)
	eventually(t, func() bool { return m.Snapshot().Turn == "" })
	m.Close()
	f2 := newFake()
	m2, err := New(context.Background(), m.Core, func(context.Context) (Transport, error) { return f2, nil }, home, s.Workspace, "synthetic-host", "Synthetic Mac Studio")
	if err != nil {
		t.Fatal(err)
	}
	defer m2.Close()
	lease, err = m2.Acquire("controller-two")
	if err != nil {
		t.Fatal(err)
	}
	resumed, err := m2.Resume("controller-two", lease.Epoch)
	if err != nil {
		t.Fatal(err)
	}
	if resumed.ThreadID != s.ThreadID || resumed.WorkItem != s.WorkItem || f2.resumed != s.ThreadID || f2.count("thread/start") != 0 || f2.count("turn/start") != 0 {
		t.Fatal("resume reconstructed a new conversation or executed a task")
	}
}
func TestApprovalBindingLegacyPanelBlockedAndSingleUse(t *testing.T) {
	m, f, home := fixture(t)
	s, epoch := start(t, m)
	f.emit("item/commandExecution/requestApproval", map[string]any{"threadId": s.ThreadID, "turnId": s.Turn, "itemId": "command-one", "command": "PRIVATE-SYNTHETIC-COMMAND"}, "17")
	eventually(t, func() bool { return len(m.Snapshot().Pending) == 1 })
	pending := m.Snapshot().Pending[0]
	h := (&HTTP{Manager: m, Token: "synthetic-native-token"}).Handler((&server.Server{Core: m.Core, PanelToken: "synthetic-panel"}).Handler())
	for _, action := range []string{"decide", "dismiss"} {
		r := httptest.NewRequest("POST", "http://localhost/api/approvals/"+pending.ID+"/"+action, strings.NewReader(`{}`))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 409 {
			t.Fatalf("legacy panel %s bypassed native lease: %d", action, w.Code)
		}
		if len(m.Snapshot().Pending) != 1 {
			t.Fatalf("legacy panel %s consumed the native approval", action)
		}
	}
	if err := m.Decide("controller-one", epoch, pending.ID, "wrong", "allow"); err == nil {
		t.Fatal("wrong fingerprint accepted")
	}
	if err := m.Decide("controller-one", epoch, pending.ID, pending.Fingerprint, "allow"); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return len(m.Snapshot().Pending) == 0 })
	f.mu.Lock()
	reply := string(f.replies["17"])
	f.mu.Unlock()
	if !strings.Contains(reply, `"accept"`) {
		t.Fatalf("wrong native reply: %s", reply)
	}
	if err := m.Decide("controller-one", epoch, pending.ID, pending.Fingerprint, "allow"); err == nil {
		t.Fatal("old approval replayed")
	}
	b, _ := os.ReadFile(filepath.Join(home, "native-session.json"))
	if strings.Contains(string(b), "PRIVATE-SYNTHETIC") {
		t.Fatal("command persisted in runtime state")
	}
	var status string
	_ = m.Core.St.R().QueryRow(`SELECT status FROM approvals WHERE id=?`, pending.ID).Scan(&status)
	if status != "delivered" {
		t.Fatalf("decision receipt not separate: %s", status)
	}
}
func TestNativeHTTPKeepsRemoteReadOnlyAndRejectsScopeChanges(t *testing.T) {
	m, _, _ := fixture(t)
	base := (&server.Server{Core: m.Core, PanelToken: "local-panel", RemoteToken: "remote-panel", RemoteHosts: []string{"studio.test.ts.net"}}).Handler()
	h := (&HTTP{Manager: m, Token: "native-token", PanelToken: "local-panel", Hosts: []string{"studio.test.ts.net"}}).Handler(base)
	for _, tc := range []struct {
		name, method, path, host, token, origin, body string
		want                                          int
	}{
		{"no capability", "GET", "/native/api/state", "studio.test.ts.net", "", "", "", 401},
		{"wrong host", "GET", "/native/api/state", "evil.example", "native-token", "", "", 403},
		{"cross origin", "POST", "/native/api/acquire", "studio.test.ts.net", "native-token", "https://evil.example", `{"client":"controller-one"}`, 403},
		{"arbitrary cwd", "POST", "/native/api/start", "studio.test.ts.net", "native-token", "", `{"client":"controller-one","cwd":"/other-project"}`, 400},
		{"ordinary remote managed stays blocked", "POST", "/api/managed", "studio.test.ts.net", "", "", `{}`, 403},
		{"remote cannot bootstrap token", "POST", "/native/local-pair", "studio.test.ts.net", "native-token", "", `{}`, 403},
		{"native scope cannot approve work", "POST", "/native/api/accepted", "studio.test.ts.net", "native-token", "", `{}`, 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "http://"+tc.host+tc.path, strings.NewReader(tc.body))
			r.Header.Set("Authorization", "Bearer "+tc.token)
			r.Header.Set("X-Steward-Native", "1")
			r.Header.Set("X-Steward", "1")
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			r.AddCookie(&http.Cookie{Name: "steward_remote", Value: "remote-panel"})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.want {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestLocalPairRequiresPossessionAndNeverReturnsKey(t *testing.T) {
	m, _, _ := fixture(t)
	h := (&HTTP{Manager: m, Token: "native-secret", PanelToken: "local-panel"}).Handler(http.NotFoundHandler())
	for _, authorized := range []bool{false, true} {
		r := httptest.NewRequest("POST", "http://localhost/native/local-pair", strings.NewReader(`{}`))
		r.RemoteAddr = "127.0.0.1:12345"
		r.Header.Set("X-Steward-Native", "1")
		if authorized {
			r.Header.Set("Authorization", "Bearer native-secret")
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		want := 401
		if authorized {
			want = 200
		}
		if w.Code != want {
			t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), "native-secret") {
			t.Fatal("bootstrap returned capability")
		}
		if !authorized && len(w.Result().Cookies()) > 0 {
			t.Fatal("unauthenticated local caller got panel rights")
		}
	}
}

func TestHandledWorkCannotBeReopenedByNativeController(t *testing.T) {
	m, f, _ := fixture(t)
	s, epoch := start(t, m)
	complete(f, s.Turn)
	eventually(t, func() bool { return m.Snapshot().Turn == "" })
	done := "done"
	if err := m.Core.UpdateWorkItem(context.Background(), s.WorkItem, core.WorkItemPatch{Status: &done}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start("controller-one", epoch, "new-operation", "", "another request"); err == nil {
		t.Fatal("reopened handled work")
	}
	if f.count("turn/start") != 1 {
		t.Fatal("executed after user handling")
	}
}
func TestDesktopHandoffReleasesWriterWithoutNewThread(t *testing.T) {
	m, f, _ := fixture(t)
	s, epoch := start(t, m)
	if err := m.Handoff("controller-one", epoch); !errors.Is(err, ErrState) {
		t.Fatal("handed off active turn")
	}
	complete(f, s.Turn)
	eventually(t, func() bool { return m.Snapshot().Turn == "" })
	if err := m.Handoff("controller-one", epoch); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Acquire("controller-two"); err == nil {
		t.Fatal("mobile stole external desktop control")
	}
	if !m.Snapshot().DesktopHandoff || m.Snapshot().ThreadID != s.ThreadID {
		t.Fatal("identity changed on handoff")
	}
}

func TestInterruptIsBoundToCurrentTurnAndDoesNotDeliver(t *testing.T) {
	m, f, _ := fixture(t)
	s, epoch := start(t, m)
	if err := m.Interrupt("controller-other", epoch); !errors.Is(err, ErrLease) {
		t.Fatal("wrong controller interrupted run")
	}
	if err := m.Interrupt("controller-one", epoch); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	thread, turn := f.interruptedThread, f.interruptedTurn
	f.mu.Unlock()
	if thread != s.ThreadID || turn != s.Turn || f.count("turn/interrupt") != 1 {
		t.Fatal("interrupt targeted another native run")
	}
	f.emit("turn/completed", map[string]any{"threadId": s.ThreadID, "turn": map[string]string{"id": s.Turn, "status": "interrupted"}}, "")
	eventually(t, func() bool { return m.Snapshot().Status == "interrupted" })
	if m.Snapshot().WorkStatus != "in_progress" {
		t.Fatal("interrupt falsely delivered or accepted work")
	}
}

// The gate models a slow native reply, without holding the fake's own mutex.
type gatedRPC struct {
	*fakeRPC
	method  string
	entered chan struct{}
	release chan struct{}
	once    sync.Once
	fail    error
}

func gate(method string) *gatedRPC {
	return &gatedRPC{fakeRPC: newFake(), method: method, entered: make(chan struct{}), release: make(chan struct{})}
}
func (g *gatedRPC) Call(ctx context.Context, method string, p, out any) error {
	if method == g.method {
		g.once.Do(func() { close(g.entered) })
		select {
		case <-g.release:
			if g.fail != nil {
				return g.fail
			}
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return g.fakeRPC.Call(ctx, method, p, out)
}
func releaseGate(g *gatedRPC) {
	select {
	case <-g.release:
	default:
		close(g.release)
	}
}
func awaitGate(t *testing.T, g *gatedRPC) {
	t.Helper()
	select {
	case <-g.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("native request did not enter its gate")
	}
}
func snapshotWhileRPCWaits(t *testing.T, m *Manager) State {
	t.Helper()
	done := make(chan State, 1)
	go func() { done <- m.Snapshot() }()
	select {
	case s := <-done:
		return s
	case <-time.After(time.Second):
		t.Fatal("state read blocked behind native RPC")
		return State{}
	}
}

func TestNativeRPCDoesNotBlockSnapshotOrEventDrain(t *testing.T) {
	for _, method := range []string{"initialize", "thread/start", "turn/start", "thread/resume"} {
		t.Run(method, func(t *testing.T) {
			g := gate(method)
			m, _ := fixtureTransport(t, g)
			defer releaseGate(g)
			if method == "thread/resume" {
				m.mu.Lock()
				m.s.ThreadID, m.s.Status = "native-thread-synthetic", "needs_reconcile"
				m.mu.Unlock()
			}
			lease, err := m.Acquire("controller-one")
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				if method == "thread/resume" {
					_, err := m.Resume("controller-one", lease.Epoch)
					done <- err
				} else {
					_, err := m.Start("controller-one", lease.Epoch, "operation-one", "Synthetic task", "synthetic prompt")
					done <- err
				}
			}()
			awaitGate(t, g)
			s := snapshotWhileRPCWaits(t, m)
			if s.Status != "starting" {
				t.Fatalf("request was not recorded before RPC: %+v", s)
			}
			if method != "thread/resume" {
				if s.Operations["operation-one"] != "requested" {
					t.Fatal("operation not reserved before native I/O")
				}
				if _, err := m.Start("controller-one", lease.Epoch, "operation-one", "", "repeat"); err != nil {
					t.Fatal(err)
				}
			}
			if err := m.Handoff("controller-one", lease.Epoch); !errors.Is(err, ErrState) {
				t.Fatal("handoff admitted while request unresolved")
			}
			// More than the real transport's 256 event slots must drain even
			// before the thread or turn RPC has returned.
			drained := make(chan struct{})
			go func() {
				for i := 0; i < 600; i++ {
					g.emit("item/agentMessage/delta", map[string]string{"threadId": "synthetic-unbound", "turnId": "synthetic-unbound"}, "")
				}
				close(drained)
			}()
			select {
			case <-drained:
			case <-time.After(2 * time.Second):
				t.Fatal("native event buffer blocked the RPC reader")
			}
			releaseGate(g)
			if err := <-done; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestNativeRPCResultCannotWriteIntoSuccessorLease(t *testing.T) {
	for _, method := range []string{"thread/start", "turn/start", "thread/resume"} {
		t.Run(method, func(t *testing.T) {
			g := gate(method)
			m, _ := fixtureTransport(t, g)
			defer releaseGate(g)
			now := time.Now()
			m.now = func() time.Time { return now }
			if method == "thread/resume" {
				m.s.ThreadID, m.s.Status = "native-thread-synthetic", "needs_reconcile"
			}
			lease, err := m.Acquire("controller-one")
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() {
				if method == "thread/resume" {
					_, err := m.Resume("controller-one", lease.Epoch)
					done <- err
				} else {
					_, err := m.Start("controller-one", lease.Epoch, "operation-one", "Synthetic task", "synthetic prompt")
					done <- err
				}
			}()
			awaitGate(t, g)
			m.mu.Lock()
			now = now.Add(2 * time.Minute)
			m.mu.Unlock()
			next, err := m.Acquire("controller-two")
			if err != nil {
				t.Fatal(err)
			}
			if next.Epoch == lease.Epoch || next.Status != "uncertain" {
				t.Fatal("unresolved previous request was hidden by takeover")
			}
			before := m.Snapshot()
			releaseGate(g)
			if err := <-done; !errors.Is(err, ErrLease) {
				t.Fatalf("stale response admitted: %v", err)
			}
			if after := m.Snapshot(); !reflect.DeepEqual(before, after) {
				t.Fatalf("stale response changed new lease\nbefore: %+v\nafter: %+v", before, after)
			}
			if _, err := m.Start("controller-two", next.Epoch, "operation-next", "", "must reconcile"); !errors.Is(err, ErrState) {
				t.Fatal("unresolved execution was retried")
			}
		})
	}
}

func TestEarlyNativeEventsAndApprovalProgressBeforeStartReply(t *testing.T) {
	g := gate("turn/start")
	m, _ := fixtureTransport(t, g)
	defer releaseGate(g)
	lease, err := m.Acquire("controller-one")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := m.Start("controller-one", lease.Epoch, "operation-one", "Synthetic task", "synthetic prompt")
		done <- err
	}()
	awaitGate(t, g)
	g.emit("turn/started", map[string]any{"threadId": "native-thread-synthetic", "turn": map[string]string{"id": "turn-1", "status": "inProgress"}}, "")
	g.emit("item/commandExecution/requestApproval", map[string]string{"threadId": "native-thread-synthetic", "turnId": "turn-1", "itemId": "early-command", "command": "synthetic command"}, "81")
	eventually(t, func() bool { return len(m.Snapshot().Pending) == 1 })
	pending := m.Snapshot().Pending[0]
	if err := m.Decide("controller-one", lease.Epoch, pending.ID, pending.Fingerprint, "deny"); err != nil {
		t.Fatal(err)
	}
	eventually(t, func() bool { return len(m.Snapshot().Pending) == 0 })
	g.emit("item/tool/call", map[string]any{"threadId": "native-thread-synthetic", "turnId": "turn-1", "callId": "early-delivery", "tool": "ss_deliver", "arguments": map[string]string{"summary": "Synthetic delivery before native start response"}}, "82")
	complete(g.fakeRPC, "turn-1")
	eventually(t, func() bool { s := m.Snapshot(); return s.Turn == "" && s.WorkStatus == "review" })
	releaseGate(g)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	s := m.Snapshot()
	if s.Turn != "" || s.Status != "idle" || s.WorkStatus != "review" || !s.Finished["turn-1"] {
		t.Fatalf("late start response resurrected completed turn: %+v", s)
	}
	if g.count("turn/start") != 1 {
		t.Fatal("native start was repeated")
	}
}

func TestUncertainNativeRequestIsNotAutomaticallyRetried(t *testing.T) {
	g := gate("turn/start")
	g.fail = context.DeadlineExceeded
	m, _ := fixtureTransport(t, g)
	defer releaseGate(g)
	lease, err := m.Acquire("controller-one")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := m.Start("controller-one", lease.Epoch, "operation-one", "Synthetic task", "synthetic prompt")
		done <- err
	}()
	awaitGate(t, g)
	releaseGate(g)
	if err := <-done; err == nil {
		t.Fatal("ambiguous native result reported success")
	}
	if m.Snapshot().Status != "uncertain" {
		t.Fatal("ambiguous native result not exposed")
	}
	if _, err := m.Start("controller-one", lease.Epoch, "operation-one", "", "duplicate"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start("controller-one", lease.Epoch, "operation-next", "", "retry"); !errors.Is(err, ErrState) {
		t.Fatal("unknown execution automatically retried")
	}
}

func TestNativeHTTPRejectsEmptyHostEvenWithLegacyEmptyAllowlist(t *testing.T) {
	m, _, _ := fixture(t)
	for _, hosts := range [][]string{nil, {""}} {
		h := (&HTTP{Manager: m, Token: "synthetic-token", Hosts: hosts}).Handler(http.NotFoundHandler())
		r := httptest.NewRequest("GET", "/native/api/state", nil)
		r.Host = ""
		r.Header.Set("Authorization", "Bearer synthetic-token")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("empty Host admitted: %d", w.Code)
		}
	}
}

func TestEarlyApprovalReadyAndCleanupCannotCrossLeaseEpoch(t *testing.T) {
	g := gate("turn/start")
	m, _ := fixtureTransport(t, g)
	defer releaseGate(g)
	now := time.Now()
	m.now = func() time.Time { return now }
	lease, err := m.Acquire("controller-one")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := m.Start("controller-one", lease.Epoch, "operation-one", "Synthetic task", "synthetic prompt")
		done <- err
	}()
	awaitGate(t, g)
	g.emit("turn/started", map[string]any{"threadId": "native-thread-synthetic", "turn": map[string]string{"id": "turn-1"}}, "")
	eventually(t, func() bool { return m.Snapshot().Turn == "turn-1" })

	// Keep ready outside mu until Core has committed the old epoch's approval.
	// Take over through the same locked Acquire path before allowing ready to run.
	m.mu.Lock()
	msg := Message{ID: json.RawMessage("91"), Method: "item/commandExecution/requestApproval", Params: json.RawMessage(`{"threadId":"native-thread-synthetic","turnId":"turn-1","itemId":"late-ready","command":"synthetic command"}`)}
	m.approval(g, msg, "turn-1", "late-ready", "synthetic command", "")
	var oldID, fp string
	until := time.Now().Add(3 * time.Second)
	for time.Now().Before(until) {
		err = m.Core.St.R().QueryRow(`SELECT id,fingerprint FROM approvals WHERE tool_name='NativeCodexControl' AND handleable=1`).Scan(&oldID, &fp)
		if err == nil {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if oldID == "" {
		m.mu.Unlock()
		t.Fatal("synthetic approval did not commit")
	}
	now = now.Add(2 * time.Minute)
	next, err := m.acquireLocked("controller-two")
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	before := m.Snapshot()
	eventually(t, func() bool { g.mu.Lock(); defer g.mu.Unlock(); return len(g.replies["91"]) > 0 })
	g.mu.Lock()
	reply := string(g.replies["91"])
	g.mu.Unlock()
	if !strings.Contains(reply, `"cancel"`) || strings.Contains(reply, `"accept"`) {
		t.Fatalf("old approval granted: %s", reply)
	}
	if len(m.Snapshot().Pending) != 0 {
		t.Fatal("old ready callback published a new-lease approval")
	}
	if err := m.Decide("controller-two", next.Epoch, oldID, fp, "allow"); !errors.Is(err, ErrState) {
		t.Fatal("new lease could accept old request")
	}
	if after := m.Snapshot(); !reflect.DeepEqual(before, after) {
		t.Fatalf("old approval cleanup changed new-lease state\nbefore:%+v\nafter:%+v", before, after)
	}
	releaseGate(g)
	if err := <-done; !errors.Is(err, ErrLease) {
		t.Fatal("old start response admitted")
	}
}

func TestOldReaderDisconnectDoesNotRewriteSuccessorLease(t *testing.T) {
	g := gate("turn/start")
	m, _ := fixtureTransport(t, g)
	defer releaseGate(g)
	now := time.Now()
	m.now = func() time.Time { return now }
	lease, err := m.Acquire("controller-one")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := m.Start("controller-one", lease.Epoch, "operation-one", "Synthetic task", "synthetic prompt")
		done <- err
	}()
	awaitGate(t, g)
	m.mu.Lock()
	now = now.Add(2 * time.Minute)
	m.mu.Unlock()
	if _, err = m.Acquire("controller-two"); err != nil {
		t.Fatal(err)
	}
	before := m.Snapshot()
	_ = g.Close()
	eventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.transport == nil })
	if after := m.Snapshot(); !reflect.DeepEqual(before, after) {
		t.Fatalf("old reader rewrote new lease\nbefore:%+v\nafter:%+v", before, after)
	}
	releaseGate(g)
	if err := <-done; !errors.Is(err, ErrLease) {
		t.Fatal("old native response admitted")
	}
}
