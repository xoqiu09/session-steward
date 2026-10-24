package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/store"
)

// CheckResult 是一条检查命令的结果；Tail 为输出末尾，已脱敏截断。
type CheckResult struct {
	Argv     []string `json:"argv"`
	ExitCode int      `json:"exit_code"`
	Seconds  float64  `json:"seconds"`
	Tail     string   `json:"tail"`
}

type MergeJob struct {
	ID         string        `json:"id"`
	ApprovalID string        `json:"approval_id"`
	WorkItemID string        `json:"work_item_id"`
	RepoID     int64         `json:"repo_id"`
	SourceSHA  string        `json:"source_sha"`
	TargetRef  string        `json:"target_ref"`
	TargetSHA  string        `json:"target_sha"`
	MergeSHA   string        `json:"merge_sha"`
	State      string        `json:"state"`
	Checks     []CheckResult `json:"checks"`
	Error      string        `json:"error"`
	CreatedAt  string        `json:"created_at"`
	UpdatedAt  string        `json:"updated_at"`
}

// ChecksFor 返回仓库配置的检查命令；按仓库名或 common dir 匹配。没有配置时不能自动合并。
func (c *Core) ChecksFor(name, common string) [][]string {
	if v, ok := c.Checks[common]; ok {
		return v
	}
	return c.Checks[name]
}

var mergeJobTransitions = map[string][]string{
	"running": {"queued"},
	"passed":  {"running"},
	"failed":  {"queued", "running"},
	"aborted": {"queued", "running", "passed"},
	"merged":  {"passed"},
}

func (c *Core) setJob(ctx context.Context, id, to string, mut func(*MergeJob)) error {
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		j, err := readJob(tx.QueryRow(`SELECT `+jobCols+` FROM merge_jobs WHERE id=?`, id))
		if err != nil {
			return err
		}
		ok := false
		for _, f := range mergeJobTransitions[to] {
			ok = ok || f == j.State
		}
		if !ok {
			return fmt.Errorf("%w: 合并任务 %s 不能从 %s 变为 %s", ErrConflict, id, j.State, to)
		}
		j.State = to
		if mut != nil {
			mut(j)
		}
		cb, _ := json.Marshal(j.Checks)
		if _, err := tx.Exec(`UPDATE merge_jobs SET state=?,checks=?,merge_sha=?,error=?,updated_at=? WHERE id=?`, j.State, string(cb), j.MergeSHA, j.Error, now, id); err != nil {
			return err
		}
		return store.Touch(tx, now, "merge_job", id)
	})
	if err == nil {
		c.notify()
	}
	return err
}

const jobCols = `id,approval_id,work_item_id,repo_id,source_sha,target_ref,target_sha,merge_sha,state,checks,error,created_at,updated_at`

type scanner interface{ Scan(...any) error }

