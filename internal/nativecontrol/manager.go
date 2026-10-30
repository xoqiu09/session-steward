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
type Manager struct {
	mu             sync.Mutex // Serializes controller writes and ordered native observations.
	ctx            context.Context
	cancel         context.CancelFunc
	Core           *core.Core
	Factory        Factory
	transport      Transport
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
func (m *Manager) connect(resume bool) error {
	tr, err := m.Factory(m.ctx)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
	defer cancel()
	if err = tr.Call(ctx, "initialize", map[string]any{"clientInfo": map[string]string{"name": "session_steward_native_prototype", "version": "0.1.0"}, "capabilities": map[string]any{"experimentalApi": true}}, nil); err != nil {
		tr.Close()
		return err
	}
	if err = tr.Notify("initialized", map[string]any{}); err != nil {
		tr.Close()
		return err
	}
	params := map[string]any{"cwd": m.s.Workspace, "approvalPolicy": "on-request", "sandbox": "workspace-write"}
	method := "thread/start"
	if resume {
		method = "thread/resume"
		params["threadId"] = m.s.ThreadID
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
		tr.Close()
		return err
	}
	if result.Thread.ID == "" || (resume && result.Thread.ID != m.s.ThreadID) {
		tr.Close()
		return errors.New("native thread identity mismatch")
	}
	m.s.ThreadID = result.Thread.ID
	m.transport = tr
	m.wg.Add(1)
	go func() { defer m.wg.Done(); m.read(tr) }()
	return nil
}
func (m *Manager) Start(client string, epoch int, operation, title, prompt string) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.lease(client, epoch); err != nil {
		return State{}, err
	}
	if !keyPattern.MatchString(operation) || len(prompt) == 0 || len(prompt) > 16000 {
		return State{}, errors.New("invalid operation or task")
	}
	if _, ok := m.s.Operations[operation]; ok {
		return m.snapshot(), nil
	}
	if m.s.WorkItem != "" {
		var status string
		if err := m.Core.St.R().QueryRow(`SELECT status FROM work_items WHERE id=?`, m.s.WorkItem).Scan(&status); err != nil {
			return State{}, err
		}
		if status == "done" || status == "abandoned" {
			return State{}, errors.New("此工作已处理或放弃；原型不会自动重新打开，请另建隔离任务")
		}
	}
	if m.s.Status == "needs_reconcile" || m.s.Turn != "" || m.s.Status == "uncertain" {
		return State{}, ErrState
	}
	if len(m.s.Operations) >= 100 {
		return State{}, errors.New("prototype operation limit reached")
	}
	if m.transport == nil {
		if m.s.ThreadID == "" {
			title = strings.TrimSpace(title)
			if title == "" || len([]rune(title)) > 200 {
				return State{}, errors.New("task title required")
			}
			m.s.Title = title
		}
		if err := m.connect(m.s.ThreadID != ""); err != nil {
			return State{}, err
		}
		if err := m.save(); err != nil {
			return State{}, err
		}
	}
	if m.s.WorkItem == "" {
		r, err := m.ingest(event.KindBegin, "begin", "")
		if err != nil {
			return State{}, err
		}
		m.s.WorkItem = r.WorkItemID
		m.s.SessionID = r.SessionID
		if m.s.WorkItem == "" {
			item, err := m.Core.SessionItemAt(m.ctx, m.hostID, "codex", m.s.ThreadID, m.now())
			if err != nil {
				return State{}, err
			}
			m.s.WorkItem = item
		}
	} else if _, err := m.ingest(event.KindClaim, "claim:"+operation, ""); err != nil {
		return State{}, err
	}
	m.s.Operations[operation] = "requested"
	m.s.Status = "starting"
	m.audit("turn_requested", "")
	if err := m.save(); err != nil {
		return State{}, err
	}
	ctx, cancel := context.WithTimeout(m.ctx, 30*time.Second)
	defer cancel()
	var result struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	err := m.transport.Call(ctx, "turn/start", map[string]any{"threadId": m.s.ThreadID, "clientUserMessageId": operation, "input": []any{map[string]any{"type": "text", "text": prompt}}, "approvalPolicy": "on-request", "sandboxPolicy": map[string]any{"type": "workspaceWrite", "writableRoots": []string{m.s.Workspace}, "networkAccess": false, "excludeSlashTmp": true, "excludeTmpdirEnvVar": true}}, &result)
	if err != nil || result.Turn.ID == "" {
		m.s.Status = "uncertain"
		m.s.LastError = "请求是否已执行尚待核对；不会自动重发"
		_ = m.save()
		return m.snapshot(), errors.New(m.s.LastError)
	}
	m.s.Turn = result.Turn.ID
	m.s.Operations[operation] = result.Turn.ID
	m.s.Status = "running"
	_, err = m.ingest(event.KindPrompt, "prompt:"+result.Turn.ID, "")
	if err == nil {
		err = m.save()
	}
	if err != nil {
		return State{}, err
	}
	return m.snapshot(), nil
}
func (m *Manager) Resume(client string, epoch int) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.lease(client, epoch); err != nil {
		return State{}, err
	}
	if m.transport != nil || m.s.ThreadID == "" || m.s.Turn != "" {
		return State{}, ErrState
	}
	if err := m.connect(true); err != nil {
		return State{}, err
	}
	m.s.Status = "idle"
	m.audit("native_thread_resumed", "")
	if err := m.save(); err != nil {
		return State{}, err
	}
	return m.snapshot(), nil
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
	if m.s.ThreadID == "" || len(m.approvals) > 0 || (m.s.Turn != "" && m.s.Status != "needs_reconcile") || m.s.Status == "uncertain" {
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
	return m.ownedApprovals[id]
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
		m.s.Status = "needs_reconcile"
		m.s.LastError = "原生连接已断开，请在电脑核对；未自动重新执行"
		m.transport = nil
		_ = m.save()
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
			if m.closed || m.s.Turn != turn || m.transport != tr {
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
