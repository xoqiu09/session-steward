package core

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
)

// HandoffFile 是交接包在接手 worktree 中的位置（只放在 .git 内部，不会被提交）。
const HandoffFile = "steward-handoff.md"

type HandoffInput struct {
	WorkItemID  string `json:"work_item_id"`
	ToAgent     string `json:"to_agent"`
	FromSession int64  `json:"from_session_id"`
	Note        string `json:"note"`       // Owner 补充说明
	SourceSHA   string `json:"source_sha"` // 预览时的候选；变化后必须重新预览。
}

type Handoff struct {
	ID            string `json:"id"`
	WorkItemID    string `json:"work_item_id"`
	FromSessionID *int64 `json:"from_session_id"`
	FromProvider  string `json:"from_provider"`
	ToAgent       string `json:"to_agent"`
	SourceBranch  string `json:"source_branch"`
	SourceSHA     string `json:"source_sha"`
	Package       string `json:"package"`
	ManagedID     string `json:"managed_id"`
	State         string `json:"state"`
	CreatedAt     string `json:"created_at"`
}

// handoffSource 找到工作项当前代码所在分支：显式指定的会话 → 工作项分支 → 最近的托管会话分支。
func (c *Core) handoffSource(ctx context.Context, item string, from int64) (repo int64, common, branch, sha, provider string, sid int64, err error) {
	var title, itemBranch string
	var rid sql.NullInt64
	err = c.St.R().QueryRowContext(ctx, `SELECT title,branch,repo_id FROM work_items WHERE id=?`, item).Scan(&title, &itemBranch, &rid)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", "", "", "", 0, ErrNotFound
	}
	if err != nil {
		return
	}
	if !rid.Valid {
		err = fmt.Errorf("%w: 工作项未关联 Git 项目", ErrBadRequest)
		return
	}
	repo = rid.Int64
	if err = c.St.R().QueryRowContext(ctx, `SELECT common_dir FROM repos WHERE id=? AND is_git=1`, repo).Scan(&common); err != nil {
		err = fmt.Errorf("%w: 工作项未关联 Git 项目", ErrBadRequest)
		return
	}
	// 来源会话：显式指定须属于该工作项；否则取最近的关联会话
	q := `SELECT s.id,s.provider,s.branch FROM runs r JOIN sessions s ON s.id=r.session_id WHERE r.work_item_id=? AND r.outcome<>'attribution_reverted'`
	args := []any{item}
	if from != 0 {
		q += ` AND s.id=?`
		args = append(args, from)
	}
	q += ` ORDER BY r.started_at DESC LIMIT 1`
	var sBranch string
	if e := c.St.R().QueryRowContext(ctx, q, args...).Scan(&sid, &provider, &sBranch); e != nil {
		if from != 0 {
			err = fmt.Errorf("%w: 该会话不属于此工作项", ErrBadRequest)
			return
		}
	}
	var mBranch string
	c.St.R().QueryRowContext(ctx, `SELECT branch FROM managed_sessions WHERE work_item_id=? ORDER BY created_at DESC LIMIT 1`, item).Scan(&mBranch)
	for _, b := range []string{sBranch, itemBranch, mBranch} {
		if b != "" && distinctBranch(b) {
			if s := gitx.RevParse(ctx, common, b); s != "" {
				return repo, common, b, s, provider, sid, nil
			}
		}
	}
	err = fmt.Errorf("%w: 找不到该工作项的分支，无法交接代码", ErrBadRequest)
	return
}