func readJob(r scanner) (*MergeJob, error) {
	var j MergeJob
	var checks string
	err := r.Scan(&j.ID, &j.ApprovalID, &j.WorkItemID, &j.RepoID, &j.SourceSHA, &j.TargetRef, &j.TargetSHA, &j.MergeSHA, &j.State, &checks, &j.Error, &j.CreatedAt, &j.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	json.Unmarshal([]byte(checks), &j.Checks)
	return &j, nil
}

// StartMergeGate 为已批准的合并审批排队一次检查门合并，并在后台执行。
// 绑定批准时的源/目标 SHA；任一移动则中止，不合并。
func (c *Core) StartMergeGate(ctx context.Context, approvalID string) (*MergeJob, error) {
	c.jobMu.Lock()
	defer c.jobMu.Unlock()
	if c.jobsClosing || (c.JobContext != nil && c.JobContext.Err() != nil) {
		return nil, fmt.Errorf("%w: 服务正在退出，不接受新的合并检查", ErrConflict)
	}
	var status, payload, item, name, common string
	var repo int64
	err := c.St.R().QueryRowContext(ctx, `SELECT a.status,a.payload,COALESCE(a.work_item_id,''),r.id,r.name,r.common_dir FROM approvals a JOIN repos r ON r.id=a.repo_id WHERE a.id=? AND a.kind='merge'`, approvalID).
		Scan(&status, &payload, &item, &repo, &name, &common)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if status != "decided" {
		return nil, fmt.Errorf("%w: 需要先批准合并", ErrConflict)
	}
	checks := c.ChecksFor(name, common)
	valid := make([][]string, 0, len(checks))
	for _, argv := range checks {
		if len(argv) > 0 && strings.TrimSpace(argv[0]) != "" {
			valid = append(valid, append([]string(nil), argv...))
		}
	}
	checks = valid
	if len(checks) == 0 {
		return nil, fmt.Errorf("%w: 仓库 %s 未配置检查命令，不能自动合并；可继续使用复制指令", ErrBadRequest, name)
	}
	var b MergeBinding
	json.Unmarshal([]byte(payload), &b)
	if b.Stale != "" {
		return nil, fmt.Errorf("%w: 候选已失效（%s）", ErrConflict, b.Stale)
	}
	now := c.St.NowTS()
	j := &MergeJob{ID: "mj_" + shortID(), ApprovalID: approvalID, WorkItemID: item, RepoID: repo, SourceSHA: b.SourceHeadSHA, TargetRef: b.TargetRef, TargetSHA: b.TargetBaseSHA, State: "queued", Checks: []CheckResult{}, CreatedAt: now, UpdatedAt: now}
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		var active int
		tx.QueryRow(`SELECT COUNT(1) FROM merge_jobs WHERE approval_id=? AND state IN ('queued','running','passed')`, approvalID).Scan(&active)
		if active > 0 {
			return fmt.Errorf("%w: 该合并已有进行中的检查", ErrConflict)
		}
		if _, err := tx.Exec(`INSERT INTO merge_jobs(id,approval_id,work_item_id,repo_id,source_sha,target_ref,target_sha,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)`,
			j.ID, approvalID, item, repo, j.SourceSHA, j.TargetRef, j.TargetSHA, now, now); err != nil {
			return err
		}
		return store.Touch(tx, now, "merge_job", j.ID)
	})
	if err != nil {
		return nil, err
	}
	c.notify()
	c.jobs.Add(1)
	jobContext := c.JobContext
	if jobContext == nil {
		jobContext = context.Background()
	}
	go func() {
		defer c.jobs.Done()
		c.runMergeGate(jobContext, j.ID, common, checks)
	}()
	return j, nil
}

// WaitJobs 等待后台合并任务结束（测试与关闭服务时使用）。
func (c *Core) WaitJobs() { c.jobs.Wait() }

// CloseJobs prevents an in-flight HTTP request from registering work after shutdown starts.
func (c *Core) CloseJobs() {
	c.jobMu.Lock()
	c.jobsClosing = true
	c.jobMu.Unlock()
	c.jobs.Wait()
}

func tailText(b []byte) string {
	s := strings.TrimSpace(event.Redact(string(b)))
	r := []rune(s)
	if len(r) > 2000 {
		s = "…" + string(r[len(r)-2000:])
	}
	return s
}

// afterMergeJobRunning 仅供测试：在任务进入 running 后立即调用。
var afterMergeJobRunning func()

