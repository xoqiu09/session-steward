package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/store"
)

type MergeSyncStatus struct {
	State        string `json:"state,omitempty"`
	PendingItems int    `json:"pending_items"`
	Account      string `json:"account,omitempty"`
	RepoID       int64  `json:"repo_id"`
	CheckedAt    string `json:"checked_at"`
	Remote       string `json:"remote"`
	TargetRef    string `json:"target_ref"`
	TargetSHA    string `json:"target_sha"`
	Error        string `json:"error,omitempty"`
	PRNote       string `json:"pr_note,omitempty"`
	Failures     int    `json:"failures,omitempty"` // 连续失败次数，成功后清零
	LastOK       string `json:"last_ok,omitempty"`  // 上次成功读到远端的时间
}

// mergeSyncWait：两次自动核对之间至少隔多久。连续失败时逐步拉长（1、2、4、8 分钟，最多 15 分钟），
// 免得网络不好时每分钟都去撞；手动“立即核对”不受限制。
func mergeSyncWait(previous MergeSyncStatus) time.Duration {
	if previous.State != "failed" || previous.Failures < 2 {
		return time.Minute
	}
	wait := time.Minute << min(previous.Failures-1, 4)
	return min(wait, 15*time.Minute)
}

// readableFetchError 把 git 的报错翻译成用户能看懂、知道下一步做什么的话。
func readableFetchError(err error) string {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "signal: killed") || strings.Contains(msg, "deadline exceeded"):
		return fmt.Sprintf("读取远端超时（超过 %d 秒），稍后会自动重试", int(gitx.FetchTimeout.Seconds()))
	case strings.Contains(msg, "Repository not found") || strings.Contains(msg, "Authentication failed") || strings.Contains(msg, "could not read Username") || strings.Contains(msg, "Permission denied"):
		return "没有权限读取这个仓库：检查 gh 或 git 登录的账号能否访问它"
	case strings.Contains(msg, "unable to access") || strings.Contains(msg, "Could not resolve host") || strings.Contains(msg, "TLS") || strings.Contains(msg, "Connection reset") || strings.Contains(msg, "timed out"):
		return "连不上远端（网络问题），稍后会自动重试"
	}
	return tailText([]byte(msg))
}

type MergeEvidence struct {
	SourceSHA string `json:"source_sha"`
	TargetRef string `json:"target_ref"`
	TargetSHA string `json:"target_sha"`
	Method    string `json:"method"`
	URL       string `json:"url,omitempty"`
	MergeSHA  string `json:"merge_sha,omitempty"`
	CheckedAt string `json:"checked_at"`
}

func remoteMergeKey(id int64) string { return "merge_remote:" + strconv.FormatInt(id, 10) }
func remoteMergeRef(id int64) string { return "refs/steward/merge-status/" + strconv.FormatInt(id, 10) }

