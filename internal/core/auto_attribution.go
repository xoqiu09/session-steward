package core

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/xoqiu09/session-steward/internal/store"
)

type AttributionCandidate struct {
	WorkItemID string `json:"work_item_id"`
	RepoID     int64  `json:"repo_id"`
	Title      string `json:"title"`
	Reason     string `json:"reason"`
	Score      int    `json:"-"`
	Strong     bool   `json:"strong"` // 分数达到明确匹配（编号、完全一致的分支或标题）
}
type AttributionPlan struct {
	SessionID   int64                  `json:"session_id"`
	Fingerprint string                 `json:"fingerprint"`
	Title       string                 `json:"title"`
	RepoID      int64                  `json:"repo_id"`
	Action      string                 `json:"action"`
	WorkItemID  string                 `json:"work_item_id"`
	Automatic   bool                   `json:"automatic"`
	Historical  bool                   `json:"historical"`
	Reasons     []string               `json:"reasons"`
	Candidates  []AttributionCandidate `json:"candidates"`
}
type Attribution struct {
	ID          string          `json:"id"`
	SessionID   int64           `json:"session_id"`
	Fingerprint string          `json:"fingerprint"`
	Status      string          `json:"status"`
	Plan        AttributionPlan `json:"plan"`
	WorkItemID  string          `json:"work_item_id"`
	RunID       int64           `json:"run_id"`
	Automatic   bool            `json:"automatic"`
	CreatedItem bool            `json:"created_item"`
	CreatedAt   string          `json:"created_at"`
	DecidedAt   string          `json:"decided_at"`
}
type autoSession struct {
	id, repo                                               int64
	title, source, branch, state, dataSource, lastActivity string
	priorRuns                                              int
}
type autoRepo struct {
	id           int64
	name, common string
	git          bool
}
type autoItem struct {
	id                    string
	repo                  int64
	title, branch, status string
}
type autoState struct {
	sessions []autoSession
	repos    map[int64]autoRepo
	items    []autoItem
	newItems map[string]bool
}

func attributionState(tx *sql.Tx) (autoState, error) {
	st := autoState{repos: map[int64]autoRepo{}, newItems: map[string]bool{}}
	rows, err := tx.Query(`SELECT s.id,COALESCE(s.repo_id,0),COALESCE(t.title,''),COALESCE(t.source,''),s.branch,s.state,s.data_source,s.last_activity_at,(SELECT COUNT(*) FROM runs r WHERE r.session_id=s.id)
 FROM sessions s LEFT JOIN session_titles t ON t.session_id=s.id WHERE NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id=s.id AND r.ended_at='') ORDER BY s.last_activity_at DESC,s.id`)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var s autoSession
		if err = rows.Scan(&s.id, &s.repo, &s.title, &s.source, &s.branch, &s.state, &s.dataSource, &s.lastActivity, &s.priorRuns); err != nil {
			rows.Close()
			return st, err
		}
		st.sessions = append(st.sessions, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return st, err
	}
	rows, err = tx.Query(`SELECT id,name,common_dir,is_git FROM repos WHERE id NOT IN (SELECT repo_id FROM repo_aliases)`)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var r autoRepo
		if err = rows.Scan(&r.id, &r.name, &r.common, &r.git); err != nil {
			rows.Close()
			return st, err
		}
		st.repos[r.id] = r
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return st, err
	}
	rows, err = tx.Query(`SELECT id,COALESCE(repo_id,0),title,branch,status FROM work_items ORDER BY id`)
	if err != nil {
		return st, err
	}
	for rows.Next() {
		var w autoItem
		if err = rows.Scan(&w.id, &w.repo, &w.title, &w.branch, &w.status); err != nil {
			rows.Close()
			return st, err
		}
		st.items = append(st.items, w)
	}
	err = rows.Err()
	rows.Close()
	return st, err
}
func normalizeTitle(s string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return unicode.ToLower(r)
		}
		return -1
	}, s)
}