// BuildHandoff 生成交接包文本。只用简报、功能清单与 Git 元数据；不读取对话正文。
func (c *Core) BuildHandoff(ctx context.Context, in HandoffInput) (string, *Handoff, error) {
	repo, common, branch, sha, provider, sid, err := c.handoffSource(ctx, in.WorkItemID, in.FromSession)
	if err != nil {
		return "", nil, err
	}
	snap, err := c.Snapshot(ctx)
	if err != nil {
		return "", nil, err
	}
	var w *WorkItem
	for i := range snap.WorkItems {
		if snap.WorkItems[i].ID == in.WorkItemID {
			w = &snap.WorkItems[i]
		}
	}
	if w == nil {
		return "", nil, ErrNotFound
	}
	var target string
	c.St.R().QueryRowContext(ctx, `SELECT target_ref FROM repos WHERE id=?`, repo).Scan(&target)
	var b strings.Builder
	line := func(f string, a ...any) { fmt.Fprintf(&b, f+"\n", a...) }
	line("# 交接：%s（%s）", w.Title, w.ID)
	line("")
	line("这份交接包由 Session Steward 根据工作项简报、功能清单和 Git 记录生成。内容是上一位 Agent 的自述，不是独立校验，也不代表用户已验收。")
	line("")
	line("## 代码位置")
	line("- 你的 worktree 从 `%s`（%s）新建分支，包含上一位的全部已提交改动。", branch, sha[:min(12, len(sha))])
	if t := gitx.RevParse(ctx, common, target); t != "" {
		if n := gitx.Ahead(ctx, common, t, sha); n > 0 {
			line("- 相对 `%s` 领先 %d 个提交：%s", target, n, gitx.DiffStat(ctx, common, t, sha))
		}
		if log, err := gitx.Run(ctx, common, "log", "--oneline", "-n", "15", t+".."+sha); err == nil && log != "" {
			line("")
			line("```")
			line("%s", event.Redact(log))
			line("```")
		}
	}
	line("- 上一位 worktree 中未提交的改动不会带过来；如有需要请让 Owner 确认。")
	if w.Acceptance != "" {
		line("")
		line("## 验收条件")
		line("%s", clip(w.Acceptance))
	}
	if w.Brief != nil {
		line("")
		line("## 最近简报")
		labels := []struct{ k, l string }{{"goal", "目标"}, {"summary", "结论"}, {"stage", "阶段"}, {"progress", "进展"}, {"blocker", "卡点"}, {"next", "下一步"}, {"next_owner", "下一步负责人"}}
		for _, f := range labels {
			if v := w.Brief.Fields[f.k]; v != nil && v.Text != "" {
				src := "Agent 自述"
				if v.Kind == "user" {
					src = "用户填写"
				}
				line("- %s：%s（%s，%s）", f.l, v.Text, src, v.At)
			}
		}
	}
	var feats []ProjectFeature
	for _, f := range snap.Features {
		for _, id := range f.WorkItemIDs {
			if id == w.ID {
				feats = append(feats, f)
				break
			}
		}
	}
	if len(feats) > 0 {
		sort.Slice(feats, func(i, j int) bool { return feats[i].ID < feats[j].ID })
		line("")
		line("## 核心功能（Agent 回报）")
		for _, f := range feats {
			acc := ""
			if f.Accepted {
				acc = "，用户已验收"
			}
			line("- `%s` %s：实现 %s，验证 %s%s；候选 %s", f.ID, f.Title, f.Implementation, f.Validation, acc, nz(f.Candidate, "未知"))
			for _, p := range f.Contributions {
				value := func(s *string) string {
					if s == nil {
						return "未回报"
					}
					return *s
				}
				line("  - %s 会话 #%d：候选 %s；卡点：%s；下一步负责人 %s：%s；验证依据：%s", p.Provider, p.SessionID, nz(p.Candidate, "未知"), value(p.Blocker), value(p.NextOwner), value(p.Next), nz(p.Evidence, "未回报"))
			}
		}
		line("沿用这些功能 ID 回报，不要新建同义功能。")
	}
	appendSessionMaterial(&b, w)
	if note := clip(in.Note); note != "" {
		line("")
		line("## Owner 补充")
		line("%s", note)
	}
	line("")
	line("## 接手方式")
	line("- 先阅读仓库的 AGENTS.md 等说明，核对上述进展是否属实，再继续。")
	line("- 本会话已关联工作项 %s；进展用 steward-hook report 回报，完成用 deliver。", w.ID)
	h := &Handoff{ID: "ho_" + shortID(), WorkItemID: w.ID, FromProvider: provider, ToAgent: in.ToAgent, SourceBranch: branch, SourceSHA: sha}
	if sid != 0 {
		h.FromSessionID = &sid
	}
	h.Package = event.Redact(b.String())
	return h.Package, h, nil
}

