package core

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/tmux"
)

// fakeTerm 记录调用；Panes 模拟 tmux 中的实际状态。
type fakeTerm struct {
	mu     sync.Mutex
	panes  map[string]tmux.Pane
	starts map[string]string // name -> dir
	argv   map[string][]string
	sent   []string
	failOn string
}

func newFakeTerm() *fakeTerm {
	return &fakeTerm{panes: map[string]tmux.Pane{}, starts: map[string]string{}, argv: map[string][]string{}}
}
func (f *fakeTerm) Start(_ context.Context, name, dir string, _, argv []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failOn != "" {
		return errors.New(f.failOn)
	}
	f.panes[name] = tmux.Pane{Name: name}
	f.starts[name] = dir
	f.argv[name] = argv
	return nil
}
func (f *fakeTerm) List(context.Context, string) (map[string]tmux.Pane, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string]tmux.Pane{}
	for k, v := range f.panes {
		out[k] = v
	}
	return out, nil
}
func (f *fakeTerm) Capture(_ context.Context, name string, _ int) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.panes[name]; !ok {
		return "", tmux.ErrNoSession
	}
	return "screen of " + name, nil
}
func (f *fakeTerm) SendText(_ context.Context, name, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sent = append(f.sent, name+":"+text)
	return nil
}
func (f *fakeTerm) SendKey(_ context.Context, name, key string) error {
	return f.SendText(context.Background(), name, "<"+key+">")
}
func (f *fakeTerm) Kill(_ context.Context, name string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.panes, name)
	return nil
}

func gitInit(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "synthetic")
	for _, args := range [][]string{{"init", "-q", "-b", "main", dir}, {"-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init"}} {
		if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	real, _ := filepath.EvalSymlinks(dir)
	return real
}

func managedCore(t *testing.T) (*Core, *fakeTerm, int64) {
	t.Helper()
	repo := gitInit(t)
	c := newCore(t, gitx.NewLocator())
	ft := newFakeTerm()
	c.Term, c.Agents, c.WorktreeRoot = ft, map[string]AgentSpec{"claude": {Argv: []string{"claude"}, Hooks: true}, "codex": {Argv: []string{"codex"}, Hooks: true}}, filepath.Join(t.TempDir(), "wt")
	ctx := context.Background()
	e := ev("seed", event.KindSessionStart, time.Now())
	e.Cwd = repo
	if _, err := c.Ingest(ctx, e); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := c.St.R().QueryRow(`SELECT id FROM repos`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return c, ft, id
}

func TestLaunchIsolatesWorktreesAndBindsHooks(t *testing.T) {
	c, ft, repo := managedCore(t)
	ctx := context.Background()
	var ms []*ManagedSession
	for i, a := range []string{"claude", "claude", "codex"} {
		m, err := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: a, Title: "合成任务 " + string(rune('A'+i))})
		if err != nil {
			t.Fatal(err)
		}
		if m.State != "running" {
			t.Fatalf("state=%s", m.State)
		}
		ms = append(ms, m)
	}
	dirs, branches := map[string]bool{}, map[string]bool{}
	for _, m := range ms {
		if dirs[m.Worktree] || branches[m.Branch] {
			t.Fatal("托管会话共享了目录或分支")
		}
		dirs[m.Worktree], branches[m.Branch] = true, true
		if ft.starts[m.TmuxName] != m.Worktree {
			t.Fatalf("tmux 启动目录 %q != worktree %q", ft.starts[m.TmuxName], m.Worktree)
		}
		out, err := exec.Command("git", "-C", m.Worktree, "rev-parse", "--abbrev-ref", "HEAD").Output()
		if err != nil || strings.TrimSpace(string(out)) != m.Branch {
			t.Fatalf("worktree 分支不符: %s %v", out, err)
		}
	}
	// hooks 会话在托管 worktree 中出现时，自动关联到该托管会话的工作项
	e := ev("agent-1", event.KindSessionStart, time.Now())
	e.Cwd = ms[1].Worktree
	if _, err := c.Ingest(ctx, e); err != nil {
		t.Fatal(err)
	}
	snap, err := c.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var bound string
	for _, s := range snap.Sessions {
		if s.ProviderSessionID == "agent-1" {
			bound = s.WorkItemID
		}
	}
	if bound != ms[1].WorkItemID {
		t.Fatalf("hooks 会话应关联 %s, got %q", ms[1].WorkItemID, bound)
	}
	for _, m := range snap.Managed {
		if m.ID == ms[1].ID && (m.SessionID == nil) {
			t.Fatal("托管会话未记录 hooks 会话")
		}
	}
	if len(snap.Agents) != 2 {
		t.Fatalf("agents=%v", snap.Agents)
	}
}

