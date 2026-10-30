package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/store"
)

// MergeBinding 是一次合并审批绑定的四元组。
type MergeBinding struct {
	RepoID        int64  `json:"repo_id"`
	SourceRef     string `json:"source_ref"`
	SourceHeadSHA string `json:"source_head_sha"`
	TargetRef     string `json:"target_ref"`
	TargetBaseSHA string `json:"target_base_sha"`
	Ahead         int    `json:"ahead"`
	DiffStat      string `json:"diffstat"`
	Stale         string `json:"stale,omitempty"` // source_moved | target_moved
	CopiedAt      string `json:"copied_at,omitempty"`
}

type repoRow struct {
	id        int64
	commonDir string
	target    string
}

func (c *Core) repos(ctx context.Context) ([]repoRow, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT id, common_dir, target_ref FROM repos WHERE is_git=1 AND id NOT IN (SELECT repo_id FROM repo_aliases)
	 AND NOT EXISTS (SELECT 1 FROM meta WHERE k='repo_archive:'||repos.id AND v<>'')`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []repoRow
	for rows.Next() {
		var r repoRow
		if err := rows.Scan(&r.id, &r.commonDir, &r.target); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ScanMerges 是只读 Git 扫描：
//   - 待验收/已完成且有分支、领先目标分支的工作项 → 生成合并审批（绑定当前 SHA）
//   - 已有审批但源或目标移动 → 标记失效（源移动则作废，目标移动则需重建候选）
//   - 目标分支已包含源 SHA → 工作项 merge_state=merged（唯一的“已合并”来源）
func (c *Core) ScanMerges(ctx context.Context) error {
	c.mergeMu.Lock()
	defer c.mergeMu.Unlock()
	repos, err := c.repos(ctx)
	if err != nil {
		return err
	}
	for _, r := range repos {
		if err := c.scanRepo(ctx, r); err != nil {
			continue // 单个仓库失败不影响其他仓库
		}
	}
	return nil
}

type itemRow struct {
	id, branch, status, merge string
	binding                   string
}

func (c *Core) mergeItems(ctx context.Context, repo int64) ([]itemRow, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT id, branch, status, merge_state,
	 COALESCE((SELECT payload FROM approvals a WHERE a.work_item_id=w.id AND a.kind='merge' AND a.status IN ('pending','decided') ORDER BY a.created_at DESC,a.id DESC LIMIT 1),'')
	 FROM work_items w WHERE repo_id=? AND needs_merge=1 AND branch<>'' AND merge_state<>'merged' AND status<>'abandoned'`, repo)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []itemRow
	for rows.Next() {
		var it itemRow
		if err := rows.Scan(&it.id, &it.branch, &it.status, &it.merge, &it.binding); err != nil {
			return nil, err
		}
		items = append(items, it)
	}
	return items, rows.Err()
}

func (c *Core) mergeSource(ctx context.Context, dir string, it itemRow) string {
	if src := gitx.RevParse(ctx, dir, it.branch); src != "" {
		return src
	}
	var b MergeBinding
	if json.Unmarshal([]byte(it.binding), &b) == nil && b.SourceRef == it.branch && b.SourceHeadSHA != "" {
		return gitx.RevParse(ctx, dir, b.SourceHeadSHA)
	}
	return ""
}