var branchNumber = regexp.MustCompile(`(?i)^(?:feat|feature|fix|bugfix|chore|docs|refactor|perf|test)/(\d+)(?:[-_/]|$)`)
var branchPrefix = regexp.MustCompile(`(?i)^(?:feat|feature|fix|bugfix|chore|docs|refactor|perf|test)/`)
var taskVerb = regexp.MustCompile(`(?i)(修复|实现|新增|添加|改进|完善|补充|补齐|接入|迁移|优化|重构|设计|验证|排查|核对|部署|构建|整理|集成|更新|解决|移除|删除|备份|恢复|制作|查找|查询|维护|配置|规划|对比|比较|分析|导入|导出|上传|下载|编写|生成|fix\b|add\b|implement\b|update\b|migrate\b|build\b|review\b|refactor\b|debug\b|improve\b)`)

func specificTitle(s string) bool {
	n := normalizeTitle(s)
	if len([]rune(n)) < 6 || len([]rune(s)) > 120 || strings.Contains(s, "…") || strings.Contains(s, "***") {
		return false
	}
	for _, word := range []string{"新对话", "继续推进卡顿任务", "每小时聚合", "回归测试", "m0审批", "测试steward", "测试sessionsteward", "permissionhook", "stewardapp接入", "你是我的", "你的任务是", "agentsmd"} {
		if strings.Contains(n, word) {
			return false
		}
	}
	return taskVerb.MatchString(s)
}
func branchTitle(s string) string {
	if !branchPrefix.MatchString(s) {
		return ""
	}
	slug := branchPrefix.ReplaceAllString(s, "")
	slug = branchTagRe.ReplaceAllString(slug, "")
	slug = branchNumber.ReplaceAllString(slug, "")
	slug = strings.Trim(slug, "-_/ ")
	if len([]rune(slug)) < 5 {
		return ""
	}
	for _, bad := range []string{"worktree", "session", "agent", "tmp", "test"} {
		if strings.HasPrefix(strings.ToLower(slug), bad) {
			return ""
		}
	}
	letters := 0
	for _, r := range slug {
		if unicode.IsLetter(r) {
			letters++
		}
	}
	if letters < 4 {
		return ""
	}
	return strings.NewReplacer("-", " ", "_", " ").Replace(slug)
}
func trustedProject(r autoRepo) bool {
	if r.git {
		return true
	}
	for _, generic := range []string{"projects", "workspace", "localdevdata", "tasks", "scratch", "tmp", "new-chat"} {
		if strings.EqualFold(r.name, generic) {
			return false
		}
	}
	path := strings.TrimPrefix(r.common, "dir:")
	if path == r.common || !filepath.IsAbs(path) {
		return false
	}
	for _, part := range strings.Split(filepath.Clean(path), string(filepath.Separator)) {
		if part == "Projects" || part == "WorkSpace" {
			return len([]rune(r.name)) >= 4
		}
	}
	return false
}

