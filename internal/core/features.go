package core

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

type FeatureContribution struct {
	event.FeatureUpdate
	SessionID        int64  `json:"session_id"`
	RunID            int64  `json:"run_id"`
	WorkItemID       string `json:"work_item_id"`
	Provider         string `json:"provider"`
	At               string `json:"at"`
	ImplementationAt string `json:"implementation_at,omitempty"`
	ValidationAt     string `json:"validation_at,omitempty"`
	NextAt           string `json:"next_at,omitempty"`
	Active           bool   `json:"active"`
}
type ProjectFeature struct {
	RepoID         int64                 `json:"repo_id"`
	ID             string                `json:"id"`
	Title          string                `json:"title"`
	Acceptance     string                `json:"acceptance"`
	ScopeBasis     string                `json:"scope_basis"`
	ScopeStatus    string                `json:"scope_status"`
	ScopeVersion   string                `json:"scope_version"`
	Candidate      string                `json:"candidate"`
	Revision       string                `json:"revision"`
	Implementation string                `json:"implementation"`
	Validation     string                `json:"validation"` // Agent report only; never a trusted check.
	Accepted       bool                  `json:"accepted"`
	AcceptedAt     string                `json:"accepted_at,omitempty"`
	Conflict       bool                  `json:"conflict"`
	Stale          bool                  `json:"stale"`
	WorkItemIDs    []string              `json:"work_item_ids"`
	Contributions  []FeatureContribution `json:"contributions"`
}