func (c *Core) MergeSyncStatuses(ctx context.Context) ([]MergeSyncStatus, error) {
	rows, err := c.St.R().QueryContext(ctx, `SELECT m.v,
	 (SELECT COUNT(*) FROM work_items w WHERE w.repo_id=r.id AND w.needs_merge=1 AND w.branch<>'' AND w.merge_state<>'merged' AND w.status<>'abandoned')
	 FROM meta m JOIN repos r ON m.k='merge_remote:'||r.id
	 WHERE r.id NOT IN (SELECT repo_id FROM repo_aliases)
	 AND NOT EXISTS (SELECT 1 FROM meta a WHERE a.k='repo_archive:'||r.id AND a.v<>'') ORDER BY r.name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []MergeSyncStatus{}
	for rows.Next() {
		var raw string
		var pending int
		if err := rows.Scan(&raw, &pending); err != nil {
			return nil, err
		}
		var status MergeSyncStatus
		if json.Unmarshal([]byte(raw), &status) == nil {
			status.PendingItems = pending
			if pending == 0 {
				status.State = "idle"
				status.Error = ""
				status.PRNote = ""
			}
			if status.State == "" {
				if status.Error != "" {
					status.State = "failed"
				} else {
					status.State = "checked"
				}
			}
			out = append(out, status)
		}
	}
	return out, rows.Err()
}

// SyncMerges only refreshes private Git refs for repositories with outstanding
// merge work. It never checks out, pulls, merges, pushes, or updates local branches.
// Network operations finish before ScanMerges acquires its state-machine lock.
func (c *Core) SyncMerges(ctx context.Context, force bool) error {
	if !c.mergeSyncMu.TryLock() {
		return fmt.Errorf("%w: 正在核对合并状态，请稍后查看", ErrConflict)
	}
	defer c.mergeSyncMu.Unlock()
	repos, err := c.repos(ctx)
	if err != nil {
		return err
	}
	var wg sync.WaitGroup
	defer wg.Wait()
	sem := make(chan struct{}, 2)
	for _, r := range repos {
		var count int
		if err := c.St.R().QueryRowContext(ctx, `SELECT COUNT(*) FROM work_items WHERE repo_id=? AND needs_merge=1 AND branch<>'' AND merge_state<>'merged' AND status<>'abandoned'`, r.id).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			continue
		}
		if !force {
			raw, err := c.St.Meta(ctx, remoteMergeKey(r.id))
			if err != nil {
				return err
			}
			var previous MergeSyncStatus
			if json.Unmarshal([]byte(raw), &previous) == nil && previous.TargetRef == r.target {
				if previous.State == "missing" {
					if _, err := os.Stat(r.commonDir); os.IsNotExist(err) {
						continue
					}
				}
				at, _ := time.Parse(time.RFC3339Nano, previous.CheckedAt)
				if c.St.Now().Sub(at) < mergeSyncWait(previous) {
					continue
				}
			}
		}
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			wg.Wait()
			return ctx.Err()
		}
		wg.Add(1)
		go func(r repoRow) { defer wg.Done(); defer func() { <-sem }(); c.syncRepoMerge(ctx, r) }(r)
	}
	wg.Wait()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return c.ScanMerges(ctx)
}

func (c *Core) syncRepoMerge(ctx context.Context, r repoRow) {
	s := MergeSyncStatus{RepoID: r.id, TargetRef: r.target, State: "checked"}
	var previous MergeSyncStatus
	if raw, err := c.St.Meta(ctx, remoteMergeKey(r.id)); err == nil {
		_ = json.Unmarshal([]byte(raw), &previous)
	}
	defer func() {
		if ctx.Err() != nil {
			return
		}
		s.CheckedAt = c.St.NowTS()
		s.LastOK = previous.LastOK
		switch {
		case s.Error != "":
			s.State = "failed"
			s.Failures = previous.Failures + 1
		case s.State == "checked":
			s.LastOK = s.CheckedAt
		}
		b, _ := json.Marshal(s)
		_ = c.St.Tx(ctx, func(tx *sql.Tx) error {
			if _, err := tx.Exec(`INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`, remoteMergeKey(r.id), string(b)); err != nil {
				return err
			}
			return store.Touch(tx, s.CheckedAt, "merge_sync", strconv.FormatInt(r.id, 10))
		})
		c.notify()
	}()
	if _, err := os.Stat(r.commonDir); os.IsNotExist(err) {
		s.State = "missing"
		return
	} else if err != nil {
		s.Error = "项目目录暂时无法读取"
		return
	}
	branch := strings.TrimPrefix(r.target, "refs/heads/")
	if _, err := gitx.Run(ctx, "/", "check-ref-format", "refs/heads/"+branch); err != nil {
		s.Error = "目标不是可核对的分支"
		return
	}
	remote, ref := "origin", "refs/heads/"+branch
	up, _ := gitx.Run(ctx, r.commonDir, "for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)", "refs/heads/"+branch)
	if f := strings.Split(up, "\t"); len(f) == 2 && f[0] != "" && f[1] != "" {
		remote, ref = f[0], f[1]
	}
	if remote == "." {
		s.Error = "目标只跟踪本地分支，尚未配置远端"
		return
	}
	if strings.HasPrefix(remote, "-") || !strings.HasPrefix(ref, "refs/heads/") {
		s.Error = "无法识别目标分支的远端"
		return
	}
	remoteURL, err := gitx.Run(ctx, r.commonDir, "remote", "get-url", remote)
	if err != nil {
		s.Error = "无法读取仓库远端：" + tailText([]byte(err.Error()))
		return
	}
	s.Remote = remote
	if s.Account, err = c.fetchMergeRemote(ctx, r, remote, remoteURL, ref); err != nil {
		s.Error = readableFetchError(err)
		return
	}
	s.TargetSHA = gitx.RevParse(ctx, r.commonDir, remoteMergeRef(r.id))
	if s.TargetSHA == "" {
		s.Error = "远端没有返回可核对的目标提交"
		return
	}
	// An upstream pointing at another branch must not prove a merge to this target.
	if ref != "refs/heads/"+branch {
		s.Error = "上游分支与工作项的合并目标不同，需人工核对"
		s.TargetSHA = ""
		return
	}
	items, err := c.mergeItems(ctx, r.id)
	if err != nil {
		s.Error = "读取待合并工作失败"
		return
	}
	full := resolvedGithubRepository(ctx, remoteURL)
	for _, it := range items {
		src := c.mergeSource(ctx, r.commonDir, it)
		if src == "" || gitx.IsAncestor(ctx, r.commonDir, src, s.TargetSHA) || full == "" {
			continue
		}
		proof, note := githubMergeProof(ctx, r.commonDir, full, it.branch, branch, src, s.TargetSHA, s.Account)
		if note != "" {
			s.PRNote = note
		}
		if proof != nil {
			proof.TargetRef = r.target
			proof.CheckedAt = c.St.NowTS()
			b, _ := json.Marshal(proof)
			if err := c.St.SetMeta(ctx, "merge_pr:"+it.id, string(b)); err != nil {
				s.PRNote = "保存 PR 核对结果失败"
			}
		}
	}
}

func githubRepository(raw string) string {
	var host, path string
	if strings.HasPrefix(raw, "git@github.com:") {
		host = "github.com"
		path = strings.TrimPrefix(raw, "git@github.com:")
	} else if strings.HasPrefix(raw, "git@ssh.github.com:") {
		host = "github.com"
		path = strings.TrimPrefix(raw, "git@ssh.github.com:")
	} else {
		u, err := url.Parse(raw)
		if err != nil {
			return ""
		}
		host, path = u.Hostname(), strings.TrimPrefix(u.Path, "/")
		if host == "ssh.github.com" && u.Scheme == "ssh" {
			host = "github.com"
		}
	}
	if host != "github.com" {
		return ""
	}
	path = strings.TrimSuffix(path, ".git")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || strings.ContainsAny(path, " \t\r\n?#") {
		return ""
	}
	return path
}

func resolvedGithubRepository(ctx context.Context, raw string) string {
	if full := githubRepository(raw); full != "" {
		return full
	}
	// SSH aliases (for example separate personal/company GitHub accounts) retain
	// their own Git authentication. Resolve only the hostname for PR metadata.
	colon := strings.Index(raw, ":")
	if colon < 0 || strings.Contains(raw[:colon], "/") {
		return ""
	}
	userHost := strings.Split(raw[:colon], "@")
	host := userHost[len(userHost)-1]
	if host == "" || strings.HasPrefix(host, "-") {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	b, err := exec.CommandContext(ctx, "ssh", "-G", host).Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[0] == "hostname" && (f[1] == "github.com" || f[1] == "ssh.github.com") {
			return githubRepository("git@github.com:" + raw[colon+1:])
		}
	}
	return ""
}

// PR metadata handles squash/rebase merges, for which source ancestry is absent.
// A matching branch name alone is insufficient: exact head SHA, base branch and
// a merge commit contained in the freshly fetched target are all required.
func githubMergeProof(ctx context.Context, dir, repo, source, base, sha, target, account string) (*MergeEvidence, string) {
	bin, err := exec.LookPath("gh")
	if err != nil {
		return nil, "未找到 GitHub CLI；压缩或变基合并需另行核对"
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	env, err := githubTokenEnv(ctx, bin, account)
	if err != nil {
		return nil, "此项目使用的 GitHub 账号暂时不可用"
	}
	cmd := exec.CommandContext(ctx, bin, "pr", "list", "--repo", repo, "--state", "merged", "--head", source, "--base", base, "--limit", "20", "--json", "headRefOid,headRefName,baseRefName,mergeCommit,url")
	cmd.Env = append(cmd.Environ(), env...)
	b, err := cmd.Output()
	if err != nil {
		return nil, "GitHub PR 核对不可用；未自动判断压缩或变基合并"
	}
	return verifiedPRProof(ctx, dir, b, source, base, sha, target), ""
}

func verifiedPRProof(ctx context.Context, dir string, raw []byte, source, base, sha, target string) *MergeEvidence {
	var prs []struct {
		HeadRefOid  string `json:"headRefOid"`
		HeadRefName string `json:"headRefName"`
		BaseRefName string `json:"baseRefName"`
		MergeCommit struct {
			Oid string `json:"oid"`
		} `json:"mergeCommit"`
		URL string `json:"url"`
	}
	if json.Unmarshal(raw, &prs) != nil {
		return nil
	}
	for _, pr := range prs {
		if pr.HeadRefOid == sha && pr.HeadRefName == source && pr.BaseRefName == base && pr.MergeCommit.Oid != "" && gitx.IsAncestor(ctx, dir, pr.MergeCommit.Oid, target) {
			return &MergeEvidence{SourceSHA: sha, TargetSHA: target, MergeSHA: pr.MergeCommit.Oid, URL: pr.URL, Method: "github_pr"}
		}
	}
	return nil
}

func (c *Core) remoteMergeTarget(ctx context.Context, r repoRow) (string, string) {
	raw, err := c.St.Meta(ctx, remoteMergeKey(r.id))
	if err != nil {
		return "", ""
	}
	var s MergeSyncStatus
	if json.Unmarshal([]byte(raw), &s) == nil && s.TargetRef == r.target && s.TargetSHA != "" && s.TargetSHA == gitx.RevParse(ctx, r.commonDir, remoteMergeRef(r.id)) {
		return s.TargetSHA, "remote_git"
	}
	branch := strings.TrimPrefix(r.target, "refs/heads/")
	up, _ := gitx.Run(ctx, r.commonDir, "for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)", "refs/heads/"+branch)
	if f := strings.Split(up, "\t"); len(f) == 2 && f[0] != "" && f[0] != "." && f[1] == "refs/heads/"+branch {
		if sha := gitx.RevParse(ctx, r.commonDir, branch+"@{upstream}"); sha != "" {
			return sha, "remote_cached"
		}
	}
	return "", ""
}

func (c *Core) prMergeEvidence(ctx context.Context, r repoRow, item, src, target string) *MergeEvidence {
	if target == "" {
		return nil
	}
	raw, err := c.St.Meta(ctx, "merge_pr:"+item)
	if err != nil {
		return nil
	}
	var proof MergeEvidence
	if json.Unmarshal([]byte(raw), &proof) == nil && proof.Method == "github_pr" && proof.SourceSHA == src && proof.TargetRef == r.target && proof.MergeSHA != "" && gitx.IsAncestor(ctx, r.commonDir, proof.MergeSHA, target) {
		return &proof
	}
	return nil
}