func distinctBranch(branch string) bool {
	for _, shared := range []string{"", "HEAD", "main", "master", "develop", "development", "dev", "trunk"} {
		if branch == shared {
			return false
		}
	}
	return true
}
func titleSimilarity(a, b string) int {
	tokens := func(s string) map[string]bool {
		r := []rune(normalizeTitle(s))
		out := map[string]bool{}
		for i := 0; i+1 < len(r); i++ {
			out[string(r[i:i+2])] = true
		}
		return out
	}
	x, y := tokens(a), tokens(b)
	if len(x) == 0 || len(y) == 0 {
		return 0
	}
	same := 0
	for k := range x {
		if y[k] {
			same++
		}
	}
	return 200 * same / (len(x) + len(y))
}
func metadataFingerprint(s autoSession) string {
	raw, _ := json.Marshal([]any{s.id, s.repo, s.title, s.source, s.branch, s.dataSource, s.priorRuns})
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:16])
}
func planAttribution(s autoSession, st autoState, now time.Time) *AttributionPlan {
	if s.title == "" && !distinctBranch(s.branch) {
		return nil
	}
	// A previously accepted/completed run is intentional history, not a new task.
	if s.priorRuns > 0 {
		return nil
	}
	p := &AttributionPlan{SessionID: s.id, Fingerprint: metadataFingerprint(s), Title: s.title, RepoID: s.repo, Action: "create", Reasons: []string{}, Candidates: []AttributionCandidate{}}
	if p.Title == "" {
		p.Title = branchTitle(s.branch)
		p.Reasons = append(p.Reasons, "标题取自描述性分支")
	}
	p.Historical = s.dataSource != "live" || s.state == "ended"
	last, err := time.Parse(time.RFC3339Nano, s.lastActivity)
	fresh := err == nil && !last.Before(now.Add(-24*time.Hour))
	repo := st.repos[s.repo]
	known := trustedProject(repo)
	if !known {
		p.RepoID = 0
		p.Reasons = append(p.Reasons, "启动目录无法确定实际项目")
	}
	if p.Historical {
		p.Reasons = append(p.Reasons, "仅历史会话，需确认后整理")
	} else if !fresh {
		p.Reasons = append(p.Reasons, "会话已超过 24 小时无活动")
	}
	explicit := GuessFromBranch(s.branch)
	// Number in a title is authoritative only if it is a known work-item ID.
	titleIDs := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?i)\b[A-Z][A-Z0-9]{0,15}-\d{1,6}\b`).FindAllString(s.title, -1) {
		titleIDs[strings.ToUpper(m)] = true
	}
	strong := map[string]bool{}
	closed := false
	numeric := ""
	if m := branchNumber.FindStringSubmatch(s.branch); m != nil {
		numeric = m[1]
	}
	for _, w := range st.items {
		same := w.repo == s.repo && known
		reason := ""
		score := 0
		if titleIDs[w.id] || explicit == w.id {
			reason = "明确的工作项编号"
			score = 100
		}
		if same && distinctBranch(s.branch) && w.branch == s.branch {
			reason = "同项目且分支完全匹配"
			score = 100
		}
		if same && numeric != "" && strings.TrimLeft(strings.TrimPrefix(w.id, w.id[:strings.LastIndex(w.id, "-")+1]), "0") == strings.TrimLeft(numeric, "0") {
			reason = "同项目且分支数字编号匹配"
			score = 99
		}
		if same && normalizeTitle(s.title) != "" && normalizeTitle(w.title) == normalizeTitle(s.title) && specificTitle(s.title) {
			reason = "同项目且任务标题完全一致"
			score = 98
		}
		if score == 0 && s.title != "" {
			sim := titleSimilarity(s.title, w.title)
			if sim >= 40 && (same || sim >= 70) {
				score = sim
				if score > 89 {
					score = 89
				}
				reason = "标题相似，需确认"
			}
		}
		if score == 0 {
			continue
		}
		if w.status == "done" || w.status == "abandoned" {
			if score >= 98 {
				closed = true
				p.Reasons = append(p.Reasons, "匹配到已完成或已放弃工作项，不能自动重开")
			}
			continue
		}
		if score >= 98 && known && w.repo != s.repo {
			reason = "编号与当前项目冲突，需确认"
			score = 80
		}
		if score >= 98 && distinctBranch(w.branch) && s.branch != "" && w.branch != s.branch {
			reason = "标题或编号匹配，但分支不同，需确认"
			score = 80
		}
		p.Candidates = append(p.Candidates, AttributionCandidate{w.id, w.repo, w.title, reason, score, score >= 98})
		if score >= 98 {
			strong[w.id] = true
		}
	}
	sort.Slice(p.Candidates, func(i, j int) bool {
		if p.Candidates[i].Score != p.Candidates[j].Score {
			return p.Candidates[i].Score > p.Candidates[j].Score
		}
		return p.Candidates[i].WorkItemID < p.Candidates[j].WorkItemID
	})
	if len(p.Candidates) > 0 {
		best := p.Candidates[0]
		p.Action = "link"
		p.WorkItemID = best.WorkItemID
		if p.Title == "" {
			p.Title = best.Title
		}
		p.RepoID = best.RepoID
		p.Reasons = append(p.Reasons, best.Reason)
		p.Automatic = len(strong) == 1 && best.Score >= 98 && !closed && !p.Historical && fresh
		if len(strong) > 1 {
			p.Reasons = append(p.Reasons, "多个明确匹配相互冲突")
		}
		if len(p.Candidates) > 5 {
			p.Candidates = p.Candidates[:5]
		}
		return p
	}
	if !known {
		var hinted []autoRepo
		name := normalizeTitle(s.title)
		for _, r := range st.repos {
			key := normalizeTitle(r.name)
			if len([]rune(key)) >= 4 && trustedProject(r) && strings.Contains(name, key) {
				hinted = append(hinted, r)
			}
		}
		if len(hinted) == 1 {
			p.RepoID = hinted[0].id
			p.Reasons = append(p.Reasons, "标题提及项目 "+hinted[0].name+"，请确认")
		}
	}
	if p.Title == "" {
		return nil
	}
	descriptive := specificTitle(p.Title) || branchTitle(s.branch) != ""
	if !descriptive && known {
		p.Reasons = append(p.Reasons, "标题较笼统，需要确认工作范围")
	}
	if known {
		p.Reasons = append(p.Reasons, "项目由会话目录确定")
	}
	p.Reasons = append(p.Reasons, "没有可直接关联的现有工作项")
	p.Automatic = known && descriptive && !closed && !p.Historical && fresh
	return p
}

func autoItemID(tx *sql.Tx, repo autoRepo) (string, error) {
	var prefix strings.Builder
	for _, r := range strings.ToUpper(repo.name) {
		if r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			prefix.WriteRune(r)
			if prefix.Len() == 3 {
				break
			}
		}
	}
	p := prefix.String()
	if p == "" {
		p = "WI"
	}
	if p[0] >= '0' && p[0] <= '9' {
		p = "W" + p[1:]
	}
	rows, err := tx.Query(`SELECT id FROM work_items WHERE id LIKE ?`, p+"-%")
	if err != nil {
		return "", err
	}
	max := 0
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return "", err
		}
		n, _ := strconv.Atoi(strings.TrimPrefix(id, p+"-"))
		if n > max {
			max = n
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s-%03d", p, max+1), nil
}
func applyAttribution(tx *sql.Tx, s autoSession, p AttributionPlan, st *autoState, automatic bool, now string) (item string, run int64, created bool, err error) {
	if p.Action == "link" {
		var status string
		var rid sql.NullInt64
		err = tx.QueryRow(`SELECT status,repo_id FROM work_items WHERE id=?`, p.WorkItemID).Scan(&status, &rid)
		if err != nil {
			return
		}
		if status == "done" || status == "abandoned" {
			err = fmt.Errorf("%w: 目标工作项已关闭", ErrConflict)
			return
		}
		item = p.WorkItemID
	} else if p.Action == "create" {
		if strings.TrimSpace(p.Title) == "" || p.RepoID == 0 {
			err = fmt.Errorf("%w: 请确认工作标题和所属项目", ErrBadRequest)
			return
		}
		repo, ok := st.repos[p.RepoID]
		if !ok {
			err = ErrNotFound
			return
		}
		// Reuse a unique identical work item created earlier in this same batch.
		for _, w := range st.items {
			if st.newItems[w.id] && w.repo == p.RepoID && w.branch == s.branch && normalizeTitle(w.title) == normalizeTitle(p.Title) && w.status != "done" && w.status != "abandoned" {
				if item != "" {
					err = fmt.Errorf("%w: 有多个同名工作项", ErrConflict)
					return
				}
				item = w.id
			}
		}
		if item == "" {
			item, err = autoItemID(tx, repo)
			if err != nil {
				return
			}
			needs := branchTitle(s.branch) != ""
			merge := "none"
			if needs {
				merge = "not_ready"
			}
			_, err = tx.Exec(`INSERT INTO work_items(id,repo_id,title,status,branch,needs_merge,merge_state,created_at,updated_at) VALUES(?,?,?,'in_progress',?,?,?,?,?)`, item, p.RepoID, strings.TrimSpace(p.Title), s.branch, needs, merge, now, now)
			if err != nil {
				return
			}
			created = true
			st.newItems[item] = true
			st.items = append(st.items, autoItem{item, p.RepoID, strings.TrimSpace(p.Title), s.branch, "in_progress"})
		}
	} else {
		err = ErrBadRequest
		return
	}
	binding := "manual"
	if automatic {
		binding = "auto"
	}
	if p.Historical {
		var attempt int
		if err = tx.QueryRow(`SELECT COALESCE(MAX(attempt),0)+1 FROM runs WHERE work_item_id=?`, item).Scan(&attempt); err != nil {
			return
		}
		at := s.lastActivity
		if at == "" {
			at = now
		}
		var result sql.Result
		result, err = tx.Exec(`INSERT INTO runs(work_item_id,session_id,attempt,binding,started_at,ended_at,outcome) VALUES(?,?,?,?,?,?,'historical')`, item, s.id, attempt, binding, at, at)
		if err == nil {
			run, err = result.LastInsertId()
		}
		return
	}
	err = bindRun(tx, s.id, item, binding, now, now)
	if err != nil {
		return
	}
	err = tx.QueryRow(`SELECT id FROM runs WHERE session_id=? AND work_item_id=? AND ended_at='' ORDER BY id DESC LIMIT 1`, s.id, item).Scan(&run)
	if err != nil {
		return
	}
	return
}

// ReconcileAttributions is serial, idempotent and never changes an existing run.
// Pending/dismissed records preserve the metadata fingerprint for stale decisions.
func (c *Core) ReconcileAttributions(ctx context.Context) (int, error) {
	changes := 0
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		st, err := attributionState(tx)
		if err != nil {
			return err
		}
		now := c.St.NowTS()
		// Bindings created manually elsewhere supersede outstanding suggestions.
		result, err := tx.Exec(`UPDATE attributions SET status='superseded' WHERE status='pending' AND EXISTS(SELECT 1 FROM runs r WHERE r.session_id=attributions.session_id AND r.ended_at='')`)
		if err != nil {
			return err
		}
		n, _ := result.RowsAffected()
		changes += int(n)
		for _, s := range st.sessions {
			p := planAttribution(s, st, c.St.Now())
			if p == nil {
				result, err = tx.Exec(`UPDATE attributions SET status='superseded' WHERE session_id=? AND status='pending'`, s.id)
				if err != nil {
					return err
				}
				n, _ = result.RowsAffected()
				changes += int(n)
				continue
			}
			var status, id string
			err = tx.QueryRow(`SELECT id,status FROM attributions WHERE session_id=? AND fingerprint=?`, s.id, p.Fingerprint).Scan(&id, &status)
			if err != nil && err != sql.ErrNoRows {
				return err
			}
			if err == nil && status != "pending" {
				continue
			}
			if id == "" {
				id = fmt.Sprintf("attr_%d_%s", s.id, p.Fingerprint[:16])
			}
			raw, _ := json.Marshal(p)
			if _, err = tx.Exec(`UPDATE attributions SET status='superseded' WHERE session_id=? AND status='pending' AND fingerprint<>?`, s.id, p.Fingerprint); err != nil {
				return err
			}
			result, err = tx.Exec(`INSERT INTO attributions(id,session_id,fingerprint,status,plan,created_at) VALUES(?,?,?,'pending',?,?) ON CONFLICT(session_id,fingerprint) DO UPDATE SET plan=excluded.plan WHERE attributions.status='pending' AND attributions.plan<>excluded.plan`, id, s.id, p.Fingerprint, string(raw), now)
			if err != nil {
				return err
			}
			n, _ = result.RowsAffected()
			changes += int(n)
			if p.Automatic {
				item, run, created, e := applyAttribution(tx, s, *p, &st, true, now)
				if e != nil {
					return e
				}
				if _, err = tx.Exec(`UPDATE attributions SET status='applied',work_item_id=?,run_id=?,automatic=1,created_item=?,decided_at=? WHERE id=?`, item, run, created, now, id); err != nil {
					return err
				}
				changes++
			}
		}
		if changes > 0 {
			return store.Touch(tx, now, "attribution", "")
		}
		return nil
	})
	if err == nil && changes > 0 {
		c.notify()
	}
	return changes, err
}

type AttributionDecision struct {
	ID          string `json:"id"`
	Fingerprint string `json:"fingerprint"`
	Action      string `json:"action"` // link | create | dismiss | undo
	WorkItemID  string `json:"work_item_id"`
	RepoID      int64  `json:"repo_id"`
	Title       string `json:"title"`
}

func (c *Core) DecideAttributions(ctx context.Context, decisions []AttributionDecision) error {
	if len(decisions) == 0 || len(decisions) > 500 {
		return ErrBadRequest
	}
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		st, err := attributionState(tx)
		if err != nil {
			return err
		}
		sessions := map[int64]autoSession{}
		for _, s := range st.sessions {
			sessions[s.id] = s
		}
		now := c.St.NowTS()
		seen := map[string]bool{}
		for _, d := range decisions {
			if seen[d.ID] {
				return ErrBadRequest
			}
			seen[d.ID] = true
			var a Attribution
			var raw string
			err = tx.QueryRow(`SELECT id,session_id,fingerprint,status,plan,work_item_id,run_id,automatic,created_item,created_at FROM attributions WHERE id=?`, d.ID).Scan(&a.ID, &a.SessionID, &a.Fingerprint, &a.Status, &raw, &a.WorkItemID, &a.RunID, &a.Automatic, &a.CreatedItem, &a.CreatedAt)
			if err == sql.ErrNoRows {
				return ErrNotFound
			}
			if err != nil {
				return err
			}
			if d.Fingerprint != a.Fingerprint {
				return fmt.Errorf("%w: 归属线索已变化，请刷新", ErrConflict)
			}
			if json.Unmarshal([]byte(raw), &a.Plan) != nil {
				return ErrBadRequest
			}
			if d.Action == "undo" {
				if a.Status != "applied" {
					return ErrConflict
				}
				// Never undo a later user rebind, outcome, or completion.
				result, e := tx.Exec(`UPDATE runs SET ended_at=?,outcome='attribution_reverted' WHERE id=? AND session_id=? AND work_item_id=? AND ended_at='' AND binding=?`, now, a.RunID, a.SessionID, a.WorkItemID, map[bool]string{true: "auto", false: "manual"}[a.Automatic])
				if e != nil {
					return e
				}
				n, _ := result.RowsAffected()
				if n == 0 {
					result, e = tx.Exec(`UPDATE runs SET outcome='attribution_reverted' WHERE id=? AND session_id=? AND work_item_id=? AND ended_at<>'' AND outcome IN ('','historical') AND binding=? AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.session_id=? AND r.id>?)`, a.RunID, a.SessionID, a.WorkItemID, map[bool]string{true: "auto", false: "manual"}[a.Automatic], a.SessionID, a.RunID)
					if e != nil {
						return e
					}
					n, _ = result.RowsAffected()
				}
				if n != 1 {
					return fmt.Errorf("%w: 执行记录已变化，未撤销后续操作", ErrConflict)
				}
				{
					_, e = tx.Exec(`UPDATE work_items SET status='abandoned',updated_at=? WHERE id=? AND status='in_progress' AND created_at=updated_at AND EXISTS(SELECT 1 FROM attributions WHERE work_item_id=? AND created_item=1) AND NOT EXISTS(SELECT 1 FROM runs WHERE work_item_id=? AND outcome<>'attribution_reverted')`, now, a.WorkItemID, a.WorkItemID, a.WorkItemID)
					if e != nil {
						return e
					}
				}
				if _, err = tx.Exec(`UPDATE attributions SET status='undone',decided_at=? WHERE id=?`, now, a.ID); err != nil {
					return err
				}
				continue
			}
			if a.Status != "pending" {
				return ErrConflict
			}
			s, ok := sessions[a.SessionID]
			if !ok || metadataFingerprint(s) != a.Fingerprint {
				return fmt.Errorf("%w: 会话已关联或线索发生变化", ErrConflict)
			}
			if d.Action == "dismiss" {
				if _, err = tx.Exec(`UPDATE attributions SET status='dismissed',decided_at=? WHERE id=?`, now, a.ID); err != nil {
					return err
				}
				continue
			}
			p := a.Plan
			p.Historical = s.dataSource != "live" || s.state == "ended"
			p.Automatic = false
			p.Action = d.Action
			if d.WorkItemID != "" {
				p.WorkItemID = d.WorkItemID
			}
			if d.RepoID != 0 {
				p.RepoID = d.RepoID
			}
			if d.Title != "" {
				p.Title = d.Title
			}
			item, run, created, e := applyAttribution(tx, s, p, &st, false, now)
			if e != nil {
				return e
			}
			p.WorkItemID = item
			for _, w := range st.items {
				if w.id == item {
					p.RepoID = w.repo
					break
				}
			}
			finalPlan, _ := json.Marshal(p)
			if _, err = tx.Exec(`UPDATE attributions SET status='applied',plan=?,work_item_id=?,run_id=?,automatic=0,created_item=?,decided_at=? WHERE id=?`, string(finalPlan), item, run, created, now, a.ID); err != nil {
				return err
			}
			delete(sessions, s.id)
		}
		return store.Touch(tx, now, "attribution", "")
	})
	if err == nil {
		c.notify()
	}
	return err
}