func TestManagedRejectsUnconfiguredAgentAndNonGit(t *testing.T) {
	c, _, repo := managedCore(t)
	if _, err := c.LaunchManaged(context.Background(), LaunchInput{RepoID: repo, Agent: "sh -c rm", Title: "x"}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("未配置的 Agent 应拒绝: %v", err)
	}
	if _, err := c.LaunchManaged(context.Background(), LaunchInput{RepoID: repo, Agent: "claude", Title: " "}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("空标题应拒绝: %v", err)
	}
}

func TestManagedReconcileAndStopDoNotCompleteWork(t *testing.T) {
	c, ft, repo := managedCore(t)
	ctx := context.Background()
	a, _ := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: "claude", Title: "A"})
	b, _ := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: "codex", Title: "B"})
	// 刚启动时 tmux 列表暂时为空，不能判定为消失
	ft.mu.Lock()
	saved := ft.panes
	ft.panes = map[string]tmux.Pane{}
	ft.mu.Unlock()
	c.ReconcileManaged(ctx)
	if m, _ := c.managed(ctx, a.ID); m.State != "running" {
		t.Fatalf("刚启动的会话不应被判定消失: %s", m.State)
	}
	ft.mu.Lock()
	ft.panes = saved
	ft.mu.Unlock()
	c.St.Now = func() time.Time { return time.Now().Add(time.Minute) }
	// a 的进程以退出码 2 结束；b 在 tmux 中被手动结束
	ft.mu.Lock()
	ft.panes[a.TmuxName] = tmux.Pane{Name: a.TmuxName, Dead: true, ExitCode: 2}
	delete(ft.panes, b.TmuxName)
	ft.mu.Unlock()
	if err := c.ReconcileManaged(ctx); err != nil {
		t.Fatal(err)
	}
	ma, _ := c.managed(ctx, a.ID)
	mb, _ := c.managed(ctx, b.ID)
	if ma.State != "exited" || ma.ExitCode == nil || *ma.ExitCode != 2 {
		t.Fatalf("a=%+v", ma)
	}
	if mb.State != "exited" || mb.Error == "" {
		t.Fatalf("b=%+v", mb)
	}
	var status string
	c.St.R().QueryRow(`SELECT status FROM work_items WHERE id=?`, a.WorkItemID).Scan(&status)
	if status == "done" || status == "review" {
		t.Fatalf("进程退出不能改变工作项完成度: %s", status)
	}
	// 已退出的不能再停止；重复同步不回退状态
	if err := c.StopManaged(ctx, a.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("stop exited: %v", err)
	}
	c.ReconcileManaged(ctx)
	if m, _ := c.managed(ctx, a.ID); m.State != "exited" {
		t.Fatal(m.State)
	}
}

func TestManagedRestartReattachesRunning(t *testing.T) {
	c, ft, repo := managedCore(t)
	ctx := context.Background()
	m, _ := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: "claude", Title: "A"})
	// 模拟服务重启：新的 Core 使用同一数据库和仍在运行的 tmux
	c2 := New(c.St, c.Loc)
	c2.Term = ft
	if err := c2.ReconcileManaged(ctx); err != nil {
		t.Fatal(err)
	}
	text, got, err := c2.CaptureManaged(ctx, m.ID)
	if err != nil || got.State != "running" || text == "" {
		t.Fatalf("重启后应接上: %q %+v %v", text, got, err)
	}
}

func TestArchiveRequiresConfirmationForDirtyWorktree(t *testing.T) {
	c, _, repo := managedCore(t)
	ctx := context.Background()
	clean, _ := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: "claude", Title: "clean"})
	dirty, _ := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: "claude", Title: "dirty"})
	if _, err := c.ArchiveManaged(ctx, clean.ID, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("运行中不能归档: %v", err)
	}
	for _, m := range []*ManagedSession{clean, dirty} {
		if err := c.StopManaged(ctx, m.ID); err != nil {
			t.Fatal(err)
		}
	}
	os.WriteFile(filepath.Join(dirty.Worktree, "notes.txt"), []byte("合成改动"), 0o644)
	if _, err := c.ArchiveManaged(ctx, clean.ID, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(clean.Worktree); !os.IsNotExist(err) {
		t.Fatal("干净的 worktree 应被移除")
	}
	files, err := c.ArchiveManaged(ctx, dirty.ID, false)
	if !errors.Is(err, ErrConflict) || len(files) != 1 {
		t.Fatalf("有改动应要求确认: %v %v", files, err)
	}
	if _, err := os.Stat(dirty.Worktree); err != nil {
		t.Fatal("未确认前不能移除有改动的 worktree")
	}
	if _, err := c.ArchiveManaged(ctx, dirty.ID, true); err != nil {
		t.Fatal(err)
	}
	// 归档只移除目录，分支和提交保留
	var common string
	c.St.R().QueryRow(`SELECT common_dir FROM repos WHERE id=?`, repo).Scan(&common)
	if out, err := exec.Command("git", "--git-dir="+common, "rev-parse", "--verify", dirty.Branch).CombinedOutput(); err != nil {
		t.Fatalf("分支应保留: %s", out)
	}
	audit, _ := c.ManagedAudit(ctx, dirty.ID)
	if audit[0].Action != "archive" || !strings.Contains(audit[0].Detail, "confirmed") {
		t.Fatalf("归档审计: %+v", audit)
	}
}