func featureHash(v any) string {
	b, _ := json.Marshal(v)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func (c *Core) applyFeatures(tx *sql.Tx, sid int64, e *event.Event, now string) error {
	at := store.TS(e.OccurredAt)
	var item string
	var repo, run int64
	err := tx.QueryRow(`SELECT w.id,w.repo_id,r.id FROM runs r JOIN work_items w ON w.id=r.work_item_id
 WHERE r.session_id=? AND r.started_at<=? AND (r.ended_at='' OR r.ended_at>?) AND r.outcome<>'attribution_reverted'
 ORDER BY r.started_at DESC,r.id DESC LIMIT 1`, sid, at, at).Scan(&item, &repo, &run)
	if errors.Is(err, sql.ErrNoRows) || repo == 0 {
		return fmt.Errorf("%w: 请先关联明确项目的工作项再回报核心功能", ErrBadRequest)
	}
	if err != nil {
		return err
	}
	for _, f := range e.Features.Features {
		// Metadata is stable. Reports cannot silently rename/remove features or alter acceptance criteria.
		var title string
		err = tx.QueryRow(`SELECT title FROM project_features WHERE repo_id=? AND feature_id=?`, repo, f.ID).Scan(&title)
		if errors.Is(err, sql.ErrNoRows) {
			if strings.TrimSpace(f.Title) == "" || strings.TrimSpace(e.Features.ScopeBasis) == "" {
				return fmt.Errorf("%w: 新功能需要 title 和 scope_basis", ErrBadRequest)
			}
			status := e.Features.ScopeStatus
			if status == "" {
				status = "proposed"
			}
			_, err = tx.Exec(`INSERT INTO project_features(repo_id,feature_id,title,acceptance,scope_basis,scope_status,created_at) VALUES(?,?,?,?,?,?,?)`, repo, f.ID, clip(f.Title), clip(f.Acceptance), clip(e.Features.ScopeBasis), status, now)
		} else if err == nil && f.Title != "" && clip(f.Title) != title {
			return fmt.Errorf("%w: 功能 %s 已存在，请复用原名称或明确确认范围变更", ErrBadRequest, f.ID)
		}
		if err != nil {
			return err
		}
		f.Title = clip(f.Title)
		f.Acceptance = clip(f.Acceptance)
		f.Evidence = clip(f.Evidence)
		f.Candidate = clip(f.Candidate)
		for _, s := range []*string{f.Blocker, f.Next} {
			if s != nil {
				*s = clip(*s)
			}
		}
		body, _ := json.Marshal(f)
		if _, err = tx.Exec(`INSERT INTO feature_reports(repo_id,feature_id,event_id,session_id,run_id,work_item_id,body,at,received_at) VALUES(?,?,?,?,?,?,?,?,?)`, repo, f.ID, e.EventID, sid, run, item, string(body), at, now); err != nil {
			return err
		}
	}
	return store.Touch(tx, now, "features", fmt.Sprint(repo))
}

func (c *Core) readFeatures(tx *sql.Tx) ([]ProjectFeature, error) {
	out := []ProjectFeature{}
	idx := map[string]int{}
	key := func(repo int64, id string) string { return fmt.Sprintf("%d/%s", repo, id) }
	rows, err := tx.Query(`SELECT repo_id,feature_id,title,acceptance,scope_basis,scope_status FROM project_features ORDER BY repo_id,created_at,feature_id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var f ProjectFeature
		if err = rows.Scan(&f.RepoID, &f.ID, &f.Title, &f.Acceptance, &f.ScopeBasis, &f.ScopeStatus); err != nil {
			rows.Close()
			return nil, err
		}
		f.Contributions = []FeatureContribution{}
		f.WorkItemIDs = []string{}
		f.ScopeVersion = featureHash([]string{f.Title, f.Acceptance, f.ScopeBasis, f.ScopeStatus})
		idx[key(f.RepoID, f.ID)] = len(out)
		out = append(out, f)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = tx.Query(`SELECT f.repo_id,f.feature_id,f.body,f.session_id,f.run_id,f.work_item_id,s.provider,f.at,r.ended_at='' FROM feature_reports f JOIN sessions s ON s.id=f.session_id JOIN runs r ON r.id=f.run_id ORDER BY f.at,f.id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var repo int64
		var id, body string
		var p FeatureContribution
		if err = rows.Scan(&repo, &id, &body, &p.SessionID, &p.RunID, &p.WorkItemID, &p.Provider, &p.At, &p.Active); err != nil {
			rows.Close()
			return nil, err
		}
		if err = json.Unmarshal([]byte(body), &p.FeatureUpdate); err != nil {
			rows.Close()
			return nil, err
		}
		i, ok := idx[key(repo, id)]
		if !ok {
			continue
		}
		f := &out[i]
		f.WorkItemIDs = appendUniq(f.WorkItemIDs, p.WorkItemID)
		j := -1
		for n := range f.Contributions {
			if f.Contributions[n].RunID == p.RunID {
				j = n
				break
			}
		}
		if j < 0 {
			f.Contributions = append(f.Contributions, p)
			j = len(f.Contributions) - 1
			f.Contributions[j].Implementation = ""
			f.Contributions[j].Validation = ""
		}
		prev := f.Contributions[j]
		if prev.Candidate != p.Candidate {
			prev.Implementation = ""
			prev.Validation = ""
			prev.ImplementationAt = ""
			prev.ValidationAt = ""
			prev.Evidence = ""
			prev.Blocker = nil
			prev.Next = nil
			prev.NextOwner = nil
		}
		prev.Candidate = p.Candidate
		prev.At = p.At
		prev.Active = p.Active
		if p.Implementation != "" {
			prev.Implementation = p.Implementation
			prev.ImplementationAt = p.At
		}
		if p.Validation != "" {
			prev.Validation = p.Validation
			prev.ValidationAt = p.At
			prev.Evidence = p.Evidence
		}
		if p.Blocker != nil {
			prev.Blocker = p.Blocker
		}
		if p.Next != nil {
			prev.Next = p.Next
		}
		if p.NextOwner != nil {
			prev.NextOwner = p.NextOwner
		}
		if p.Next != nil || p.NextOwner != nil {
			prev.NextAt = p.At
		}
		f.Contributions[j] = prev
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range out {
		resolveFeature(&out[i], c.St.Now())
	}
	rows, err = tx.Query(`SELECT repo_id,feature_id,candidate,scope_version,decision,at FROM feature_acceptances ORDER BY id`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var repo int64
		var id, candidate, scope, decision, at string
		if err = rows.Scan(&repo, &id, &candidate, &scope, &decision, &at); err != nil {
			rows.Close()
			return nil, err
		}
		if i, ok := idx[key(repo, id)]; ok {
			f := &out[i]
			f.Accepted = decision == "accepted" && candidate != "" && candidate == f.Candidate && scope == f.ScopeVersion && !f.Conflict && f.Implementation == "implemented" && f.Validation != "failed"
			f.AcceptedAt = at
		}
	}
	err = rows.Err()
	rows.Close()
	return out, err
}

func resolveFeature(f *ProjectFeature, now time.Time) {
	active := []FeatureContribution{}
	latest := ""
	for _, p := range f.Contributions {
		if p.Active {
			active = append(active, p)
		}
		if p.At > latest {
			latest = p.At
		}
	}
	// Closed attempts remain provenance; they cannot create conflicts with a new active attempt.
	if len(active) == 0 && len(f.Contributions) > 0 {
		p := f.Contributions[0]
		for _, r := range f.Contributions {
			if r.At > p.At {
				p = r
			}
		}
		for _, r := range f.Contributions {
			if r.Candidate == p.Candidate {
				active = append(active, r)
			}
		}
	}
	// A reviewer ending its session does not erase a failed check for the same candidate.
	activeCandidates := map[string]bool{}
	for _, p := range active {
		if p.Candidate != "" {
			activeCandidates[p.Candidate] = true
		}
	}
	if len(activeCandidates) == 1 {
		for _, p := range f.Contributions {
			if !p.Active && activeCandidates[p.Candidate] {
				found := false
				for _, r := range active {
					if r.RunID == p.RunID {
						found = true
					}
				}
				if !found {
					active = append(active, p)
				}
			}
		}
	}
	candidates := map[string]bool{}
	impl := map[string]bool{}
	validation := map[string]bool{}
	for _, p := range active {
		if p.Candidate != "" {
			candidates[p.Candidate] = true
		}
		if p.Implementation != "" {
			impl[p.Implementation] = true
		}
		if p.Validation != "" {
			validation[p.Validation] = true
		}
	}
	f.Implementation = "unknown"
	f.Validation = "unknown"
	if len(candidates) > 1 {
		f.Conflict = true
		f.Implementation = "conflict"
		f.Validation = "conflict"
	} else {
		for k := range candidates {
			f.Candidate = k
		}
		if impl["implementing"] {
			f.Implementation = "implementing"
		} else if impl["implemented"] && !impl["not_started"] && !impl["unknown"] {
			f.Implementation = "implemented"
		} else if impl["not_started"] && !impl["implemented"] {
			f.Implementation = "not_started"
		} else if impl["implemented"] {
			f.Conflict = true
			f.Implementation = "conflict"
		}
		if validation["failed"] {
			f.Validation = "failed"
		} else if validation["validating"] {
			f.Validation = "validating"
		} else if validation["passed"] {
			f.Validation = "passed"
		} else if validation["not_verified"] {
			f.Validation = "not_verified"
		}
	}
	sort.Slice(f.Contributions, func(i, j int) bool { return f.Contributions[i].At > f.Contributions[j].At })
	if t, err := time.Parse(time.RFC3339Nano, latest); err == nil {
		f.Stale = now.Sub(t) > 24*time.Hour
	}
	f.Revision = featureHash([]any{f.ScopeVersion, f.Candidate, f.Implementation, f.Validation, f.Contributions})
}

// ConfirmFeatureScope is only for ambiguous proposed scope; ordinary reports reuse documented scope.
func (c *Core) ConfirmFeatureScope(ctx context.Context, repo int64, id, revision string) error {
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		var resolveErr error
		repo, resolveErr = canonicalRepo(tx, repo)
		if resolveErr != nil {
			return resolveErr
		}
		fs, err := c.readFeatures(tx)
		if err != nil {
			return err
		}
		for _, f := range fs {
			if f.RepoID != repo || f.ID != id {
				continue
			}
			if f.Revision != revision {
				return fmt.Errorf("%w: 范围回报已变化，请刷新", ErrBadRequest)
			}
			if _, err = tx.Exec(`INSERT INTO feature_scope_decisions(repo_id,feature_id,previous_status,revision,actor,at) VALUES(?,?,?,?,'owner',?)`, repo, id, f.ScopeStatus, revision, c.St.NowTS()); err != nil {
				return err
			}
			if _, err = tx.Exec(`UPDATE project_features SET scope_status='confirmed' WHERE repo_id=? AND feature_id=?`, repo, id); err != nil {
				return err
			}
			return store.Touch(tx, c.St.NowTS(), "features", fmt.Sprint(repo))
		}
		return ErrNotFound
	})
	if err == nil {
		c.notify()
	}
	return err
}

