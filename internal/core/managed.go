package core

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/xoqiu09/session-steward/internal/store"
	"github.com/xoqiu09/session-steward/internal/tmux"
)

// Terminal 抽象托管会话使用的终端复用器（tmux），测试可替换。
type Terminal interface {
	Start(ctx context.Context, name, dir string, env, argv []string) error
	List(ctx context.Context, prefix string) (map[string]tmux.Pane, error)
	Capture(ctx context.Context, name string, lines int) (string, error)
	SendText(ctx context.Context, name, text string) error
	SendKey(ctx context.Context, name, key string) error
	Kill(ctx context.Context, name string) error
}

const managedPrefix = "steward-"

// 托管会话状态。exited/stopped/failed 都不代表工作项完成；归档只清理目录。
var managedTransitions = map[string][]string{
	"running":  {"starting"},
	"exited":   {"starting", "running"},
	"stopped":  {"starting", "running"},
	"failed":   {"starting"},
	"archived": {"exited", "stopped", "failed"},
}

type ManagedSession struct {
	ID         string `json:"id"`
	RepoID     int64  `json:"repo_id"`
	Agent      string `json:"agent"`
	Title      string `json:"title"`
	WorkItemID string `json:"work_item_id"`
	Worktree   string `json:"worktree"`
	Branch     string `json:"branch"`
	BaseSHA    string `json:"base_sha"`
	TmuxName   string `json:"tmux_name"`
	State      string `json:"state"`
	ExitCode   *int   `json:"exit_code"`
	Error      string `json:"error"`
	SessionID  *int64 `json:"session_id"`
	Takeover   bool   `json:"takeover"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

type LaunchInput struct {
	RepoID int64  `json:"repo_id"`
	Agent  string `json:"agent"`
	Title  string `json:"title"`
}

// AgentSpec 是面板可启动的 Agent。Hooks=false 的 Agent 不发 Steward 事件，只有托管终端画面。
type AgentSpec struct {
	Argv      []string `json:"-"`
	Provider  string   `json:"provider"`
	Hooks     bool     `json:"hooks"`
	PromptArg bool     `json:"prompt_arg"`
}

// AgentInfo 是快照里给面板的 Agent 描述（不含命令）。
type AgentInfo struct {
	Name     string `json:"name"`
	Provider string `json:"provider"`
	Hooks    bool   `json:"hooks"`
}

// AgentNames 返回可从面板启动的 Agent（命令只来自服务配置，面板不能提交命令）。
func (c *Core) AgentNames() []string {
	out := make([]string, 0, len(c.Agents))
	for k := range c.Agents {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (c *Core) AgentInfos() []AgentInfo {
	out := []AgentInfo{}
	for _, n := range c.AgentNames() {
		a := c.Agents[n]
		out = append(out, AgentInfo{Name: n, Provider: nz(a.Provider, n), Hooks: a.Hooks})
	}
	return out
}

func shortID() string {
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func gitWrite(ctx context.Context, dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0")
	// git 被取消后，其钩子子进程可能仍占用输出管道；限定等待，避免服务退出被拖住
	cmd.WaitDelay = time.Second
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", errors.New(msg)
	}
	return strings.TrimSpace(out.String()), nil
}

func (c *Core) worktreeDir(commonDir, repoName, id string) string {
	if c.WorktreeRoot != "" {
		return filepath.Join(c.WorktreeRoot, repoName+"-"+id)
	}
	// 默认与仓库放在同一卷：<仓库所在目录>/<仓库名>.steward-worktrees/<id>
	base := filepath.Dir(commonDir)
	if filepath.Base(commonDir) != ".git" {
		base = commonDir
	}
	return filepath.Join(filepath.Dir(base), filepath.Base(base)+".steward-worktrees", id)
}

// LaunchManaged 在新 worktree/分支中用 tmux 启动 Agent，并在同一事务里登记工作项与托管会话。
func (c *Core) LaunchManaged(ctx context.Context, in LaunchInput) (*ManagedSession, error) {
	return c.launch(ctx, in, launchOpts{})
}

// launchOpts 供交接复用：沿用已有工作项、从指定提交建分支、给 Agent 传入首条提示。
type launchOpts struct {
	item    string
	baseSHA string
	prompt  string
	inTx    func(tx *sql.Tx, m *ManagedSession, now string) error
}

func (c *Core) launch(ctx context.Context, in LaunchInput, o launchOpts) (*ManagedSession, error) {
	if c.Term == nil {
		return nil, fmt.Errorf("%w: 本机未找到 tmux，无法启动托管会话", ErrBadRequest)
	}
	spec, ok := c.Agents[in.Agent]
	if !ok || len(spec.Argv) == 0 {
		return nil, fmt.Errorf("%w: 未配置的 Agent %q", ErrBadRequest, in.Agent)
	}
	argv := append([]string{}, spec.Argv...)
	if o.prompt != "" && spec.PromptArg {
		argv = append(argv, o.prompt)
	}
	title := clip(in.Title)
	if title == "" || utf8.RuneCountInString(title) > 200 {
		return nil, fmt.Errorf("%w: 任务标题为空或过长", ErrBadRequest)
	}
	var common, name, target string
	var isGit bool
	err := c.St.R().QueryRowContext(ctx, `SELECT common_dir,name,is_git,target_ref FROM repos WHERE id=?`, in.RepoID).Scan(&common, &name, &isGit, &target)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !isGit {
		return nil, fmt.Errorf("%w: 托管会话需要 Git 项目（用 worktree 隔离）", ErrBadRequest)
	}
	if _, err := os.Stat(common); err != nil {
		return nil, fmt.Errorf("%w: 仓库目录不可用", ErrBadRequest)
	}
	id := shortID()
	dir := c.worktreeDir(common, name, id)
	branch := "steward/" + id

	c.launchMu.Lock()
	base := o.baseSHA
	if base == "" {
		base, err = gitWrite(ctx, common, "rev-parse", "--verify", "--quiet", target+"^{commit}")
		if err != nil || base == "" {
			base, err = gitWrite(ctx, common, "rev-parse", "--verify", "HEAD^{commit}")
		}
	}
	if err == nil {
		err = os.MkdirAll(filepath.Dir(dir), 0o755)
	}
	if err == nil {
		_, err = gitWrite(ctx, common, "--git-dir="+common, "worktree", "add", "-b", branch, dir, base)
	}
	c.launchMu.Unlock()
	if err != nil {
		return nil, fmt.Errorf("%w: 创建 worktree 失败：%v", ErrBadRequest, err)
	}
	if real, e := filepath.EvalSymlinks(dir); e == nil {
		dir = real
	}
	now := c.St.NowTS()
	m := &ManagedSession{ID: id, RepoID: in.RepoID, Agent: in.Agent, Title: title, Worktree: dir, Branch: branch, BaseSHA: base, TmuxName: managedPrefix + id, State: "starting", CreatedAt: now, UpdatedAt: now}
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		item := o.item
		if item == "" {
			var err error
			if item, err = autoItemID(tx, autoRepo{id: in.RepoID, name: name, common: common, git: true}); err != nil {
				return err
			}
			if _, err = tx.Exec(`INSERT INTO work_items(id,repo_id,title,status,branch,needs_merge,merge_state,created_at,updated_at) VALUES(?,?,?,'todo',?,1,'not_ready',?,?)`, item, in.RepoID, title, branch, now, now); err != nil {
				return err
			}
		}
		m.WorkItemID = item
		cmd, _ := json.Marshal(argv)
		if _, err := tx.Exec(`INSERT INTO managed_sessions(id,repo_id,agent,command,title,work_item_id,worktree,branch,base_sha,tmux_name,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,'starting',?,?)`,
			id, in.RepoID, in.Agent, string(cmd), title, item, dir, branch, base, m.TmuxName, now, now); err != nil {
			return err
		}
		if err := managedAudit(tx, id, "launch", in.Agent+" @ "+branch, now); err != nil {
			return err
		}
		if o.inTx != nil {
			if err := o.inTx(tx, m, now); err != nil {
				return err
			}
		}
		if err := store.Touch(tx, now, "work_item", item); err != nil {
			return err
		}
		return store.Touch(tx, now, "managed", id)
	})
	if err != nil {
		gitWrite(context.Background(), common, "--git-dir="+common, "worktree", "remove", "--force", dir)
		gitWrite(context.Background(), common, "--git-dir="+common, "branch", "-D", branch)
		return nil, err
	}
	env := append([]string{"STEWARD_HOME=" + c.StewardHome, "STEWARD_MANAGED_ID=" + id}, c.ManagedEnv...)
	if err := c.Term.Start(ctx, m.TmuxName, dir, env, argv); err != nil {
		c.setManagedState(context.Background(), id, "failed", nil, err.Error(), "")
		m.State, m.Error = "failed", err.Error()
		return m, nil
	}
	c.setManagedState(ctx, id, "running", nil, "", "")
	m.State = "running"
	return m, nil
}

func managedAudit(tx *sql.Tx, id, action, detail, now string) error {
	_, err := tx.Exec(`INSERT INTO managed_audit(managed_id,action,detail,actor,at) VALUES(?,?,?,'panel',?)`, id, action, detail, now)
	return err
}

// setManagedState 只按允许的来源状态迁移；返回是否实际发生迁移。
func (c *Core) setManagedState(ctx context.Context, id, to string, code *int, msg, audit string) (bool, error) {
	from := managedTransitions[to]
	if len(from) == 0 {
		return false, fmt.Errorf("%w: 未知状态 %s", ErrBadRequest, to)
	}
	now := c.St.NowTS()
	changed := false
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		q := `UPDATE managed_sessions SET state=?, exit_code=COALESCE(?,exit_code), error=CASE WHEN ?<>'' THEN ? ELSE error END, takeover=CASE WHEN ? IN ('running') THEN takeover ELSE 0 END, updated_at=? WHERE id=? AND state IN (` + strings.TrimSuffix(strings.Repeat("?,", len(from)), ",") + `)`
		args := []any{to, code, msg, msg, to, now, id}
		for _, f := range from {
			args = append(args, f)
		}
		res, err := tx.Exec(q, args...)
		if err != nil {
			return err
		}
		n, _ := res.RowsAffected()
		if n == 0 {
			return nil
		}
		changed = true
		if audit != "" {
			if err := managedAudit(tx, id, audit, msg, now); err != nil {
				return err
			}
		}
		return store.Touch(tx, now, "managed", id)
	})
	if changed {
		c.notify()
	}
	return changed, err
}

func (c *Core) managed(ctx context.Context, id string) (*ManagedSession, error) {
	var m ManagedSession
	var code, sid sql.NullInt64
	err := c.St.R().QueryRowContext(ctx, `SELECT id,repo_id,agent,title,work_item_id,worktree,branch,base_sha,tmux_name,state,exit_code,error,session_id,takeover,created_at,updated_at FROM managed_sessions WHERE id=?`, id).
		Scan(&m.ID, &m.RepoID, &m.Agent, &m.Title, &m.WorkItemID, &m.Worktree, &m.Branch, &m.BaseSHA, &m.TmuxName, &m.State, &code, &m.Error, &sid, &m.Takeover, &m.CreatedAt, &m.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if code.Valid {
		v := int(code.Int64)
		m.ExitCode = &v
	}
	if sid.Valid {
		v := sid.Int64
		m.SessionID = &v
	}
	return &m, err
}

// StopManaged 结束 tmux 会话。停止不等于工作项完成，工作项状态不变。
func (c *Core) StopManaged(ctx context.Context, id string) error {
	m, err := c.managed(ctx, id)
	if err != nil {
		return err
	}
	if m.State != "running" && m.State != "starting" {
		return fmt.Errorf("%w: 会话当前为 %s，无需停止", ErrConflict, m.State)
	}
	if err := c.Term.Kill(ctx, m.TmuxName); err != nil {
		return err
	}
	_, err = c.setManagedState(ctx, id, "stopped", nil, "", "stop")
	return err
}

// ArchiveManaged 移除 worktree 目录（保留分支和提交）。有未提交改动时需 force 确认。
func (c *Core) ArchiveManaged(ctx context.Context, id string, force bool) (dirty []string, err error) {
	m, err := c.managed(ctx, id)
	if err != nil {
		return nil, err
	}
	if m.State == "running" || m.State == "starting" {
		return nil, fmt.Errorf("%w: 请先停止会话再归档", ErrConflict)
	}
	if m.State == "archived" {
		return nil, fmt.Errorf("%w: 已归档", ErrConflict)
	}
	var common string
	if err := c.St.R().QueryRowContext(ctx, `SELECT common_dir FROM repos WHERE id=?`, m.RepoID).Scan(&common); err != nil {
		return nil, err
	}
	if _, statErr := os.Stat(m.Worktree); statErr == nil {
		out, err := gitWrite(ctx, m.Worktree, "status", "--porcelain", "--untracked-files=all")
		if err != nil {
			return nil, fmt.Errorf("检查改动失败：%w", err)
		}
		if out != "" {
			dirty = strings.Split(out, "\n")
		}
		if len(dirty) > 0 && !force {
			return dirty, fmt.Errorf("%w: worktree 有 %d 处未提交改动，确认后才能移除", ErrConflict, len(dirty))
		}
		args := []string{"--git-dir=" + common, "worktree", "remove"}
		if len(dirty) > 0 {
			args = append(args, "--force")
		}
		if _, err := gitWrite(ctx, common, append(args, m.Worktree)...); err != nil {
			return dirty, fmt.Errorf("移除 worktree 失败：%w", err)
		}
	} else {
		gitWrite(ctx, common, "--git-dir="+common, "worktree", "prune")
	}
	detail := "clean"
	if len(dirty) > 0 {
		detail = fmt.Sprintf("discarded %d changes (confirmed)", len(dirty))
	}
	changed, err := c.setManagedState(ctx, id, "archived", nil, "", "")
	if err == nil && changed {
		err = c.St.Tx(ctx, func(tx *sql.Tx) error { return managedAudit(tx, id, "archive", detail, c.St.NowTS()) })
	}
	return dirty, err
}

// SetTakeover 显式切换“接管输入”，每次切换都写审计。
func (c *Core) SetTakeover(ctx context.Context, id string, on bool) error {
	now := c.St.NowTS()
	v, action := 0, "takeover_off"
	if on {
		v, action = 1, "takeover_on"
	}
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.Exec(`UPDATE managed_sessions SET takeover=?, updated_at=? WHERE id=? AND (state='running' OR ?=0)`, v, now, id, v)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return fmt.Errorf("%w: 会话不存在或未运行", ErrConflict)
		}
		if err := managedAudit(tx, id, action, "", now); err != nil {
			return err
		}
		return store.Touch(tx, now, "managed", id)
	})
	if err == nil {
		c.notify()
	}
	return err
}

var allowedKeys = map[string]bool{"Enter": true, "Escape": true, "C-c": true, "Tab": true, "BSpace": true, "Up": true, "Down": true, "Left": true, "Right": true}

// SendManagedInput 只在接管开启时把输入写入终端；审计只记录长度/按键，不保存输入正文。
func (c *Core) SendManagedInput(ctx context.Context, id, text, key string) error {
	if text != "" && key != "" {
		return fmt.Errorf("%w: text 与 key 只能二选一", ErrBadRequest)
	}
	if key != "" && !allowedKeys[key] {
		return fmt.Errorf("%w: 不支持的按键", ErrBadRequest)
	}
	if text == "" && key == "" {
		return fmt.Errorf("%w: 输入为空", ErrBadRequest)
	}
	if len(text) > 4096 {
		return fmt.Errorf("%w: 输入过长", ErrBadRequest)
	}
	m, err := c.managed(ctx, id)
	if err != nil {
		return err
	}
	if m.State != "running" || !m.Takeover {
		return fmt.Errorf("%w: 终端默认只读，请先开启“接管输入”", ErrConflict)
	}
	detail := "key " + key
	if text != "" {
		detail = fmt.Sprintf("text %d chars", utf8.RuneCountInString(text))
	}
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error { return managedAudit(tx, id, "input", detail, c.St.NowTS()) }); err != nil {
		return err
	}
	if text != "" {
		return c.Term.SendText(ctx, m.TmuxName, text)
	}
	return c.Term.SendKey(ctx, m.TmuxName, key)
}

// CaptureManaged 读取终端当前画面。未运行的会话返回最后保留的画面（若 tmux 仍保留）。
func (c *Core) CaptureManaged(ctx context.Context, id string) (string, *ManagedSession, error) {
	m, err := c.managed(ctx, id)
	if err != nil {
		return "", nil, err
	}
	if m.State == "archived" || m.State == "failed" || m.State == "stopped" {
		return "", m, nil
	}
	text, err := c.Term.Capture(ctx, m.TmuxName, 300)
	if errors.Is(err, tmux.ErrNoSession) {
		return "", m, nil
	}
	return text, m, err
}

// ReconcileManaged 用 tmux 实际状态更新托管会话：服务重启后仍在运行的会话照常接上，
// 已退出的记录退出码，tmux 会话消失的记为已退出（原因写明）。
func (c *Core) ReconcileManaged(ctx context.Context) error {
	if c.Term == nil {
		return nil
	}
	rows, err := c.St.R().QueryContext(ctx, `SELECT id,tmux_name,state,updated_at FROM managed_sessions WHERE state IN ('starting','running')`)
	if err != nil {
		return err
	}
	type row struct{ id, name, state, at string }
	var live []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.name, &r.state, &r.at); err != nil {
			rows.Close()
			return err
		}
		live = append(live, r)
	}
	rows.Close()
	if len(live) == 0 {
		return nil
	}
	panes, err := c.Term.List(ctx, managedPrefix)
	if err != nil {
		return err
	}
	grace := store.TS(c.St.Now().Add(-10 * time.Second))
	for _, r := range live {
		p, ok := panes[r.name]
		switch {
		case !ok && r.at > grace:
			// 刚启动或刚变更：tmux 服务器可能仍在启动，list 会短暂看不到，不据此判定消失
		case !ok:
			// 列表可能因 tmux 服务器瞬时不可用而为空；逐个确认后才判定消失
			if _, err := c.Term.Capture(ctx, r.name, 1); !errors.Is(err, tmux.ErrNoSession) {
				continue
			}
			c.setManagedState(ctx, r.id, "exited", nil, "tmux 会话已不存在（可能被手动结束或电脑重启）", "")
		case p.Dead && !p.HasExitCode:
			c.setManagedState(ctx, r.id, "exited", nil, "进程已结束；当前 tmux 未提供退出码", "")
			c.Term.Kill(ctx, r.name)
		case p.Dead:
			code := p.ExitCode
			msg := ""
			if code != 0 {
				msg = fmt.Sprintf("进程以退出码 %d 结束", code)
			}
			c.setManagedState(ctx, r.id, "exited", &code, msg, "")
			c.Term.Kill(ctx, r.name) // 画面已无新内容；退出码已保存
		case r.state == "starting":
			c.setManagedState(ctx, r.id, "running", nil, "", "")
		}
	}
	return nil
}

// attachManaged 把落在托管 worktree 里的 hooks 会话关联到该托管会话的工作项（自动 begin）。
// 已有其他归属的会话保持原样。
func attachManaged(tx *sql.Tx, sid int64, l *locInfo, at, now string) error {
	if l == nil || l.worktree == "" {
		return nil
	}
	var id, item string
	err := tx.QueryRow(`SELECT id,work_item_id FROM managed_sessions WHERE worktree=? AND state IN ('starting','running') ORDER BY created_at DESC LIMIT 1`, l.worktree).Scan(&id, &item)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var open int
	if err := tx.QueryRow(`SELECT COUNT(1) FROM runs WHERE session_id=? AND ended_at=''`, sid).Scan(&open); err != nil {
		return err
	}
	if open == 0 {
		if err := bindRun(tx, sid, item, "managed", at, now); err != nil {
			return err
		}
	}
	res, err := tx.Exec(`UPDATE managed_sessions SET session_id=?, updated_at=? WHERE id=? AND session_id IS NULL`, sid, now, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		return store.Touch(tx, now, "managed", id)
	}
	return nil
}

func (c *Core) readManaged(tx *sql.Tx) ([]ManagedSession, error) {
	rows, err := tx.Query(`SELECT id,repo_id,agent,title,work_item_id,worktree,branch,base_sha,tmux_name,state,exit_code,error,session_id,takeover,created_at,updated_at FROM managed_sessions
		WHERE state<>'archived' OR updated_at > ? ORDER BY created_at DESC LIMIT 200`, store.TS(c.St.Now().Add(-24*time.Hour)))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ManagedSession
	for rows.Next() {
		var m ManagedSession
		var code, sid sql.NullInt64
		if err := rows.Scan(&m.ID, &m.RepoID, &m.Agent, &m.Title, &m.WorkItemID, &m.Worktree, &m.Branch, &m.BaseSHA, &m.TmuxName, &m.State, &code, &m.Error, &sid, &m.Takeover, &m.CreatedAt, &m.UpdatedAt); err != nil {
			return nil, err
		}
		if code.Valid {
			v := int(code.Int64)
			m.ExitCode = &v
		}
		if sid.Valid {
			v := sid.Int64
			m.SessionID = &v
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

type ManagedAuditEntry struct {
	Action string `json:"action"`
	Detail string `json:"detail"`
	Actor  string `json:"actor"`
	At     string `json:"at"`
}

func (c *Core) ManagedAudit(ctx context.Context, id string) ([]ManagedAuditEntry, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT action,detail,actor,at FROM managed_audit WHERE managed_id=? ORDER BY id DESC LIMIT 100`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ManagedAuditEntry{}
	for rows.Next() {
		var a ManagedAuditEntry
		if err := rows.Scan(&a.Action, &a.Detail, &a.Actor, &a.At); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