func TestTakeoverGatesInputAndAuditsWithoutText(t *testing.T) {
	c, ft, repo := managedCore(t)
	ctx := context.Background()
	m, _ := c.LaunchManaged(ctx, LaunchInput{RepoID: repo, Agent: "claude", Title: "A"})
	if err := c.SendManagedInput(ctx, m.ID, "secret-ish text", ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("默认只读: %v", err)
	}
	if err := c.SetTakeover(ctx, m.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := c.SendManagedInput(ctx, m.ID, "", "rm -rf"); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("任意按键名应拒绝: %v", err)
	}
	if err := c.SendManagedInput(ctx, m.ID, "hello", ""); err != nil {
		t.Fatal(err)
	}
	if err := c.SendManagedInput(ctx, m.ID, "", "Enter"); err != nil {
		t.Fatal(err)
	}
	if len(ft.sent) != 2 {
		t.Fatalf("sent=%v", ft.sent)
	}
	c.SetTakeover(ctx, m.ID, false)
	if err := c.SendManagedInput(ctx, m.ID, "x", ""); !errors.Is(err, ErrConflict) {
		t.Fatal("关闭接管后应拒绝")
	}
	audit, _ := c.ManagedAudit(ctx, m.ID)
	var actions []string
	for _, a := range audit {
		actions = append(actions, a.Action)
		if strings.Contains(a.Detail, "hello") {
			t.Fatal("审计不能保存输入正文")
		}
	}
	if strings.Join(actions, ",") != "takeover_off,input,input,takeover_on,launch" {
		t.Fatalf("audit=%v", actions)
	}
}

func TestLaunchFailureIsRecorded(t *testing.T) {
	c, ft, repo := managedCore(t)
	ft.failOn = "tmux exploded"
	m, err := c.LaunchManaged(context.Background(), LaunchInput{RepoID: repo, Agent: "claude", Title: "A"})
	if err != nil || m.State != "failed" || m.Error == "" {
		t.Fatalf("%+v %v", m, err)
	}
}

func TestConcurrentLaunchesStayIsolated(t *testing.T) {
	c, _, repo := managedCore(t)
	var wg sync.WaitGroup
	res := make([]*ManagedSession, 6)
	errs := make([]error, 6)
	for i := range res {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			res[i], errs[i] = c.LaunchManaged(context.Background(), LaunchInput{RepoID: repo, Agent: "claude", Title: "并发"})
		}(i)
	}
	wg.Wait()
	seen := map[string]bool{}
	for i, m := range res {
		if errs[i] != nil {
			t.Fatal(errs[i])
		}
		if seen[m.Worktree] || seen[m.WorkItemID] {
			t.Fatal("并发启动共享了目录或工作项")
		}
		seen[m.Worktree], seen[m.WorkItemID] = true, true
	}
}

type recSender struct {
	mu sync.Mutex
	a  []Alert
}

func (r *recSender) Send(_ context.Context, a Alert) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.a = append(r.a, a)
	return nil
}

func TestNotifierDedupAndScope(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	old := ev("s-old", event.KindAsk, time.Now())
	old.Text = "旧问题"
	c.Ingest(ctx, old) // 推送器启动之前的条目不推送
	time.Sleep(2 * time.Millisecond)
	rec := &recSender{}
	n := &Notifier{C: c, Senders: []Sender{rec}, BaseURL: "http://127.0.0.1:1"}
	n.Check(ctx)
	if len(rec.a) != 0 {
		t.Fatalf("旧条目不应推送: %+v", rec.a)
	}
	ask := ev("s1", event.KindAsk, time.Now())
	ask.Text = "需要决定的问题含 token=abc"
	c.Ingest(ctx, ask)
	fail := ev("s2", event.KindStopFailure, time.Now())
	c.Ingest(ctx, fail)
	n.Check(ctx)
	n.Check(ctx)
	if len(rec.a) != 2 {
		t.Fatalf("应各推送一次: %+v", rec.a)
	}
	for _, a := range rec.a {
		if strings.Contains(a.Body, "token") || strings.Contains(a.Body, "问题") {
			t.Fatalf("推送不应包含正文: %+v", a)
		}
		if !strings.HasPrefix(a.Link, "http://127.0.0.1:1/#") {
			t.Fatalf("link=%s", a.Link)
		}
	}
	// 同一会话再次进入出错状态（新的事件时间）是新条目
	fail2 := ev("s2", event.KindStopFailure, time.Now().Add(time.Second))
	c.Ingest(ctx, fail2)
	n.Check(ctx)
	if len(rec.a) != 3 {
		t.Fatalf("新的出错应再推送: %d", len(rec.a))
	}
}

