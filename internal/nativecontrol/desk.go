package nativecontrol

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
)

var ErrLease = errors.New("控制权已变化，请先重新接过来")
var ErrState = errors.New("当前运行状态不允许此操作")
var keyPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{8,80}$`)

// DesktopHandoffVerified 记录 K2 点验结果：官方桌面 App 能用 codex://threads/<会话号> 打开并接着写
// app-server 发起的会话（docs/dispatch/evidence/k2）。为 false 时页面不显示“回电脑接着做”按钮。
const DesktopHandoffVerified = true

const (
	leaseFor     = 90 * time.Second
	approvalWait = 30 * time.Minute
	maxOps       = 100
	// LocalDevice 是本机页面的设备名；K3 配对的设备用各自的名字。
	LocalDevice = "local"
	deskAuditID = "dispatch-desk"
)

type Pending struct {
	ID          string `json:"id"`
	Fingerprint string `json:"fingerprint"`
	Kind        string `json:"kind"`
	Details     string `json:"details"`
	Turn        string `json:"turn"`
	Approvable  bool   `json:"approvable"`
}

// TaskView 是一件任务给页面的样子。命令正文只在 Pending 里临时出现，不写库。
type TaskView struct {
	core.DispatchRow
	WorkStatus      string                   `json:"work_status"`
	DeliverySummary string                   `json:"delivery_summary,omitempty"`
	Desktop         bool                     `json:"desktop_handoff"`
	Pending         []*Pending               `json:"pending"`
	Events          []core.ManagedAuditEntry `json:"events,omitempty"`
}

type DeskView struct {
	Host           string                 `json:"host"`
	CodexVersion   string                 `json:"codex_version"`
	Owner          string                 `json:"owner"`
	Epoch          int                    `json:"epoch"`
	LeaseUntil     time.Time              `json:"lease_until"`
	HandoffEnabled bool                   `json:"desktop_handoff_enabled"`
	Projects       []core.DispatchProject `json:"projects"`
	Tasks          []TaskView             `json:"tasks"`
}

type Factory func(ctx context.Context, dir string) (Transport, error)

// Desk 是 Studio 上的派活台：一把控制租约管所有任务，每件任务各有自己的 Codex app-server 连接。
// 锁的顺序固定为 createMu → Task.mu → Desk.mu；持有 Desk.mu 时不取其他锁。
type Desk struct {
	mu           sync.Mutex
	createMu     sync.Mutex
	ctx          context.Context
	cancel       context.CancelFunc
	Core         *core.Core
	factory      Factory
	hostID, host string
	codexVersion string
	now          func() time.Time
	owner        string
	epoch        int
	until        time.Time
	tasks        map[string]*Task
	closed       bool
	wg           sync.WaitGroup
}

func NewDesk(ctx context.Context, c *core.Core, factory Factory, hostID, host, codexVersion string) (*Desk, error) {
	rows, err := c.DispatchRows(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	// epoch 从启动时间起算：服务重启后，旧页面手里的 epoch 一律失效。
	d := &Desk{ctx: ctx, cancel: cancel, Core: c, factory: factory, hostID: hostID, host: host, codexVersion: codexVersion, now: time.Now, epoch: int(time.Now().Unix()), tasks: map[string]*Task{}}
	for _, r := range rows {
		t := newTask(d, r)
		// 服务重启时连接都没了：正在执行的一轮结果不明，标出来等人核对，不自动重跑。
		if t.row.Status == "starting" || t.row.Status == "running" || t.row.Turn != "" {
			t.row.Status, t.row.Error = "needs_reconcile", "服务重启时这一轮还没结束，结果待核对；不会自动重跑"
			if err := t.save(); err != nil {
				cancel()
				return nil, err
			}
		}
		d.tasks[r.ID] = t
	}
	return d, nil
}

func (d *Desk) Close() {
	d.mu.Lock()
	d.closed = true
	tasks := d.taskList()
	d.mu.Unlock()
	d.cancel()
	for _, t := range tasks {
		t.close()
	}
	d.wg.Wait()
}

func (d *Desk) taskList() []*Task {
	out := make([]*Task, 0, len(d.tasks))
	for _, t := range d.tasks {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].created > out[j].created })
	return out
}

func (d *Desk) task(id string) (*Task, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	t := d.tasks[id]
	if t == nil {
		return nil, core.ErrNotFound
	}
	return t, nil
}

// Acquire 取得或续期控制租约。别人正在控制时要 force（页面上的“接过来”），旧的一方随即只能看。
// 控制权变化不取消等待中的审批：审批属于任务的这一轮，由当前控制者决定。
func (d *Desk) Acquire(client, device string, force bool) (DeskView, error) {
	if !keyPattern.MatchString(client) {
		return DeskView{}, ErrLease
	}
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return DeskView{}, ErrLease
	}
	now := d.now()
	held := d.owner != "" && d.owner != client && now.Before(d.until)
	if held && !force {
		d.mu.Unlock()
		return DeskView{}, fmt.Errorf("%w：另一个页面正在控制派活台", ErrLease)
	}
	changed := d.owner != client || !now.Before(d.until)
	if changed {
		d.epoch++
	}
	d.owner, d.until = client, now.Add(leaseFor)
	d.mu.Unlock()
	if changed {
		result := "ok"
		if held {
			result = "taken_over"
		}
		_ = d.Core.DispatchAudit(d.ctx, deskAuditID, "control_acquired", result, "panel", device)
	}
	return d.View(), nil
}

// lease 校验并续期写操作的租约。
func (d *Desk) lease(client string, epoch int) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.closed || client == "" || client != d.owner || epoch != d.epoch || !d.now().Before(d.until) {
		return ErrLease
	}
	d.until = d.now().Add(leaseFor)
	return nil
}

// current 判断一个已受理的请求是否仍属于当前控制者；不看是否过期，只看是否被别人接过去。
func (d *Desk) current(client string, epoch int) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return !d.closed && client == d.owner && epoch == d.epoch
}

func (d *Desk) isClosed() bool { d.mu.Lock(); defer d.mu.Unlock(); return d.closed }

func (d *Desk) View() DeskView {
	d.mu.Lock()
	v := DeskView{Host: d.host, CodexVersion: d.codexVersion, Owner: d.owner, Epoch: d.epoch, LeaseUntil: d.until, HandoffEnabled: DesktopHandoffVerified}
	tasks := d.taskList()
	d.mu.Unlock()
	v.Projects, _ = d.Core.DispatchProjects(d.ctx)
	if v.Projects == nil {
		v.Projects = []core.DispatchProject{}
	}
	v.Tasks = make([]TaskView, 0, len(tasks))
	for _, t := range tasks {
		v.Tasks = append(v.Tasks, t.view(false))
	}
	return v
}

func (d *Desk) Task(id string) (TaskView, error) {
	t, err := d.task(id)
	if err != nil {
		return TaskView{}, err
	}
	return t.view(true), nil
}

func validStart(op, prompt string) error {
	if !keyPattern.MatchString(op) || strings.TrimSpace(prompt) == "" || len(prompt) > 16000 {
		return fmt.Errorf("%w: 任务内容为空或过长", core.ErrBadRequest)
	}
	return nil
}

// Create 在授权项目里新建一件任务并开始第一轮。同一个 operation 重复提交只建一件、只执行一次。
func (d *Desk) Create(client string, epoch int, device, op string, repoID int64, title, prompt string) (TaskView, error) {
	if err := validStart(op, prompt); err != nil {
		return TaskView{}, err
	}
	d.createMu.Lock()
	if owner, err := d.Core.DispatchOpOwner(d.ctx, op); err != nil || owner != "" {
		d.createMu.Unlock()
		if err != nil {
			return TaskView{}, err
		}
		return d.Task(owner)
	}
	if err := d.lease(client, epoch); err != nil {
		d.createMu.Unlock()
		return TaskView{}, err
	}
	m, err := d.Core.LaunchDispatch(d.ctx, repoID, title, op)
	if err != nil {
		d.createMu.Unlock()
		_ = d.Core.DispatchAudit(d.ctx, deskAuditID, "create", "refused", "panel", device)
		return TaskView{}, err
	}
	var repoName string
	_ = d.Core.St.R().QueryRowContext(d.ctx, `SELECT name FROM repos WHERE id=?`, m.RepoID).Scan(&repoName)
	t := newTask(d, core.DispatchRow{ID: m.ID, RepoID: m.RepoID, RepoName: repoName, Title: m.Title, WorkItemID: m.WorkItemID, Worktree: m.Worktree, Branch: m.Branch, Status: "ready", CreatedAt: m.CreatedAt, Ops: map[string]string{op: ""}})
	d.mu.Lock()
	d.tasks[m.ID] = t
	d.mu.Unlock()
	d.createMu.Unlock()
	_ = d.Core.DispatchAudit(d.ctx, m.ID, "create", fmt.Sprintf("ok; task %d chars", len([]rune(prompt))), "panel", device)

	t.mu.Lock()
	return t.begin(&nativeRequest{client: client, epoch: epoch, op: op, transport: t.transport}, prompt)
}

func (d *Desk) Start(client string, epoch int, device, id, op, prompt string) (TaskView, error) {
	t, err := d.task(id)
	if err != nil {
		return TaskView{}, err
	}
	v, err := t.start(client, epoch, op, prompt)
	d.audit(id, "start", err, device, fmt.Sprintf("task %d chars", len([]rune(prompt))))
	return v, err
}

func (d *Desk) Resume(client string, epoch int, device, id string) (TaskView, error) {
	t, err := d.task(id)
	if err != nil {
		return TaskView{}, err
	}
	v, err := t.resume(client, epoch)
	d.audit(id, "resume", err, device, "")
	return v, err
}

func (d *Desk) Interrupt(client string, epoch int, device, id string) (TaskView, error) {
	t, err := d.task(id)
	if err != nil {
		return TaskView{}, err
	}
	err = t.interrupt(client, epoch)
	d.audit(id, "interrupt", err, device, "")
	return t.view(true), err
}

func (d *Desk) Handoff(client string, epoch int, device, id string) (TaskView, error) {
	t, err := d.task(id)
	if err != nil {
		return TaskView{}, err
	}
	err = t.handoff(client, epoch)
	d.audit(id, "desktop_handoff", err, device, "")
	return t.view(true), err
}

func (d *Desk) Decide(client string, epoch int, device, id, approval, fp, decision string) (TaskView, error) {
	t, err := d.task(id)
	if err != nil {
		return TaskView{}, err
	}
	err = t.decide(client, epoch, approval, fp, decision)
	d.audit(id, "decide_"+decision, err, device, "")
	return t.view(true), err
}

// audit 记页面动作的结果；结果只写分类，不写任务文字或命令。
func (d *Desk) audit(id, action string, err error, device, extra string) {
	result := "ok"
	switch {
	case err == nil:
	case errors.Is(err, ErrLease):
		result = "refused: lease"
	case errors.Is(err, ErrState), errors.Is(err, core.ErrConflict):
		result = "refused: state"
	case errors.Is(err, core.ErrBadRequest), errors.Is(err, core.ErrMismatch):
		result = "refused: invalid"
	default:
		result = "failed"
	}
	if extra != "" {
		result += "; " + extra
	}
	_ = d.Core.DispatchAudit(d.ctx, id, action, result, "panel", device)
}

// OwnsApproval：派活台的审批只能在派活台看完命令后处理，普通审批接口一律拒绝。
func (d *Desk) OwnsApproval(id string) bool {
	d.mu.Lock()
	tasks := d.taskList()
	d.mu.Unlock()
	for _, t := range tasks {
		t.mu.Lock()
		owned := t.owned[id]
		t.mu.Unlock()
		if owned {
			return true
		}
	}
	// Core 先提交审批，ready 回调才登记编号；这段间隙和重启后遗留的审批也要拦住。
	var n int
	err := d.Core.St.R().QueryRow(`SELECT count(*) FROM approvals WHERE id=? AND kind='permission' AND tool_name='NativeCodexControl'`, id).Scan(&n)
	return err != nil || n != 0
}

// 同一件任务同一时刻只有一个原生请求在途。每次解锁后的 RPC 返回时都重新核对身份，
// 被别人接过去的旧请求不能改写新控制者看到的状态。
type nativeRequest struct {
	client, op, turn string
	epoch            int
	startingTurn     bool
	sent             bool // turn/start 已发出：之后失败就是结果不明
	transport        Transport
}

type Task struct {
	d         *Desk
	mu        sync.Mutex
	row       core.DispatchRow
	created   string
	transport Transport
	inflight  *nativeRequest
	approvals map[string]context.CancelFunc
	owned     map[string]bool
	pending   []*Pending
	finished  map[string]bool
}

func newTask(d *Desk, r core.DispatchRow) *Task {
	if r.Ops == nil {
		r.Ops = map[string]string{}
	}
	if r.Status == "" {
		r.Status = "ready"
	}
	return &Task{d: d, row: r, created: r.CreatedAt, approvals: map[string]context.CancelFunc{}, owned: map[string]bool{}, finished: map[string]bool{}}
}

func (t *Task) save() error {
	return t.d.Core.SaveDispatch(t.d.ctx, t.row.ID, t.row.Thread, t.row.Turn, t.row.Status, t.row.Error)
}

// observe 记一条 Codex 运行观察（只有类型，没有内容）。
func (t *Task) observe(kind string) {
	_ = t.d.Core.DispatchAudit(t.d.ctx, t.row.ID, kind, "", "codex", "")
}

func (t *Task) view(detail bool) TaskView {
	t.mu.Lock()
	v := TaskView{DispatchRow: t.row, Desktop: t.row.Status == "desktop", Pending: []*Pending{}}
	for _, p := range t.pending {
		c := *p
		if !detail {
			c.Details = ""
		}
		v.Pending = append(v.Pending, &c)
	}
	t.mu.Unlock()
	_ = t.d.Core.St.R().QueryRow(`SELECT status FROM work_items WHERE id=?`, v.WorkItemID).Scan(&v.WorkStatus)
	_ = t.d.Core.St.R().QueryRow(`SELECT text FROM brief_entries WHERE work_item_id=? AND source='deliver' AND field='summary' ORDER BY id DESC LIMIT 1`, v.WorkItemID).Scan(&v.DeliverySummary)
	if detail {
		v.Events, _ = t.d.Core.DispatchEvents(t.d.ctx, t.row.ID, 30)
	}
	return v
}

func (t *Task) ingest(kind event.Kind, id, text string, toolIDs ...string) (core.IngestResult, error) {
	e := &event.Event{EventID: "native:" + t.row.Thread + ":" + id, SchemaVersion: 1, OccurredAt: t.d.now().UTC(), Source: event.Source{Provider: "codex", Client: "cli", Originator: "codex_cli", HostID: t.d.hostID}, SessionID: t.row.Thread, Cwd: t.row.Worktree, Kind: kind, RawName: "CodexAppServer", Text: text, WorkTag: t.row.WorkItemID}
	if len(toolIDs) > 0 {
		e.ToolUseID = toolIDs[0]
		e.ToolName = "commandExecution"
	}
	return t.d.Core.Ingest(t.d.ctx, e)
}

func (t *Task) requestCurrent(r *nativeRequest) bool {
	if t.inflight != r || !t.d.current(r.client, r.epoch) {
		return false
	}
	if r.op != "" {
		_, ok := t.row.Ops[r.op]
		return ok
	}
	return true
}

func (t *Task) workClosed() (bool, error) {
	var status string
	if err := t.d.Core.St.R().QueryRow(`SELECT status FROM work_items WHERE id=?`, t.row.WorkItemID).Scan(&status); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	return status == "done" || status == "abandoned", nil
}

func (t *Task) start(client string, epoch int, op, prompt string) (TaskView, error) {
	if err := validStart(op, prompt); err != nil {
		return TaskView{}, err
	}
	t.mu.Lock()
	if err := t.d.lease(client, epoch); err != nil {
		t.mu.Unlock()
		return TaskView{}, err
	}
	if _, ok := t.row.Ops[op]; ok {
		t.mu.Unlock()
		return t.view(true), nil
	}
	if closed, err := t.workClosed(); err != nil || closed {
		t.mu.Unlock()
		if err != nil {
			return TaskView{}, err
		}
		return TaskView{}, fmt.Errorf("%w: 这件工作已处理或放弃，不会从派活台悄悄重开；请另建任务", core.ErrConflict)
	}
	if t.inflight != nil || t.row.Turn != "" || t.row.Thread == "" && t.row.Status != "ready" || t.row.Status == "desktop" || t.row.Status == "needs_reconcile" || t.row.Status == "uncertain" {
		t.mu.Unlock()
		return TaskView{}, ErrState
	}
	if len(t.row.Ops) >= maxOps {
		t.mu.Unlock()
		return TaskView{}, fmt.Errorf("%w: 这件任务的轮次已达上限，请另建任务", core.ErrBadRequest)
	}
	t.row.Ops[op] = ""
	if err := t.d.Core.SetDispatchOp(t.d.ctx, t.row.ID, op, ""); err != nil {
		delete(t.row.Ops, op)
		t.mu.Unlock()
		return TaskView{}, err
	}
	return t.begin(&nativeRequest{client: client, epoch: epoch, op: op, transport: t.transport}, prompt)
}

// begin 在 t.mu 已持有、幂等键已记下时调用，返回前释放 t.mu。原生 I/O 一律在锁外做。
func (t *Task) begin(r *nativeRequest, prompt string) (TaskView, error) {
	prior := t.row.Status
	t.row.Status, t.row.Error = "starting", ""
	t.observe("turn_requested")
	if err := t.save(); err != nil {
		t.row.Status = prior
		t.mu.Unlock()
		return TaskView{}, err
	}
	t.inflight = r
	t.d.wg.Add(1)
	defer t.d.wg.Done()
	thread, worktree := t.row.Thread, t.row.Worktree
	tr := t.transport
	t.mu.Unlock()

	if tr == nil {
		var err error
		tr, thread, err = t.connect(r, thread)
		if err != nil {
			return t.failRequest(r, tr, prior, err)
		}
	}
	t.mu.Lock()
	if !t.requestCurrent(r) || t.transport != tr {
		t.mu.Unlock()
		return t.failRequest(r, tr, prior, ErrLease)
	}
	t.row.Thread = thread
	r.startingTurn, r.sent = true, true
	if err := t.save(); err != nil {
		t.mu.Unlock()
		return t.failRequest(r, tr, prior, err)
	}
	t.mu.Unlock()

	ctx, cancel := context.WithTimeout(t.d.ctx, 30*time.Second)
	defer cancel()
	var result struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	err := tr.Call(ctx, "turn/start", map[string]any{"threadId": thread, "clientUserMessageId": r.op, "input": []any{map[string]any{"type": "text", "text": prompt}}, "approvalPolicy": "on-request", "sandboxPolicy": map[string]any{"type": "workspaceWrite", "writableRoots": []string{worktree}, "networkAccess": false, "excludeSlashTmp": true, "excludeTmpdirEnvVar": true}}, &result)
	if err == nil && result.Turn.ID == "" {
		err = errors.New("Codex 没有返回轮次")
	}
	if err != nil {
		return t.failRequest(r, tr, prior, err)
	}
	t.mu.Lock()
	if !t.requestCurrent(r) || t.transport != tr {
		t.mu.Unlock()
		return t.failRequest(r, tr, prior, ErrLease)
	}
	// 如果已经先看到这一轮结束，绑定是幂等的，不会让结束的轮次复活。
	if err := t.bindRequestedTurn(r, result.Turn.ID); err != nil {
		t.mu.Unlock()
		return t.failRequest(r, tr, prior, err)
	}
	t.inflight = nil
	t.mu.Unlock()
	return t.view(true), nil
}

// connect 起一个 app-server 子进程，立即开始读事件，再开始或恢复会话。
func (t *Task) connect(r *nativeRequest, thread string) (Transport, string, error) {
	tr, err := t.d.factory(t.d.ctx, t.row.Worktree)
	if err != nil {
		return nil, "", err
	}
	t.mu.Lock()
	if !t.requestCurrent(r) {
		t.mu.Unlock()
		_ = tr.Close()
		return nil, "", ErrLease
	}
	t.transport, r.transport = tr, tr
	t.d.wg.Add(1)
	go func() { defer t.d.wg.Done(); t.read(tr) }()
	worktree := t.row.Worktree
	t.mu.Unlock()

	ctx, cancel := context.WithTimeout(t.d.ctx, 30*time.Second)
	defer cancel()
	if err = tr.Call(ctx, "initialize", map[string]any{"clientInfo": map[string]string{"name": "session_steward_dispatch", "version": "0.2.0"}, "capabilities": map[string]any{"experimentalApi": true}}, nil); err != nil {
		return tr, "", err
	}
	if err = tr.Notify("initialized", map[string]any{}); err != nil {
		return tr, "", err
	}
	params := map[string]any{"cwd": worktree, "approvalPolicy": "on-request", "sandbox": "workspace-write"}
	method := "thread/start"
	if thread != "" {
		method = "thread/resume"
		params["threadId"] = thread
		params["excludeTurns"] = true
	} else {
		params["developerInstructions"] = "This task was dispatched from Session Steward on this Mac. Work only in the current worktree. Do not use cloud workspaces. When you intentionally deliver your work, call ss_deliver with a concise summary; this records agent delivery for the user's review, never user acceptance. Do not call it when interrupted or merely waiting."
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
	if result.Thread.ID == "" || (thread != "" && result.Thread.ID != thread) {
		return tr, "", errors.New("Codex 返回的会话号与记录不一致")
	}
	return tr, result.Thread.ID, nil
}

// failRequest 收回这个请求的连接。turn/start 还没发出时什么都没执行：恢复原状态、撤掉幂等键，
// 同一个键可以再交一次；已经发出则结果不明，标“待核对”，不自动重发。
func (t *Task) failRequest(r *nativeRequest, tr Transport, prior string, cause error) (TaskView, error) {
	t.mu.Lock()
	err := cause
	if t.inflight == r {
		if r.sent {
			t.row.Status = "uncertain"
			t.row.Error = "请求是否已执行尚待核对；不会自动重发"
			t.observe("native_request_uncertain")
			err = fmt.Errorf("%w：%s", ErrState, t.row.Error)
		} else {
			t.row.Status = prior
			t.row.Error = "没能连上 Codex：" + shortError(cause)
			if r.op != "" && t.row.Ops[r.op] == "" {
				delete(t.row.Ops, r.op)
				_ = t.d.Core.DeleteDispatchOp(t.d.ctx, t.row.ID, r.op)
			}
			t.observe("native_connect_failed")
		}
		_ = t.save()
		t.inflight = nil
	}
	if t.transport == tr {
		t.transport = nil
	}
	t.mu.Unlock()
	if tr != nil {
		_ = tr.Close()
	}
	return t.view(true), err
}

func shortError(err error) string {
	s := err.Error()
	if strings.Contains(s, "active writer") {
		return "这条会话正被桌面 App 打开着；请先在 App 里关掉它或退出 App"
	}
	if r := []rune(s); len(r) > 160 {
		s = string(r[:160]) + "…"
	}
	return s
}

// bindRequestedTurn：原生事件可能先于 turn/start 的回复到达，只绑定一次。
func (t *Task) bindRequestedTurn(r *nativeRequest, turn string) error {
	if r.turn != "" {
		if r.turn != turn {
			return errors.New("Codex 轮次与请求不一致")
		}
		return nil
	}
	r.turn = turn
	t.row.Ops[r.op] = turn
	if err := t.d.Core.SetDispatchOp(t.d.ctx, t.row.ID, r.op, turn); err != nil {
		return err
	}
	if t.finished[turn] {
		return nil
	}
	t.row.Turn, t.row.Status = turn, "running"
	if _, err := t.ingest(event.KindPrompt, "prompt:"+turn, ""); err != nil {
		return err
	}
	return t.save()
}

func (t *Task) resume(client string, epoch int) (TaskView, error) {
	t.mu.Lock()
	if err := t.d.lease(client, epoch); err != nil {
		t.mu.Unlock()
		return TaskView{}, err
	}
	stale := t.row.Turn != "" && t.row.Status == "needs_reconcile"
	if t.inflight != nil || t.transport != nil || t.row.Thread == "" || t.row.Status == "desktop" || t.row.Turn != "" && !stale {
		t.mu.Unlock()
		return TaskView{}, ErrState
	}
	prior := t.row.Status
	r := &nativeRequest{client: client, epoch: epoch}
	t.row.Status = "starting"
	t.observe("native_thread_resume_requested")
	if err := t.save(); err != nil {
		t.row.Status = prior
		t.mu.Unlock()
		return TaskView{}, err
	}
	t.inflight = r
	t.d.wg.Add(1)
	defer t.d.wg.Done()
	thread := t.row.Thread
	t.mu.Unlock()

	tr, _, err := t.connect(r, thread)
	if err != nil {
		return t.failRequest(r, tr, prior, err)
	}
	t.mu.Lock()
	if !t.requestCurrent(r) || t.transport != tr {
		t.mu.Unlock()
		return t.failRequest(r, tr, prior, ErrLease)
	}
	if t.row.Turn != "" {
		// 重启前那一轮的进程已经没了；恢复只是重新连上，不重跑它。
		t.finished[t.row.Turn] = true
		t.row.Turn = ""
	}
	t.row.Status, t.row.Error = "idle", ""
	t.observe("native_thread_resumed")
	err = t.save()
	t.inflight = nil
	t.mu.Unlock()
	if err != nil {
		return TaskView{}, err
	}
	return t.view(true), nil
}

func (t *Task) interrupt(client string, epoch int) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := t.d.lease(client, epoch); err != nil {
		return err
	}
	if t.row.Turn == "" || t.transport == nil {
		return ErrState
	}
	ctx, cancel := context.WithTimeout(t.d.ctx, 10*time.Second)
	defer cancel()
	// 页面动作的审计由 Desk 记，这里不再重复记一条。
	return t.transport.Call(ctx, "turn/interrupt", map[string]string{"threadId": t.row.Thread, "turnId": t.row.Turn}, nil)
}

// handoff 释放派活台的写入权并关掉 app-server，桌面 App 才能接着写这条会话（K2 点验的约束）。
func (t *Task) handoff(client string, epoch int) error {
	t.mu.Lock()
	if err := t.d.lease(client, epoch); err != nil {
		t.mu.Unlock()
		return err
	}
	if t.inflight != nil || t.row.Thread == "" || len(t.approvals) > 0 || (t.row.Turn != "" && t.row.Status != "needs_reconcile") || t.row.Status == "uncertain" || t.row.Status == "desktop" {
		t.mu.Unlock()
		return ErrState
	}
	t.row.Status, t.row.Error = "desktop", ""
	if err := t.save(); err != nil {
		t.mu.Unlock()
		return err
	}
	tr := t.transport
	t.transport = nil
	t.mu.Unlock()
	if tr != nil {
		_ = tr.Close()
	}
	return nil
}

func (t *Task) decide(client string, epoch int, id, fp, decision string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if err := t.d.lease(client, epoch); err != nil {
		return err
	}
	if decision != "allow" && decision != "deny" {
		return fmt.Errorf("%w: 只能仅允许这一次或拒绝", core.ErrBadRequest)
	}
	for _, p := range t.pending {
		if p.ID == id && p.Turn == t.row.Turn && p.Fingerprint == fp {
			if decision == "allow" && !p.Approvable {
				return ErrState
			}
			return t.d.Core.Decide(t.d.ctx, id, fp, core.Decision{Behavior: decision})
		}
	}
	return fmt.Errorf("%w: 这项请求已经处理过或已失效", core.ErrConflict)
}

func (t *Task) close() {
	t.mu.Lock()
	for _, cancel := range t.approvals {
		cancel()
	}
	tr := t.transport
	t.transport = nil
	t.mu.Unlock()
	if tr != nil {
		_ = tr.Close()
	}
}

func (t *Task) read(tr Transport) {
	for msg := range tr.Events() {
		t.handle(tr, msg)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.transport == tr && !t.d.isClosed() {
		fenced := t.inflight != nil && !t.requestCurrent(t.inflight)
		t.transport = nil
		if !fenced {
			t.row.Status = "needs_reconcile"
			t.row.Error = "和 Codex 的连接断了，请核对；没有自动重新执行"
			_ = t.save()
		}
	}
}

func (t *Task) handle(tr Transport, msg Message) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.d.isClosed() || t.transport != tr {
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
	if r := t.inflight; r != nil && r.transport == tr {
		if !t.requestCurrent(r) {
			if len(msg.ID) > 0 {
				_ = tr.Reply(msg.ID, map[string]any{"decision": "cancel", "contentItems": []any{}, "success": false})
			}
			return
		}
		if r.startingTurn && p.ThreadID == t.row.Thread && p.TurnID != "" && !t.finished[p.TurnID] && t.row.Turn == "" {
			if err := t.bindRequestedTurn(r, p.TurnID); err != nil {
				t.row.Status = "uncertain"
				t.row.Error = "没能记下这一轮的运行观察，请核对；不会自动重发"
				_ = t.save()
				return
			}
		}
	}
	valid := p.ThreadID == t.row.Thread && p.TurnID != "" && p.TurnID == t.row.Turn && !t.finished[p.TurnID]
	if len(msg.ID) > 0 {
		if !valid {
			_ = tr.Reply(msg.ID, map[string]any{"decision": "cancel", "contentItems": []any{}, "success": false})
			return
		}
		if msg.Method == "item/commandExecution/requestApproval" || msg.Method == "item/fileChange/requestApproval" {
			t.approval(tr, msg, p.TurnID, p.ItemID, p.Command, p.Reason)
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
				_, err = t.ingest(event.KindDeliver, "delivery:"+p.CallID, args.Summary)
			}
			_ = tr.Reply(msg.ID, map[string]any{"success": err == nil, "contentItems": []any{map[string]string{"type": "inputText", "text": fmt.Sprintf("Delivery recorded for user review: %t. No user acceptance was written.", err == nil)}}})
			if err == nil {
				t.observe("agent_delivered")
			}
			return
		}
		_ = tr.Reject(msg.ID)
		t.observe("unsupported_native_request")
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
			if _, err := t.ingest(kind, p.TurnID+":"+p.Item.ID+":"+msg.Method, "", p.Item.ID); err != nil {
				t.row.Error = "运行观察写入失败"
			}
			if msg.Method == "item/completed" {
				t.observe(string(kind) + ":" + p.Item.Type)
			}
		}
	case "turn/completed":
		kind := event.KindStop
		t.row.Status = "idle"
		if p.Turn.Status == "failed" {
			kind, t.row.Status = event.KindStopFailure, "failed"
		}
		if p.Turn.Status == "interrupted" {
			kind, t.row.Status = event.KindInterrupt, "interrupted"
		}
		if _, err := t.ingest(kind, "end:"+p.TurnID, ""); err != nil {
			t.row.Error = "结束观察写入失败"
		}
		for _, cancel := range t.approvals {
			cancel()
		}
		t.finished[p.TurnID] = true
		t.row.Turn = ""
		t.observe("turn_" + p.Turn.Status)
		_ = t.save()
	}
}

// approval 把 Codex 的命令审批映射到既有 Approval：绑定会话、轮次、请求指纹。
// 命令正文只放在内存里给派活台显示，不写库、不进审计。
func (t *Task) approval(tr Transport, msg Message, turn, item, command, reason string) {
	key := string(msg.ID)
	if _, ok := t.approvals[key]; ok {
		return
	}
	ctx, cancel := context.WithCancel(t.d.ctx)
	t.approvals[key] = cancel
	fp := event.Fingerprint(msg.Method, msg.Params, t.row.Worktree)
	e := &event.Event{EventID: "native:" + t.row.Thread + ":approval:" + key, SchemaVersion: 1, OccurredAt: t.d.now().UTC(), Source: event.Source{Provider: "codex", Client: "cli", HostID: t.d.hostID}, SessionID: t.row.Thread, Cwd: t.row.Worktree, Kind: event.KindPermission, RawName: "CodexAppServer", ToolName: "NativeCodexControl", Fingerprint: fp, ToolUseID: item, Preview: "派活台的 Codex 请求；请在派活台查看内容后处理"}
	details := command
	if details == "" {
		details = reason
	}
	if details == "" {
		details = "文件修改请求：请回 Codex 核对后再决定"
	}
	if len(details) > 32000 {
		details = "操作内容过长，派活台不支持批准；请回 Codex 处理"
	}
	approvable := msg.Method == "item/commandExecution/requestApproval" && command != "" && len(command) <= 32000
	t.d.wg.Add(1)
	go func() {
		defer t.d.wg.Done()
		id, d, ok, err := t.d.Core.RequestPermissionObserved(ctx, e, approvalWait, func(id string) {
			t.mu.Lock()
			defer t.mu.Unlock()
			if t.d.isClosed() || t.row.Turn != turn || t.transport != tr {
				cancel()
				return
			}
			t.owned[id] = true
			t.pending = append(t.pending, &Pending{id, fp, msg.Method, details, turn, approvable})
			t.observe("approval_requested")
		})
		decision := "decline"
		if ok && err == nil && d.Behavior == "allow" {
			decision = "accept"
		}
		t.mu.Lock()
		defer t.mu.Unlock()
		defer cancel()
		delete(t.approvals, key)
		if t.row.Turn != turn || t.transport != tr {
			decision = "cancel"
		}
		if tr.Reply(msg.ID, map[string]string{"decision": decision}) == nil && ok {
			_ = t.d.Core.AckDelivered(context.Background(), id)
		}
		pending := t.pending[:0]
		for _, p := range t.pending {
			if p.ID != id {
				pending = append(pending, p)
			}
		}
		t.pending = pending
		t.observe("approval_" + decision)
	}()
}
