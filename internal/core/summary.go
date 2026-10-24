package core

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

// AISummary 是一条 AI 生成的摘要。它是推断，不是 Agent 自述、测试结果或用户验收。
type AISummary struct {
	WorkItemID string `json:"work_item_id"`
	Text       string `json:"text"`
	BasisHash  string `json:"basis_hash"`
	Current    bool   `json:"current"` // 输入材料自生成后未变化
	CreatedAt  string `json:"created_at"`
}

const summaryPrompt = `你是项目简报助手。下面是某个工作项的材料，来自 Agent 自述的简报、功能清单和 Git 记录。
请用简体中文写不超过 4 句话：现在做到哪、卡在哪、下一步谁做什么。
只依据材料；材料没有说明的写“材料未说明”，不要补充或猜测测试结果、验收结论。不要输出标题或列表。

材料：
`

// SummaryAllowed：只有 Owner 在配置中列出的仓库才能把材料交给摘要命令。
func (c *Core) SummaryAllowed(name, common string) bool {
	if len(c.SummaryCmd) == 0 {
		return false
	}
	for _, r := range c.SummaryRepos {
		if r == common {
			return true
		}
		if r == name {
			var count int
			if err := c.St.R().QueryRow(`SELECT COUNT(*) FROM repos WHERE name=?`, name).Scan(&count); err == nil && count == 1 {
				return true
			}
		}
	}
	return false
}

func basisHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8])
}

// summaryBasis 复用交接包材料（简报、功能、Git 元数据），不含对话正文。
func (c *Core) summaryBasis(ctx context.Context, item string) (string, error) {
	pkg, _, err := c.BuildHandoff(ctx, HandoffInput{WorkItemID: item})
	if errors.Is(err, ErrBadRequest) {
		// 没有分支时只用简报
		snap, serr := c.Snapshot(ctx)
		if serr != nil {
			return "", serr
		}
		var b strings.Builder
		for _, w := range snap.WorkItems {
			if w.ID != item {
				continue
			}
			fmt.Fprintf(&b, "# %s（%s）\n状态：%s\n", w.Title, w.ID, w.Status)
			if w.Brief != nil {
				for _, k := range BriefFields {
					if v := w.Brief.Fields[k]; v != nil && v.Text != "" {
						fmt.Fprintf(&b, "- %s：%s（%s）\n", k, v.Text, v.Kind)
					}
				}
			}
		}
		for _, w := range snap.WorkItems {
			if w.ID != item {
				continue
			}
			appendSessionMaterial(&b, &w)
			for _, f := range snap.Features {
				for _, id := range f.WorkItemIDs {
					if id != item {
						continue
					}
					material, _ := json.Marshal(f)
					fmt.Fprintf(&b, "\n功能记录（Agent 自述，用户验收单独标注）：%s\n", material)
					break
				}
			}
		}
		return event.Redact(b.String()), nil
	}
	if err != nil {
		return "", err
	}
	// 去掉面向接手 Agent 的说明段落，只留材料
	if i := strings.Index(pkg, "\n## 接手方式"); i >= 0 {
		pkg = pkg[:i]
	}
	return pkg, nil
}

// GenerateSummary 运行配置的本机命令生成摘要（材料经 stdin 传入，不经 shell）。
func (c *Core) GenerateSummary(ctx context.Context, item string) (*AISummary, error) {
	c.jobMu.Lock()
	if c.jobsClosing || (c.JobContext != nil && c.JobContext.Err() != nil) {
		c.jobMu.Unlock()
		return nil, fmt.Errorf("%w: 服务正在退出，不能生成摘要", ErrConflict)
	}
	c.jobs.Add(1)
	c.jobMu.Unlock()
	defer c.jobs.Done()
	var name, common string
	err := c.St.R().QueryRowContext(ctx, `SELECT r.name,r.common_dir FROM work_items w JOIN repos r ON r.id=w.repo_id WHERE w.id=?`, item).Scan(&name, &common)
	if errors.Is(err, sql.ErrNoRows) {
		if c.WorkItemExists(ctx, item) {
			return nil, fmt.Errorf("%w: 工作项未关联项目", ErrBadRequest)
		}
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if !c.SummaryAllowed(name, common) {
		return nil, fmt.Errorf("%w: 未对项目 %s 开启 AI 摘要（需在 summary_repos 中列出）", ErrBadRequest, name)
	}
	basis, err := c.summaryBasis(ctx, item)
	if err != nil {
		return nil, err
	}
	run := c.SummaryRun
	if run == nil {
		run = func(ctx context.Context, argv []string, stdin string) (string, error) {
			cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
			configureChildProcess(cmd)
			cmd.Stdin = strings.NewReader(stdin)
			var out, errb tailBuffer
			cmd.WaitDelay = time.Second
			cmd.Stdout, cmd.Stderr = &out, &errb
			if err := cmd.Run(); err != nil {
				return "", fmt.Errorf("%v: %s", err, strings.TrimSpace(event.Redact(errb.String())))
			}
			return out.String(), nil
		}
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if c.JobContext != nil {
		stop := context.AfterFunc(c.JobContext, cancel)
		defer stop()
	}
	text, err := run(cctx, c.SummaryCmd, summaryPrompt+basis)
	if err != nil {
		return nil, fmt.Errorf("摘要命令失败：%w", err)
	}
	text = strings.TrimSpace(event.Redact(text))
	if r := []rune(text); len(r) > 600 {
		text = string(r[:600]) + "…"
	}
	if text == "" || !utf8.ValidString(text) {
		return nil, errors.New("摘要命令没有返回可用文本")
	}
	now := c.St.NowTS()
	s := &AISummary{WorkItemID: item, Text: text, BasisHash: basisHash(basis), Current: true, CreatedAt: now}
	currentBasis, basisErr := c.summaryBasis(ctx, item)
	s.Current = basisErr == nil && basisHash(currentBasis) == s.BasisHash
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.Exec(`INSERT INTO ai_summaries(work_item_id,text,basis_hash,command,created_at) VALUES(?,?,?,?,?)`, item, text, s.BasisHash, c.SummaryCmd[0], now); err != nil {
			return err
		}
		return store.Touch(tx, now, "work_item", item)
	})
	if err != nil {
		return nil, err
	}
	c.notify()
	return s, nil
}

// LatestSummary 返回最近一条摘要，并检查材料是否在生成后变化。
func (c *Core) LatestSummary(ctx context.Context, item string) (*AISummary, error) {
	var s AISummary
	err := c.St.R().QueryRowContext(ctx, `SELECT work_item_id,text,basis_hash,created_at FROM ai_summaries WHERE work_item_id=? ORDER BY id DESC LIMIT 1`, item).
		Scan(&s.WorkItemID, &s.Text, &s.BasisHash, &s.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if basis, err := c.summaryBasis(ctx, item); err == nil {
		s.Current = basisHash(basis) == s.BasisHash
	}
	return &s, nil
}