func TestNotifierPermissionWithinDeadline(t *testing.T) {
	c := newCore(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	rec := &recSender{}
	n := &Notifier{C: c, Senders: []Sender{rec}, BaseURL: "http://127.0.0.1:1", Debounce: time.Millisecond}
	n.since = c.St.NowTS()
	go n.Run(ctx)
	time.Sleep(5 * time.Millisecond)
	p := ev("s1", event.KindPermission, time.Now())
	p.ToolName, p.Fingerprint, p.Preview = "Bash", "fp1", "ls"
	start := time.Now()
	go c.RequestPermission(ctx, p, 3*time.Second)
	for time.Since(start) < 5*time.Second {
		rec.mu.Lock()
		got := len(rec.a)
		rec.mu.Unlock()
		if got == 1 {
			rec.mu.Lock()
			a := rec.a[0]
			rec.mu.Unlock()
			if !strings.Contains(a.Link, "#approval=") || strings.Contains(a.Body, "ls") {
				t.Fatalf("alert=%+v", a)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("5 秒内未推送权限请求")
}

func TestNotifierSkipsSupersededHandoffs(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	c.CreateWorkItem(ctx, WorkItemInput{ID: "NT-1", Title: "synthetic"})
	claim := ev("notify-1", event.KindClaim, time.Now())
	claim.WorkTag = "NT-1"
	if _, err := c.Ingest(ctx, claim); err != nil {
		t.Fatal(err)
	}
	n := &Notifier{C: c, since: c.St.NowTS()}
	for i, owner := range []string{"user", "user", "agent"} {
		e := ev("notify-1", event.KindReport, time.Now().Add(time.Duration(i+1)*time.Second))
		e.Brief = map[string]string{"next_owner": owner, "next": "synthetic next step"}
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	alerts, err := n.Pending(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(alerts) != 0 {
		t.Fatalf("superseded user handoffs must not notify: %+v", alerts)
	}
}

func TestNotifierDeliveryExplainsAcceptanceAction(t *testing.T) {
	for _, status := range []string{"review", "in_progress", "done"} {
		t.Run(status, func(t *testing.T) {
			c := newCore(t, nil)
			ctx := context.Background()
			if err := c.CreateWorkItem(ctx, WorkItemInput{ID: "NT-4", Title: "private synthetic title"}); err != nil {
				t.Fatal(err)
			}
			claim := ev("notify-delivery", event.KindClaim, time.Now())
			claim.WorkTag = "NT-4"
			if _, err := c.Ingest(ctx, claim); err != nil {
				t.Fatal(err)
			}
			e := ev("notify-delivery", event.KindReport, time.Now().Add(time.Second))
			e.Brief = map[string]string{"next_owner": "user", "next": "private synthetic instructions"}
			if _, err := c.Ingest(ctx, e); err != nil {
				t.Fatal(err)
			}
			if err := c.UpdateWorkItem(ctx, "NT-4", WorkItemPatch{Status: &status}); err != nil {
				t.Fatal(err)
			}
			n := &Notifier{C: c, since: "2000-01-01T00:00:00Z", BaseURL: "http://127.0.0.1:1"}
			alerts, err := n.Pending(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if status == "done" {
				if len(alerts) != 0 {
					t.Fatal("accepted work notified again", alerts)
				}
				return
			}
			if len(alerts) != 1 || alerts[0].Link != "http://127.0.0.1:1/#item=NT-4" || strings.Contains(alerts[0].Body, "private") {
				t.Fatal("wrong action target or private content in notification", alerts)
			}
			if status == "review" && (alerts[0].Title != "交付待你验收" || !strings.Contains(alerts[0].Body, "验收通过或退回修改")) {
				t.Fatal("missing acceptance guidance", alerts)
			}
			if status != "review" && alerts[0].Title != "需要你：接手下一步" {
				t.Fatal("ordinary handoff mislabelled as acceptance", alerts)
			}
		})
	}
}
