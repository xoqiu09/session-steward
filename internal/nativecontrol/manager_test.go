package nativecontrol

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
	f := newFake()
	home := filepath.Join(root, "state")
	m, err := New(context.Background(), c, func(context.Context) (Transport, error) { return f, nil }, home, workspace, "synthetic-host", "Synthetic Mac Studio")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.Close(); st.Close() })
	return m, f, home
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
	r := httptest.NewRequest("POST", "http://localhost/api/approvals/"+pending.ID+"/decide", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 409 {
		t.Fatalf("legacy panel bypassed native lease: %d", w.Code)
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