func (c *Core) runMergeGate(ctx context.Context, id, common string, checks [][]string) {
	fail := func(to, msg string) {
		// 服务停止时 git 子进程会被杀掉，报错不代表合并冲突；统一记为中止
		if ctx.Err() != nil && to == "failed" {
			to, msg = "aborted", "服务已停止，合并已中止："+msg
		}
		c.setJob(context.Background(), id, to, func(j *MergeJob) { j.Error = msg })
	}
	if err := c.setJob(ctx, id, "running", nil); err != nil {
		if ctx.Err() != nil {
			fail("aborted", "服务已停止，未执行检查")
		}
		return
	}
	if afterMergeJobRunning != nil {
		afterMergeJobRunning()
	}
	var j *MergeJob
	var err error
	// 已进入 running：读写任务记录不受服务取消影响，之后每条路径都必须写下终态
	if j, err = c.MergeJob(context.Background(), id); err != nil {
		fail("failed", "读取合并任务失败："+err.Error())
		return
	}
	// 1. 批准时的 SHA 必须仍是当前分支头
	var srcRef string
	c.St.R().QueryRowContext(ctx, `SELECT branch FROM work_items WHERE id=?`, j.WorkItemID).Scan(&srcRef)
	if gitx.RevParse(ctx, common, srcRef) != j.SourceSHA {
		fail("aborted", "源分支在批准后有新提交，已中止；请重新审批")
		return
	}
	if gitx.RevParse(ctx, common, j.TargetRef) != j.TargetSHA {
		fail("aborted", "目标分支在批准后前进，已中止；请重建候选")
		return
	}
	// 2. 在临时集成 worktree 中合并（不触碰用户的工作目录）
	dir := c.worktreeDir(common, "merge", "steward-merge-"+id)
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		fail("failed", err.Error())
		return
	}
	if _, err := gitWrite(ctx, common, "--git-dir="+common, "worktree", "add", "--detach", dir, j.TargetSHA); err != nil {
		fail("failed", "创建集成 worktree 失败："+err.Error())
		return
	}
	defer gitWrite(context.Background(), common, "--git-dir="+common, "worktree", "remove", "--force", dir)
	mergeSHA := j.SourceSHA
	if !gitx.IsAncestor(ctx, common, j.TargetSHA, j.SourceSHA) {
		msg := fmt.Sprintf("Merge %s (%s) via Session Steward checked merge", srcRef, j.WorkItemID)
		if _, err := gitWrite(ctx, dir, "merge", "--no-ff", "--no-edit", "-m", msg, j.SourceSHA); err != nil {
			fail("failed", "合并有冲突或无法提交（仓库需配置提交身份）："+err.Error())
			return
		}
		if mergeSHA, err = gitWrite(ctx, dir, "rev-parse", "HEAD"); err != nil {
			fail("failed", err.Error())
			return
		}
	} else if _, err := gitWrite(ctx, dir, "checkout", "-q", "--detach", j.SourceSHA); err != nil {
		fail("failed", err.Error())
		return
	}
	// 3. 依次运行检查（argv，不经过 shell）
	timeout := c.CheckTimeout
	if timeout == 0 {
		timeout = 15 * time.Minute
	}
	var results []CheckResult
	for _, argv := range checks {
		if len(argv) == 0 {
			continue
		}
		cctx, cancel := context.WithTimeout(ctx, timeout)
		cmd := exec.CommandContext(cctx, argv[0], argv[1:]...)
		configureChildProcess(cmd)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "STEWARD_CHECK=1", "GIT_TERMINAL_PROMPT=0")
		cmd.WaitDelay = time.Second
		var out tailBuffer
		cmd.Stdout, cmd.Stderr = &out, &out
		start := time.Now()
		err := cmd.Run()
		cancel()
		code := 0
		if err != nil {
			code = -1
			var ee *exec.ExitError
			if errors.As(err, &ee) {
				code = ee.ExitCode()
			}
			if cctx.Err() == context.DeadlineExceeded {
				out.WriteString("\n[Steward] 检查超时")
			}
		}
		displayArgv := make([]string, len(argv))
		for i, a := range argv {
			displayArgv[i] = event.Redact(a)
		}
		results = append(results, CheckResult{Argv: displayArgv, ExitCode: code, Seconds: time.Since(start).Seconds(), Tail: tailText(out.Bytes())})
		if code != 0 {
			state := "failed"
			if ctx.Err() != nil {
				state = "aborted"
			}
			c.setJob(context.Background(), id, state, func(j *MergeJob) {
				j.Checks, j.MergeSHA, j.Error = results, mergeSHA, fmt.Sprintf("检查未通过或已中止：%s 退出码 %d", strings.Join(displayArgv, " "), code)
			})
			return
		}
		// 检查的必须是将要合并的同一候选；构建产物可未跟踪，源码和 HEAD 不能改变。
		head, headErr := gitWrite(ctx, dir, "rev-parse", "HEAD")
		dirty, dirtyErr := gitWrite(ctx, dir, "status", "--porcelain", "--untracked-files=no")
		if headErr != nil || dirtyErr != nil || head != mergeSHA || dirty != "" {
			c.setJob(context.Background(), id, "aborted", func(j *MergeJob) {
				j.Checks = results
				j.Error = "检查命令改变了候选源码或HEAD，不能将此结果用于原候选"
			})
			return
		}
	}
	if ctx.Err() != nil {
		c.setJob(context.Background(), id, "aborted", func(j *MergeJob) {
			j.Checks, j.MergeSHA, j.Error = results, mergeSHA, "服务已停止，检查已通过但未合并"
		})
		return
	}
	if err := c.setJob(context.Background(), id, "passed", func(j *MergeJob) { j.Checks, j.MergeSHA = results, mergeSHA }); err != nil {
		fail("failed", "记录检查结果失败："+err.Error())
		return
	}
	func() {
		c.mergeMu.Lock()
		defer c.mergeMu.Unlock()
		// 4. 原子更新本地目标分支（比较后交换）；只在批准仍有效时进行
		if ctx.Err() != nil {
			fail("aborted", "服务已停止，未合并")
			return
		}
		if gitx.RevParse(ctx, common, srcRef) != j.SourceSHA || gitx.RevParse(ctx, common, j.TargetRef) != j.TargetSHA {
			fail("aborted", "检查期间源分支或目标分支发生变化，未合并；请重新审批")
			return
		}
		var status string
		c.St.R().QueryRowContext(ctx, `SELECT status FROM approvals WHERE id=?`, j.ApprovalID).Scan(&status)
		if status != "decided" {
			fail("aborted", "批准已撤回或失效，检查通过但未合并")
			return
		}
		if err := advanceBranch(ctx, common, j.TargetRef, j.TargetSHA, mergeSHA); err != nil {
			fail("aborted", "检查通过，但更新目标分支失败："+err.Error())
			return
		}
		c.setJob(context.Background(), id, "merged", nil)
		// Git 更新已成功；在释放互斥锁前确认审批，撤回只能得到“已合并”冲突。
		now := c.St.NowTS()
		c.St.Tx(context.Background(), func(tx *sql.Tx) error {
			members, err := mergeMembers(tx, j.ApprovalID)
			if err != nil {
				return err
			}
			// 同一 Git 操作的所有工作项必须在释放锁前对账；这不代表用户验收。
			for _, m := range members {
				if _, err = tx.Exec(`UPDATE approvals SET status='confirmed',confirmed_at=?,close_reason='merged_verified' WHERE id=?`, now, m.id); err != nil {
					return err
				}
				if _, err = tx.Exec(`UPDATE work_items SET merge_state='merged',updated_at=? WHERE id=?`, now, m.item); err != nil {
					return err
				}
				if err = store.Touch(tx, now, "approval", m.id); err != nil {
					return err
				}
			}
			return nil
		})
	}()
	c.ScanMerges(context.Background()) // 在释放锁后再次按 Git 事实对账。
}

