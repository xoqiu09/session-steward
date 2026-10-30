package nativecontrol

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
)

var ErrLease = errors.New("控制权已变化，请先重新接管")
var ErrState = errors.New("当前运行状态不允许此操作")
var keyPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{8,80}$`)

type Audit struct {
	Seq  int    `json:"seq"`
	Kind string `json:"kind"`
	At   string `json:"at"`
	Turn string `json:"turn,omitempty"`
}
type Pending struct {
	ID          string `json:"id"`
	Fingerprint string `json:"fingerprint"`
	Kind        string `json:"kind"`
	Details     string `json:"details"`
	Turn        string `json:"turn"`
	Approvable  bool   `json:"approvable"`
}
type State struct {
	Host            string            `json:"host"`
	Workspace       string            `json:"workspace"`
	Title           string            `json:"title"`
	ThreadID        string            `json:"thread_id"`
	WorkItem        string            `json:"work_item_id"`
	SessionID       int64             `json:"session_id"`
	Turn            string            `json:"turn_id"`
	Status          string            `json:"status"`
	WorkStatus      string            `json:"work_status"`
	DeliverySummary string            `json:"delivery_summary,omitempty"`
	Owner           string            `json:"owner"`
	Epoch           int               `json:"epoch"`
	LeaseUntil      time.Time         `json:"lease_until"`
	DesktopHandoff  bool              `json:"desktop_handoff"`
	LastError       string            `json:"last_error,omitempty"`
	Operations      map[string]string `json:"operations"`
	Finished        map[string]bool   `json:"finished"`
	Events          []Audit           `json:"events"`
	Pending         []*Pending        `json:"pending"`
}

// Only one native request may be in flight. Its identity is checked again after
// every unlocked RPC; a response from an older lease cannot update its successor.
type nativeRequest struct {
	client, operation, turn string
	epoch                   int
	startingTurn            bool
	transport               Transport
}
type Manager struct {
	mu             sync.Mutex // Serializes controller writes and ordered native observations.
	ctx            context.Context
	cancel         context.CancelFunc
	Core           *core.Core
	Factory        Factory
	transport      Transport
	inflight       *nativeRequest
	file           string
	hostID         string
	now            func() time.Time
	s              State
	approvals      map[string]context.CancelFunc
	ownedApprovals map[string]bool
	closed         bool
	wg             sync.WaitGroup
}

func New(ctx context.Context, c *core.Core, factory Factory, home, workspace, hostID, hostName string) (*Manager, error) {
	workspace, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return nil, err
	}
	fi, err := os.Stat(workspace)
	if err != nil || !fi.IsDir() {
		return nil, errors.New("workspace must be a directory")
	}
	if err = os.MkdirAll(home, 0700); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	m := &Manager{ctx: ctx, cancel: cancel, Core: c, Factory: factory, file: filepath.Join(home, "native-session.json"), hostID: hostID, now: time.Now, approvals: map[string]context.CancelFunc{}, ownedApprovals: map[string]bool{}}
	m.s = State{Host: hostName, Workspace: workspace, Status: "ready", Operations: map[string]string{}, Finished: map[string]bool{}, Events: []Audit{}, Pending: []*Pending{}}
	if b, e := os.ReadFile(m.file); e == nil {
		if err = json.Unmarshal(b, &m.s); err != nil {
			cancel()
			return nil, err
		}
		if m.s.Workspace != workspace || m.s.Host != hostName {
			cancel()
			return nil, errors.New("saved native identity differs")
		}
		m.s.Owner = ""
		m.s.Epoch++
		m.s.Pending = nil
		if !m.s.DesktopHandoff && m.s.ThreadID != "" {
			m.s.Status = "needs_reconcile"
		}
	} else if !os.IsNotExist(e) {
		cancel()
		return nil, e
	}
	if m.s.Operations == nil {
		m.s.Operations = map[string]string{}
	}
	if m.s.Finished == nil {
		m.s.Finished = map[string]bool{}
	}
	return m, nil
}
func randomKey() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
func WriteSecret(path string) (string, error) {
	key := randomKey()
	f, err := os.CreateTemp(filepath.Dir(path), ".native-key-")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.WriteString(key)
	}
	if err == nil {
		err = f.Sync()
	}
	e := f.Close()
	if err == nil {
		err = e
	}
	if err != nil {
		return "", err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return "", err
	}
	return key, nil
}
func (m *Manager) save() error {
	// Commands, prompts and streamed native conversation are never persisted here.
	s := m.s
	s.Pending = nil
	s.WorkStatus = ""
	s.DeliverySummary = ""
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(m.file), ".native-state-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	e := f.Close()
	if err == nil {
		err = e
	}
	if err != nil {
		return err
	}
	return os.Rename(name, m.file)
}
func (m *Manager) audit(kind, turn string) {
	seq := 1
	if n := len(m.s.Events); n > 0 {
		seq = m.s.Events[n-1].Seq + 1
	}
	m.s.Events = append(m.s.Events, Audit{seq, kind, m.now().UTC().Format(time.RFC3339Nano), turn})
	if len(m.s.Events) > 400 {
		m.s.Events = m.s.Events[len(m.s.Events)-400:]
	}
}
func (m *Manager) snapshot() State {
	b, _ := json.Marshal(m.s)
	var s State
	_ = json.Unmarshal(b, &s)
	if s.WorkItem != "" {
		_ = m.Core.St.R().QueryRow(`SELECT status FROM work_items WHERE id=?`, s.WorkItem).Scan(&s.WorkStatus)
		_ = m.Core.St.R().QueryRow(`SELECT text FROM brief_entries WHERE work_item_id=? AND source='deliver' AND field='summary' ORDER BY id DESC LIMIT 1`, s.WorkItem).Scan(&s.DeliverySummary)
	}
	return s
}
func (m *Manager) Snapshot() State { m.mu.Lock(); defer m.mu.Unlock(); return m.snapshot() }
func (m *Manager) Acquire(client string) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.acquireLocked(client)
}
func (m *Manager) acquireLocked(client string) (State, error) {
	if !keyPattern.MatchString(client) || m.closed {
		return State{}, ErrLease
	}
	if m.s.DesktopHandoff {
		return State{}, errors.New("已交给电脑；此原型不从手机抢回原生桌面会话")
	}
	if m.s.Owner != "" && m.s.Owner != client && m.now().Before(m.s.LeaseUntil) {
		return State{}, ErrLease
	}
	if m.s.Owner != client || !m.now().Before(m.s.LeaseUntil) {
		m.s.Epoch++
		for _, cancel := range m.approvals {
			cancel()
		}
		m.s.Pending = nil
		if m.inflight != nil {
			m.s.Status = "uncertain"
			m.s.LastError = "控制权已变化，原请求的执行结果待核对；不会自动重发"
			m.audit("native_request_fenced", m.s.Turn)
		}
	}
	m.s.Owner = client
	m.s.LeaseUntil = m.now().Add(90 * time.Second)
	m.audit("control_acquired", m.s.Turn)
	if err := m.save(); err != nil {
		return State{}, err
	}
	return m.snapshot(), nil
}
func (m *Manager) lease(client string, epoch int) error {
	if m.closed || m.s.DesktopHandoff || client != m.s.Owner || epoch != m.s.Epoch || !m.now().Before(m.s.LeaseUntil) {
		return ErrLease
	}
	m.s.LeaseUntil = m.now().Add(90 * time.Second)
	return nil
}
func (m *Manager) ingest(kind event.Kind, id string, text string, toolIDs ...string) (core.IngestResult, error) {
	e := &event.Event{EventID: "native:" + m.s.ThreadID + ":" + id, SchemaVersion: 1, OccurredAt: m.now().UTC(), Source: event.Source{Provider: "codex", Client: "cli", Originator: "codex_cli", HostID: m.hostID}, SessionID: m.s.ThreadID, Cwd: m.s.Workspace, Kind: kind, RawName: "CodexAppServer", Text: text, WorkTag: m.s.WorkItem}
	if kind == event.KindBegin {
		e.WorkTitle = m.s.Title
		e.ProjectPath = m.s.Workspace
	}
	if len(toolIDs) > 0 {
		e.ToolUseID = toolIDs[0]
		e.ToolName = "commandExecution"
	}
	return m.Core.Ingest(m.ctx, e)
}
func (m *Manager) requestCurrent(r *nativeRequest) bool {
	if m.closed || m.inflight != r || m.s.Epoch != r.epoch || m.s.Owner != r.client {
		return false
	}
	if r.operation != "" {
		_, ok := m.s.Operations[r.operation]
		return ok
	}
	return true
}

// No native I/O is performed while mu is held. Start draining events as soon as
// the transport exists, including during initialize and thread/start or resume.
func (m *Manager) connect(r *nativeRequest, threadID, workspace string) (Transport, string, error) {
	tr, err := m.Factory(m.ctx)
	if err != nil {
		return nil, "", err
	}
	m.mu.Lock()
	if !m.requestCurrent(r) {
		m.mu.Unlock()
		_ = tr.Close()
		return nil, "", ErrLease
	}
	m.transport, r.transport = tr, tr
	m.wg.Add(1)
	go func() { defer m.wg.Done(); m.read(tr) }()
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
	defer cancel()
	if err = tr.Call(ctx, "initialize", map[string]any{"clientInfo": map[string]string{"name": "session_steward_native_prototype", "version": "0.1.0"}, "capabilities": map[string]any{"experimentalApi": true}}, nil); err != nil {
		return tr, "", err
	}
	if err = tr.Notify("initialized", map[string]any{}); err != nil {
		return tr, "", err
	}
	params := map[string]any{"cwd": workspace, "approvalPolicy": "on-request", "sandbox": "workspace-write"}
	method := "thread/start"
	if threadID != "" {
		method = "thread/resume"
		params["threadId"] = threadID
		params["excludeTurns"] = true
	} else {
		params["developerInstructions"] = "This is a local Session Steward prototype. Work only in the configured workspace. Do not use cloud workspaces. When you intentionally deliver your work, call ss_deliver with a concise summary; this records agent delivery for user review, never user acceptance. Do not call it when interrupted or merely waiting."
		params["dynamicTools"] = []any{map[string]any{"type": "function", "name": "ss_deliver", "description": "Explicitly report your work as delivered for the user's review, never accepted.", "inputSchema": map[string]any{"type": "object", "properties": map[string]any{"summary": map[string]any{"type": "string", "minLength": 1, "maxLength": 400}}, "required": []string{"summary"}, "additionalProperties": false}}}
	}
	var result struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err = tr.Call(ctx, method, params, &result); err != nil {
		return tr, "", err
	}
	if result.Thread.ID == "" || (threadID != "" && result.Thread.ID != threadID) {
		return tr, "", errors.New("native thread identity mismatch")
	}
	return tr, result.Thread.ID, nil
}

// Release only this request's transport. The public state of a newer lease is
// left unchanged, even when an older RPC eventually returns successfully.
func (m *Manager) failRequest(r *nativeRequest, tr Transport) (State, error) {
	m.mu.Lock()
	err := ErrLease
	if m.requestCurrent(r) {
		m.s.Status = "uncertain"
		m.s.LastError = "请求是否已执行尚待核对；不会自动重发"
		m.audit("native_request_uncertain", m.s.Turn)
		_ = m.save()
		err = errors.New(m.s.LastError)
	}
	if m.inflight == r {
		m.inflight = nil
	}
	if m.transport == tr {
		m.transport = nil
	}
	s := m.snapshot()
	m.mu.Unlock()
	if tr != nil {
		_ = tr.Close()
	}
	return s, err
}

// A native event can precede the turn/start response. Bind it once so that the
// reader and approval ready callback can make progress while that RPC waits.
func (m *Manager) bindRequestedTurn(r *nativeRequest, turn string) error {
	if r.turn != "" {
		if r.turn != turn {
			return errors.New("native turn identity mismatch")
		}
		return nil
	}
	r.turn, m.s.Turn = turn, turn
	m.s.Operations[r.operation] = turn
	m.s.Status = "running"
	if _, err := m.ingest(event.KindPrompt, "prompt:"+turn, ""); err != nil {
		return err
	}
	return m.save()
}

func (m *Manager) Start(client string, epoch int, operation, title, prompt string) (State, error) {
	m.mu.Lock()
	if err := m.lease(client, epoch); err != nil {
		m.mu.Unlock()
		return State{}, err
	}
	if !keyPattern.MatchString(operation) || len(prompt) == 0 || len(prompt) > 16000 {
		m.mu.Unlock()
		return State{}, errors.New("invalid operation or task")
	}
	if _, ok := m.s.Operations[operation]; ok {
		s := m.snapshot()
		m.mu.Unlock()
		return s, nil
	}
	if m.s.WorkItem != "" {
		var status string
		if err := m.Core.St.R().QueryRow(`SELECT status FROM work_items WHERE id=?`, m.s.WorkItem).Scan(&status); err != nil {
			m.mu.Unlock()
			return State{}, err
		}
		if status == "done" || status == "abandoned" {
			m.mu.Unlock()
			return State{}, errors.New("此工作已处理或放弃；原型不会自动重新打开，请另建隔离任务")
		}
	}
	if m.inflight != nil || m.s.Status == "needs_reconcile" || m.s.Turn != "" || m.s.Status == "uncertain" {
		m.mu.Unlock()
		return State{}, ErrState
	}
	if len(m.s.Operations) >= 100 {
		m.mu.Unlock()
		return State{}, errors.New("prototype operation limit reached")
	}
	if m.s.ThreadID == "" {
		title = strings.TrimSpace(title)
		if title == "" || len([]rune(title)) > 200 {
			m.mu.Unlock()
			return State{}, errors.New("task title required")
		}
		m.s.Title = title
	}
	r := &nativeRequest{client: client, epoch: epoch, operation: operation, transport: m.transport}
	m.s.Operations[operation] = "requested"
	m.s.Status, m.s.LastError = "starting", ""
	m.audit("turn_requested", "")
	if err := m.save(); err != nil {
		m.mu.Unlock()
		return State{}, err
	}
	m.inflight = r
	m.wg.Add(1)
	threadID, workspace := m.s.ThreadID, m.s.Workspace
	tr := m.transport
	m.mu.Unlock()
	defer m.wg.Done()

	if tr == nil {
		var err error
		tr, threadID, err = m.connect(r, threadID, workspace)
		if err != nil {
			return m.failRequest(r, tr)
		}
	}
	m.mu.Lock()
	if !m.requestCurrent(r) || m.transport != tr {
		m.mu.Unlock()
		return m.failRequest(r, tr)
	}
	m.s.ThreadID = threadID
	if m.s.WorkItem == "" {
		bound, err := m.ingest(event.KindBegin, "begin", "")
		if err != nil {
			m.mu.Unlock()
			return m.failRequest(r, tr)
		}
		m.s.WorkItem, m.s.SessionID = bound.WorkItemID, bound.SessionID
		if m.s.WorkItem == "" {
			item, err := m.Core.SessionItemAt(m.ctx, m.hostID, "codex", threadID, m.now())
			if err != nil {
				m.mu.Unlock()
				return m.failRequest(r, tr)
			}
			m.s.WorkItem = item
		}
	} else if _, err := m.ingest(event.KindClaim, "claim:"+operation, ""); err != nil {
		m.mu.Unlock()
		return m.failRequest(r, tr)
	}
	r.startingTurn = true
	if err := m.save(); err != nil {
		m.mu.Unlock()
		return m.failRequest(r, tr)
	}
	m.mu.Unlock()

	ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
	defer cancel()
	var result struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	err := tr.Call(ctx, "turn/start", map[string]any{"threadId": threadID, "clientUserMessageId": operation, "input": []any{map[string]any{"type": "text", "text": prompt}}, "approvalPolicy": "on-request", "sandboxPolicy": map[string]any{"type": "workspaceWrite", "writableRoots": []string{workspace}, "networkAccess": false, "excludeSlashTmp": true, "excludeTmpdirEnvVar": true}}, &result)
	if err != nil || result.Turn.ID == "" {
		return m.failRequest(r, tr)
	}
	m.mu.Lock()
	if !m.requestCurrent(r) || m.transport != tr {
		m.mu.Unlock()
		return m.failRequest(r, tr)
	}
	// If completion was already observed, binding is idempotent and must not
	// resurrect the finished turn when its start response finally arrives.
	if err := m.bindRequestedTurn(r, result.Turn.ID); err != nil {
		m.mu.Unlock()
		return m.failRequest(r, tr)
	}
	m.inflight = nil
	s := m.snapshot()
	m.mu.Unlock()
	return s, nil
}
func (m *Manager) Resume(client string, epoch int) (State, error) {
	m.mu.Lock()
	if err := m.lease(client, epoch); err != nil {
		m.mu.Unlock()
		return State{}, err
	}
	if m.inflight != nil || m.transport != nil || m.s.ThreadID == "" || m.s.Turn != "" {
		m.mu.Unlock()
		return State{}, ErrState
	}
	r := &nativeRequest{client: client, epoch: epoch}
	m.s.Status, m.s.LastError = "starting", ""
	m.audit("native_thread_resume_requested", "")
	if err := m.save(); err != nil {
		m.mu.Unlock()
		return State{}, err
	}
	m.inflight = r
	m.wg.Add(1)
	threadID, workspace := m.s.ThreadID, m.s.Workspace
	m.mu.Unlock()
	defer m.wg.Done()

	tr, _, err := m.connect(r, threadID, workspace)
	if err != nil {
		return m.failRequest(r, tr)
	}
	m.mu.Lock()
	if !m.requestCurrent(r) || m.transport != tr {
		m.mu.Unlock()
		return m.failRequest(r, tr)
	}
	m.s.Status = "idle"
	m.audit("native_thread_resumed", "")
	if err := m.save(); err != nil {
		m.mu.Unlock()
		return m.failRequest(r, tr)
	}
	m.inflight = nil
	s := m.snapshot()
	m.mu.Unlock()
	return s, nil
}
func (m *Manager) Interrupt(client string, epoch int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.lease(client, epoch); err != nil {
		return err
	}
	if m.s.Turn == "" || m.transport == nil {
		return ErrState
	}
	ctx, cancel := context.WithTimeout(m.ctx, 10*time.Second)
	defer cancel()
	if err := m.transport.Call(ctx, "turn/interrupt", map[string]string{"threadId": m.s.ThreadID, "turnId": m.s.Turn}, nil); err != nil {
		return err
	}
	m.audit("interrupt_requested", m.s.Turn)
	return m.save()
}
func (m *Manager) Handoff(client string, epoch int) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.lease(client, epoch); err != nil {
		return err
	}
	if m.inflight != nil || m.s.ThreadID == "" || len(m.approvals) > 0 || (m.s.Turn != "" && m.s.Status != "needs_reconcile") || m.s.Status == "uncertain" {
		return ErrState
	}
	m.s.DesktopHandoff = true
	m.s.Owner = ""
	m.s.Epoch++
	m.s.Status = "desktop"
	m.audit("desktop_handoff", "")
	if err := m.save(); err != nil {
		return err
	}
	if m.transport != nil {
		tr := m.transport
		m.transport = nil
		_ = tr.Close()
	}
	return nil
}
func (m *Manager) OwnsApproval(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ownedApprovals[id] {
		return true
	}
	// Core commits the approval before ready can publish its ID. The ordinary
	// panel must also reject that short interval and approvals left after restart.
	var n int
	err := m.Core.St.R().QueryRow(`SELECT count(*) FROM approvals WHERE id=? AND kind='permission' AND tool_name='NativeCodexControl'`, id).Scan(&n)
	return err != nil || n != 0
}
func (m *Manager) Decide(client string, epoch int, id, fp, decision string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.lease(client, epoch); err != nil {
		return err
	}
	if decision != "allow" && decision != "deny" {
		return errors.New("single-use allow/deny only")
	}
	for _, p := range m.s.Pending {
		if p.ID == id && p.Turn == m.s.Turn && p.Fingerprint == fp {
			if decision == "allow" && !p.Approvable {
				return ErrState
			}
			return m.Core.Decide(m.ctx, id, fp, core.Decision{Behavior: decision})
		}
	}
	return ErrState
}
func (m *Manager) read(tr Transport) {
	for msg := range tr.Events() {
		m.handle(tr, msg)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.transport == tr && !m.closed {
		fenced := m.inflight != nil && !m.requestCurrent(m.inflight)
		m.transport = nil
		if !fenced {
			m.s.Status = "needs_reconcile"
			m.s.LastError = "原生连接已断开，请在电脑核对；未自动重新执行"
			_ = m.save()
		}
	}
}
func (m *Manager) handle(tr Transport, msg Message) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.transport != tr {
		return
	}
	var p struct {
		ThreadID  string          `json:"threadId"`
		TurnID    string          `json:"turnId"`
		CallID    string          `json:"callId"`
		Tool      string          `json:"tool"`
		Arguments json.RawMessage `json:"arguments"`
		Command   string          `json:"command"`
		Reason    string          `json:"reason"`
		ItemID    string          `json:"itemId"`
		Turn      struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"turn"`
		Item struct {
			ID       string `json:"id"`
			Type     string `json:"type"`
			ExitCode *int   `json:"exitCode"`
		} `json:"item"`
	}
	if json.Unmarshal(msg.Params, &p) != nil {
		return
	}
	if p.TurnID == "" {
		p.TurnID = p.Turn.ID
	}
	if r := m.inflight; r != nil && r.transport == tr {
		if !m.requestCurrent(r) {
			if len(msg.ID) > 0 {
				_ = tr.Reply(msg.ID, map[string]any{"decision": "cancel", "contentItems": []any{}, "success": false})
			}
			return
		}
		if r.startingTurn && p.ThreadID == m.s.ThreadID && p.TurnID != "" && !m.s.Finished[p.TurnID] && m.s.Turn == "" {
			if err := m.bindRequestedTurn(r, p.TurnID); err != nil {
				m.s.Status = "uncertain"
				m.s.LastError = "原生运行观察未能记录，请在电脑核对；不会自动重发"
				_ = m.save()
				return
			}
		}
	}
	valid := p.ThreadID == m.s.ThreadID && p.TurnID != "" && p.TurnID == m.s.Turn && !m.s.Finished[p.TurnID]
	if len(msg.ID) > 0 {
		if !valid {
			_ = tr.Reply(msg.ID, map[string]any{"decision": "cancel", "contentItems": []any{}, "success": false})
			return
		}
		if msg.Method == "item/commandExecution/requestApproval" || msg.Method == "item/fileChange/requestApproval" {
			m.approval(tr, msg, p.TurnID, p.ItemID, p.Command, p.Reason)
			return
		}
		if msg.Method == "item/tool/call" && p.Tool == "ss_deliver" {
			var args struct {
				Summary string `json:"summary"`
			}
			err := json.Unmarshal(p.Arguments, &args)
			if err == nil && (strings.TrimSpace(args.Summary) == "" || len([]rune(args.Summary)) > 400) {
				err = errors.New("invalid summary")
			}
			if err == nil {
				_, err = m.ingest(event.KindDeliver, "delivery:"+p.CallID, args.Summary)
			}
			_ = tr.Reply(msg.ID, map[string]any{"success": err == nil, "contentItems": []any{map[string]string{"type": "inputText", "text": fmt.Sprintf("Delivery recorded for user review: %t. No user acceptance was written.", err == nil)}}})
			if err == nil {
				m.audit("agent_delivered", p.TurnID)
				_ = m.save()
			}
			return
		}
		_ = tr.Reject(msg.ID)
		m.audit("unsupported_native_request", p.TurnID)
		_ = m.save()
		return
	}
	if !valid {
		return
	}
	switch msg.Method {
	case "item/started", "item/completed":
		if p.Item.Type == "commandExecution" || p.Item.Type == "fileChange" {
			kind := event.KindToolPre
			if msg.Method == "item/completed" {
				kind = event.KindToolPost
				if p.Item.ExitCode != nil && *p.Item.ExitCode != 0 {
					kind = event.KindToolFail
				}
			}
			_, err := m.ingest(kind, p.TurnID+":"+p.Item.ID+":"+msg.Method, "", p.Item.ID)
			if err != nil {
				m.s.LastError = "观察写入失败"
			}
			m.audit(string(kind), p.TurnID)
			_ = m.save()
		}
	case "turn/completed":
		kind := event.KindStop
		m.s.Status = "idle"
		if p.Turn.Status == "failed" {
			kind = event.KindStopFailure
			m.s.Status = "failed"
		}
		if p.Turn.Status == "interrupted" {
			kind = event.KindInterrupt
			m.s.Status = "interrupted"
		}
		_, err := m.ingest(kind, "end:"+p.TurnID, "")
		if err != nil {
			m.s.LastError = "结束观察写入失败"
		}
		for _, cancel := range m.approvals {
			cancel()
		}
		m.s.Finished[p.TurnID] = true
		m.s.Turn = ""
		m.audit("turn_"+p.Turn.Status, p.TurnID)
		_ = m.save()
	}
}
func (m *Manager) approval(tr Transport, msg Message, turn, item, command, reason string) {
	key := string(msg.ID)
	if _, ok := m.approvals[key]; ok {
		return
	}
	ctx, cancel := context.WithCancel(m.ctx)
	epoch := m.s.Epoch
	m.approvals[key] = cancel
	fp := event.Fingerprint(msg.Method, msg.Params, m.s.Workspace)
	e := &event.Event{EventID: "native:" + m.s.ThreadID + ":approval:" + key, SchemaVersion: 1, OccurredAt: m.now().UTC(), Source: event.Source{Provider: "codex", Client: "cli", HostID: m.hostID}, SessionID: m.s.ThreadID, Cwd: m.s.Workspace, Kind: event.KindPermission, RawName: "CodexAppServer", ToolName: "NativeCodexControl", Fingerprint: fp, ToolUseID: item, Preview: "原生 Codex 请求；请在受限控制页查看内容后处理"}
	details := command
	if details == "" {
		details = reason
	}
	if details == "" {
		details = "文件修改请求：请回原生会话核对后决定"
	}
	if len(details) > 32000 {
		details = "操作内容过长，本原型不支持批准；请回原生会话处理"
	}
	approvable := msg.Method == "item/commandExecution/requestApproval" && command != "" && len(command) <= 32000
	m.wg.Add(1)
	go func() {
		defer m.wg.Done()
		id, d, ok, err := m.Core.RequestPermissionObserved(ctx, e, 3*time.Minute, func(id string) {
			m.mu.Lock()
			defer m.mu.Unlock()
			if m.closed || m.s.Epoch != epoch || m.s.Turn != turn || m.transport != tr {
				cancel()
				return
			}
			m.ownedApprovals[id] = true
			m.s.Pending = append(m.s.Pending, &Pending{id, fp, msg.Method, details, turn, approvable})
			m.audit("approval_requested", turn)
		})
		decision := "decline"
		if ok && err == nil && d.Behavior == "allow" {
			decision = "accept"
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		defer cancel()
		delete(m.approvals, key)
		if m.s.Epoch != epoch {
			// This request belonged to the previous controller. Its cancellation
			// cannot publish pending UI or audit entries into the new lease.
			_ = tr.Reply(msg.ID, map[string]string{"decision": "cancel"})
			return
		}
		if m.s.Turn != turn || m.transport != tr {
			decision = "cancel"
		}
		if tr.Reply(msg.ID, map[string]string{"decision": decision}) == nil && ok {
			_ = m.Core.AckDelivered(context.Background(), id)
		}
		pending := m.s.Pending[:0]
		for _, p := range m.s.Pending {
			if p.ID != id {
				pending = append(pending, p)
			}
		}
		m.s.Pending = pending
		m.audit("approval_"+decision, turn)
		_ = m.save()
	}()
}
func (m *Manager) Close() {
	m.mu.Lock()
	m.closed = true
	for _, cancel := range m.approvals {
		cancel()
	}
	m.cancel()
	if m.transport != nil {
		_ = m.transport.Close()
	}
	_ = m.save()
	m.mu.Unlock()
	m.wg.Wait()
}