func (c *Core) scanRepo(ctx context.Context, r repoRow) error {
	dir := r.commonDir
	targetSHA := gitx.RevParse(ctx, dir, r.target)
	remoteTarget, remoteMethod := c.remoteMergeTarget(ctx, r)
	if targetSHA == "" && remoteTarget == "" {
		return fmt.Errorf("目标分支 %s 不存在", r.target)
	}
	items, err := c.mergeItems(ctx, r.id)
	if err != nil {
		return err
	}

	type plan struct {
		it       itemRow
		srcSHA   string
		merged   bool
		ahead    int
		diffstat string
		evidence *MergeEvidence
	}
	var plans []plan
	for _, it := range items {
		src := c.mergeSource(ctx, dir, it)
		if src == "" {
			continue
		}
		p := plan{it: it, srcSHA: src}
		if targetSHA != "" && gitx.IsAncestor(ctx, dir, src, targetSHA) {
			p.merged = true
			p.evidence = &MergeEvidence{SourceSHA: src, TargetRef: r.target, TargetSHA: targetSHA, Method: "local_git"}
		} else if remoteTarget != "" && gitx.IsAncestor(ctx, dir, src, remoteTarget) {
			p.merged = true
			p.evidence = &MergeEvidence{SourceSHA: src, TargetRef: r.target, TargetSHA: remoteTarget, Method: remoteMethod}
		} else if proof := c.prMergeEvidence(ctx, r, it.id, src, remoteTarget); proof != nil {
			p.merged = true
			p.evidence = proof
		} else if targetSHA == "" {
			continue // Can observe an external merge without creating an unexecutable local candidate.
		} else {
			p.ahead = gitx.Ahead(ctx, dir, targetSHA, src)
			p.diffstat = gitx.DiffStat(ctx, dir, targetSHA, src)
		}
		plans = append(plans, p)
	}

	now := c.St.NowTS()
	err = c.St.Tx(ctx, func(tx *sql.Tx) error {
		for _, p := range plans {
			// 打开的合并审批
			var aid, status, payload string
			err := tx.QueryRow(`SELECT id, status, payload FROM approvals WHERE kind='merge' AND work_item_id=? AND status IN ('pending','decided') ORDER BY created_at DESC LIMIT 1`, p.it.id).
				Scan(&aid, &status, &payload)
			hasOpen := err == nil
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if p.merged {
				p.evidence.CheckedAt = now
				eb, _ := json.Marshal(p.evidence)
				if _, err := tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, "merge_verified:"+p.it.id, string(eb)); err != nil {
					return err
				}
				if _, err := tx.Exec(`UPDATE work_items SET merge_state='merged', updated_at=? WHERE id=?`, now, p.it.id); err != nil {
					return err
				}
				if _, err := tx.Exec(`UPDATE approvals SET status='confirmed', confirmed_at=?, close_reason='merged_verified' WHERE kind='merge' AND work_item_id=? AND status IN ('pending','decided')`, now, p.it.id); err != nil {
					return err
				}
				store.Touch(tx, now, "work_item", p.it.id)
				continue
			}
			ready := p.it.status == "review" || p.it.status == "done"
			if hasOpen {
				var b MergeBinding
				json.Unmarshal([]byte(payload), &b)
				switch {
				case b.SourceHeadSHA != p.srcSHA:
					// 源分支有新提交：旧审批作废，按新 SHA 重新排队
					tx.Exec(`UPDATE approvals SET status='expired', close_reason='source_moved', closed_at=? WHERE id=?`, now, aid)
					hasOpen = false
					status = "" // 旧批准已作废，不能再影响 merge_state
				case b.TargetBaseSHA != targetSHA && b.Stale == "":
					b.Stale = "target_moved"
					nb, _ := json.Marshal(b)
					tx.Exec(`UPDATE approvals SET payload=? WHERE id=?`, string(nb), aid)
				}
				store.Touch(tx, now, "approval", aid)
			}
			if !hasOpen && ready && p.ahead > 0 {
				b := MergeBinding{RepoID: r.id, SourceRef: p.it.branch, SourceHeadSHA: p.srcSHA, TargetRef: r.target,
					TargetBaseSHA: targetSHA, Ahead: p.ahead, DiffStat: p.diffstat}
				var m map[string]any
				bb, _ := json.Marshal(b)
				json.Unmarshal(bb, &m)
				if err := insertApproval(tx, approvalRow{kind: "merge", workItem: p.it.id, repoID: r.id, preview: p.it.branch, handleable: true, payload: m}, now); err != nil {
					return err
				}
				hasOpen = true
				status = "pending"
			}
			ms := "not_ready"
			if hasOpen {
				ms = "awaiting"
				if status == "decided" {
					ms = "approved"
				}
			}
			if ms != p.it.merge {
				tx.Exec(`UPDATE work_items SET merge_state=?, updated_at=? WHERE id=?`, ms, now, p.it.id)
				store.Touch(tx, now, "work_item", p.it.id)
			}
		}
		return nil
	})
	c.notify()
	return err
}