// advanceBranch 把 ref 从 old 移到 new。若该分支在某个 worktree 中检出，
// 要求该目录没有已跟踪改动，并用 --ff-only 更新，避免工作区与分支不一致。
func advanceBranch(ctx context.Context, common, ref, old, new string) error {
	list, err := gitWrite(ctx, common, "--git-dir="+common, "worktree", "list", "--porcelain")
	if err != nil {
		return err
	}
	var wt string
	var cur string
	for _, line := range strings.Split(list, "\n") {
		if strings.HasPrefix(line, "worktree ") {
			cur = strings.TrimPrefix(line, "worktree ")
		}
		if line == "branch refs/heads/"+ref {
			wt = cur
		}
	}
	if wt == "" {
		_, err := gitWrite(ctx, common, "--git-dir="+common, "update-ref", "-m", "steward checked merge", "refs/heads/"+ref, new, old)
		return err
	}
	if head, _ := gitWrite(ctx, wt, "rev-parse", "HEAD"); head != old {
		return fmt.Errorf("%s 的工作目录 HEAD 已变化", ref)
	}
	st, err := gitWrite(ctx, wt, "status", "--porcelain", "--untracked-files=no")
	if err != nil {
		return err
	}
	if st != "" {
		return fmt.Errorf("%s 检出目录 %s 有未提交改动，未更新；提交或暂存后重试", ref, wt)
	}
	_, err = gitWrite(ctx, wt, "merge", "--ff-only", "-q", new)
	return err
}

func (c *Core) MergeJob(ctx context.Context, id string) (*MergeJob, error) {
	return readJob(c.St.R().QueryRowContext(ctx, `SELECT `+jobCols+` FROM merge_jobs WHERE id=?`, id))
}

func (c *Core) readMergeJobs(tx *sql.Tx) ([]MergeJob, error) {
	rows, err := tx.Query(`SELECT ` + jobCols + ` FROM merge_jobs ORDER BY created_at DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MergeJob
	for rows.Next() {
		j, err := readJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *j)
	}
	return out, rows.Err()
}

// RecoverMergeJobs：服务重启时中断的任务记为中止（不在未知状态下继续合并）。
func (c *Core) RecoverMergeJobs(ctx context.Context) error {
	now := c.St.NowTS()
	return c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`UPDATE merge_jobs SET state='aborted', error='服务重启，检查被中断，未合并', updated_at=? WHERE state IN ('queued','running','passed')`, now)
		return err
	})
}