// StartHandoff 生成交接包，在新的托管会话中启动接手 Agent，并把交接包作为首条提示传入。
// 来源会话保持原样（不自动停止），工作项不变；交接本身不代表上一位已完成。
func (c *Core) StartHandoff(ctx context.Context, in HandoffInput) (*Handoff, *ManagedSession, error) {
	if _, ok := c.Agents[in.ToAgent]; !ok {
		return nil, nil, fmt.Errorf("%w: 未配置的 Agent %q", ErrBadRequest, in.ToAgent)
	}
	pkg, h, err := c.BuildHandoff(ctx, in)
	if err != nil {
		return nil, nil, err
	}
	if in.SourceSHA != "" && in.SourceSHA != h.SourceSHA {
		return nil, nil, fmt.Errorf("%w: 预览后源分支已变化，请重新预览交接", ErrConflict)
	}
	var repo int64
	var title string
	c.St.R().QueryRowContext(ctx, `SELECT repo_id,title FROM work_items WHERE id=?`, in.WorkItemID).Scan(&repo, &title)
	prompt := fmt.Sprintf("你在接手工作项 %s（%s）。交接包在 .git 目录下的 %s（路径见 `git rev-parse --git-dir`），也附在下面。先核对再继续。\n\n%s", in.WorkItemID, title, HandoffFile, pkg)
	if len(prompt) > 16<<10 {
		prompt = fmt.Sprintf("你在接手工作项 %s。请先用 git rev-parse --git-dir 找到私有Git目录，读取其中的 %s 完整交接包，核对仓库 AGENTS.md 后再继续。", in.WorkItemID, HandoffFile)
	}
	m, err := c.launch(ctx, LaunchInput{RepoID: repo, Agent: in.ToAgent, Title: title}, launchOpts{
		item: in.WorkItemID, baseSHA: h.SourceSHA, prompt: prompt,
		inTx: func(tx *sql.Tx, m *ManagedSession, now string) error {
			h.ManagedID, h.State, h.CreatedAt = m.ID, "launched", now
			_, err := tx.Exec(`INSERT INTO handoffs(id,work_item_id,from_session_id,from_provider,to_agent,source_branch,source_sha,package,managed_id,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
				h.ID, h.WorkItemID, h.FromSessionID, h.FromProvider, h.ToAgent, h.SourceBranch, h.SourceSHA, h.Package, m.ID, h.State, now)
			if err != nil {
				return err
			}
			// 交接包写入 worktree 的私有 git 目录，Agent 可读但不会进入提交
			gd, err := gitWrite(ctx, m.Worktree, "rev-parse", "--absolute-git-dir")
			if err != nil {
				return err
			}
			// 不改简报：负责人等字段由接手 Agent 自己回报，交接记录单独保存
			return os.WriteFile(filepath.Join(gd, HandoffFile), []byte(pkg), 0o600)
		},
	})
	if err != nil {
		return nil, nil, err
	}
	if m.State == "failed" {
		c.St.Tx(ctx, func(tx *sql.Tx) error {
			_, err := tx.Exec(`UPDATE handoffs SET state='failed' WHERE id=?`, h.ID)
			return err
		})
		h.State = "failed"
	}
	c.notify()
	return h, m, nil
}

func (c *Core) readHandoffs(tx *sql.Tx) ([]Handoff, error) {
	rows, err := tx.Query(`SELECT id,work_item_id,from_session_id,from_provider,to_agent,source_branch,source_sha,managed_id,state,created_at FROM handoffs ORDER BY created_at DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Handoff
	for rows.Next() {
		var h Handoff
		var sid sql.NullInt64
		if err := rows.Scan(&h.ID, &h.WorkItemID, &sid, &h.FromProvider, &h.ToAgent, &h.SourceBranch, &h.SourceSHA, &h.ManagedID, &h.State, &h.CreatedAt); err != nil {
			return nil, err
		}
		if sid.Valid {
			v := sid.Int64
			h.FromSessionID = &v
		}
		out = append(out, h)
	}
	return out, rows.Err()
}