// ApproveMerge 批准合并。必须提交面板看到的源/目标 SHA；与当前记录不一致则拒绝。
// 批准只是一个事实；之后复制指令、实际合并分别记录，“已合并”只由 ScanMerges 验证。
func (c *Core) ApproveMerge(ctx context.Context, id, sourceSHA, targetSHA string) error {
	c.mergeMu.Lock()
	defer c.mergeMu.Unlock()
	now := c.St.NowTS()
	err := c.panelTx(ctx, func(tx *sql.Tx) error {
		members, err := mergeMembers(tx, id)
		if err != nil {
			return err
		}
		for _, m := range members {
			if m.id == id && m.status != "pending" {
				return ErrConflict
			}
			if m.binding.SourceHeadSHA != sourceSHA || m.binding.TargetBaseSHA != targetSHA {
				return ErrMismatch
			}
			if m.binding.Stale != "" {
				return fmt.Errorf("%w: 目标分支已前进，需要重建候选", ErrConflict)
			}
		}
		for _, m := range members {
			if m.status == "decided" {
				continue
			}
			if _, err = tx.Exec(`UPDATE approvals SET status='decided',decision='approve',decided_at=? WHERE id=?`, now, m.id); err != nil {
				return err
			}
			if _, err = tx.Exec(`UPDATE work_items SET merge_state='approved',updated_at=? WHERE id=?`, now, m.item); err != nil {
				return err
			}
			if err = store.Touch(tx, now, "approval", m.id); err != nil {
				return err
			}
		}
		return nil
	})
	c.notify()
	if err == nil && c.AutoMerge {
		if _, gerr := c.StartMergeGate(ctx, id); gerr != nil && !errors.Is(gerr, ErrBadRequest) {
			return gerr
		}
	}
	return err
}

// RejectMerge rejects the shared Git operation and returns its work items to implementation.
func (c *Core) RejectMerge(ctx context.Context, id, reason string) error {
	c.mergeMu.Lock()
	defer c.mergeMu.Unlock()
	now := c.St.NowTS()
	err := c.panelTx(ctx, func(tx *sql.Tx) error {
		members, err := mergeMembers(tx, id)
		if errors.Is(err, ErrNotFound) {
			return ErrConflict
		}
		if err != nil {
			return err
		}
		for _, m := range members {
			if _, err = tx.Exec(`UPDATE approvals SET status='cancelled',decision='reject',close_reason=?,closed_at=? WHERE id=?`, nz(reason, "rejected"), now, m.id); err != nil {
				return err
			}
			if _, err = tx.Exec(`UPDATE work_items SET status=CASE WHEN status IN ('done','abandoned') THEN status ELSE 'in_progress' END,merge_state='not_ready',updated_at=? WHERE id=?`, now, m.item); err != nil {
				return err
			}
			if err = store.Touch(tx, now, "approval", m.id); err != nil {
				return err
			}
		}
		return nil
	})
	c.notify()
	return err
}

// MergeInstruction copies one instruction; neither copying nor approval executes Git.
func (c *Core) MergeInstruction(ctx context.Context, id string) (string, error) {
	var text string
	now := c.St.NowTS()
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		members, err := mergeMembers(tx, id)
		if err != nil {
			return err
		}
		var items []string
		seen := map[string]bool{}
		for _, m := range members {
			if m.status != "decided" || m.binding.Stale != "" {
				return fmt.Errorf("%w: 需要先批准当前候选", ErrConflict)
			}
			if m.item != "" && !seen[m.item] {
				items = append(items, m.item)
				seen[m.item] = true
			}
		}
		b := members[0].binding
		var repoName string
		if err = tx.QueryRow(`SELECT name FROM repos WHERE id=?`, b.RepoID).Scan(&repoName); err != nil {
			return err
		}
		text = strings.Join([]string{
			fmt.Sprintf("请把工作项 %s 合入 %s（仓库 %s）。", strings.Join(items, "、"), b.TargetRef, repoName),
			fmt.Sprintf("预期：源分支 %s 当前为 %s，目标分支 %s 当前为 %s。", b.SourceRef, short(b.SourceHeadSHA), b.TargetRef, short(b.TargetBaseSHA)),
			"开始前先核对这两个 SHA；任一不一致就停下并告诉我，不要合并。",
			"合并后运行项目的检查命令，并报告结果和合并后的提交。",
		}, "\n")
		for _, m := range members {
			b := m.binding
			b.CopiedAt = now
			raw, _ := json.Marshal(b)
			if _, err = tx.Exec(`UPDATE approvals SET payload=? WHERE id=?`, string(raw), m.id); err != nil {
				return err
			}
			if err = store.Touch(tx, now, "approval", m.id); err != nil {
				return err
			}
		}
		return nil
	})
	c.notify()
	return text, err
}

func short(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