// AcceptFeature is panel-only. Ingest events cannot set acceptance or trusted checks.
func (c *Core) AcceptFeature(ctx context.Context, repo int64, id, candidate, revision, decision string) error {
	if decision != "accepted" && decision != "changes_requested" {
		return fmt.Errorf("%w: 验收决定无效", ErrBadRequest)
	}
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		var resolveErr error
		repo, resolveErr = canonicalRepo(tx, repo)
		if resolveErr != nil {
			return resolveErr
		}
		fs, err := c.readFeatures(tx)
		if err != nil {
			return err
		}
		for _, f := range fs {
			if f.RepoID != repo || f.ID != id {
				continue
			}
			if f.Revision != revision || f.Candidate != candidate || candidate == "" || f.Conflict {
				return fmt.Errorf("%w: 功能回报已变化或候选不明确，请刷新核对", ErrBadRequest)
			}
			if decision == "accepted" && (f.Implementation != "implemented" || f.Validation == "failed") {
				return fmt.Errorf("%w: 功能尚未实现或仍有失败结果", ErrBadRequest)
			}
			if _, err = tx.Exec(`INSERT INTO feature_acceptances(repo_id,feature_id,candidate,scope_version,decision,actor,at) VALUES(?,?,?,?,?,'owner',?)`, repo, id, candidate, f.ScopeVersion, decision, c.St.NowTS()); err != nil {
				return err
			}
			return store.Touch(tx, c.St.NowTS(), "features", fmt.Sprint(repo))
		}
		return ErrNotFound
	})
	if err == nil {
		c.notify()
	}
	return err
}
