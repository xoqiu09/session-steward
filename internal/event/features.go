package event

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

// FeatureBatch is an Agent report, never a user acceptance or trusted check.
type FeatureBatch struct {
	ReportedAt  string          `json:"reported_at,omitempty"`
	Provenance  string          `json:"provenance,omitempty"`
	ScopeBasis  string          `json:"scope_basis,omitempty"`
	ScopeStatus string          `json:"scope_status,omitempty"` // documented|proposed
	Features    []FeatureUpdate `json:"features"`
}
type FeatureUpdate struct {
	ID             string  `json:"id"`
	Title          string  `json:"title,omitempty"`
	Acceptance     string  `json:"acceptance,omitempty"`
	Candidate      string  `json:"candidate"`
	Implementation string  `json:"implementation,omitempty"`
	Validation     string  `json:"validation,omitempty"`
	Evidence       string  `json:"evidence,omitempty"`
	Blocker        *string `json:"blocker,omitempty"`
	Next           *string `json:"next,omitempty"`
	NextOwner      *string `json:"next_owner,omitempty"`
}

var featureID = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func (b *FeatureBatch) Redact() {
	b.ScopeBasis = Redact(b.ScopeBasis)
	b.Provenance = Redact(b.Provenance)
	for i := range b.Features {
		f := &b.Features[i]
		f.Title = Redact(f.Title)
		f.Acceptance = Redact(f.Acceptance)
		f.Candidate = Redact(f.Candidate)
		f.Evidence = Redact(f.Evidence)
		for _, p := range []*string{f.Blocker, f.Next} {
			if p != nil {
				*p = Redact(*p)
			}
		}
	}
}

func (b *FeatureBatch) Validate() error {
	if b == nil || len(b.Features) == 0 || len(b.Features) > 40 {
		return fmt.Errorf("每次回报需 1–40 项功能")
	}
	if b.ReportedAt != "" {
		if _, err := time.Parse(time.RFC3339Nano, b.ReportedAt); err != nil {
			return fmt.Errorf("reported_at 应为带时区的 RFC3339 时间")
		}
	}
	if len([]rune(b.Provenance)) > 600 {
		return fmt.Errorf("provenance 最多600字")
	}
	if b.ScopeStatus != "" && b.ScopeStatus != "documented" && b.ScopeStatus != "proposed" {
		return fmt.Errorf("scope_status 应为 documented/proposed")
	}
	if b.ScopeStatus == "documented" && strings.TrimSpace(b.ScopeBasis) == "" {
		return fmt.Errorf("明确范围需要 scope_basis 依据")
	}
	seen := map[string]bool{}
	for _, f := range b.Features {
		if !featureID.MatchString(f.ID) || seen[f.ID] {
			return fmt.Errorf("功能 ID 无效或重复: %s", f.ID)
		}
		seen[f.ID] = true
		switch f.Implementation {
		case "", "unknown", "not_started", "implementing", "implemented":
		default:
			return fmt.Errorf("implementation 无效；Agent 不能设置验收")
		}
		switch f.Validation {
		case "", "unknown", "not_verified", "validating", "passed", "failed":
		default:
			return fmt.Errorf("validation 无效；只接受 Agent 自述结果")
		}
		if (f.Implementation == "implemented" || f.Validation == "passed" || f.Validation == "failed") && strings.TrimSpace(f.Candidate) == "" {
			return fmt.Errorf("已实现或验证结果需要 candidate 版本依据")
		}
		if f.Validation == "passed" && strings.TrimSpace(f.Evidence) == "" {
			return fmt.Errorf("验证通过需要 evidence；仍标为 Agent 自述")
		}
		if f.NextOwner != nil {
			switch *f.NextOwner {
			case "unknown", "agent", "claude", "codex", "user", "external":
			default:
				return fmt.Errorf("next_owner 无效")
			}
		}
		for _, s := range []string{f.Title, f.Acceptance, f.Candidate, f.Evidence, b.ScopeBasis} {
			if len([]rune(s)) > 600 {
				return fmt.Errorf("功能字段最多600字")
			}
		}
		for _, s := range []*string{f.Blocker, f.Next} {
			if s != nil && len([]rune(*s)) > 600 {
				return fmt.Errorf("功能字段最多600字")
			}
		}
	}
	return nil
}
