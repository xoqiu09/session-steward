// Package projectstructure defines portable, presentation-only project descriptions.
// Documents are untrusted text. They grant no execution, scope or acceptance authority.
package projectstructure

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

const MaxBytes = 64 << 10

type Document struct {
	SchemaVersion int        `json:"schema_version"`
	Goal          string     `json:"goal"`
	Audience      string     `json:"audience"`
	Scope         string     `json:"scope"`
	PreparedAt    string     `json:"prepared_at"`
	BasisVersion  string     `json:"basis_version"`
	Groups        []Group    `json:"groups"`
	Relations     []Relation `json:"relations"`
	Sources       []Source   `json:"sources"`
}
type Group struct {
	ID       string    `json:"id"`
	Title    string    `json:"title"`
	Question string    `json:"question"`
	Note     string    `json:"note,omitempty"`
	Features []Feature `json:"features"`
}
type Feature struct {
	ID    string `json:"id"`
	Label string `json:"label,omitempty"`
}
type Relation struct {
	From  string `json:"from"`
	To    string `json:"to"`
	Label string `json:"label"`
}
type Source struct {
	Path      string `json:"path"`
	LineStart int    `json:"line_start,omitempty"`
	LineEnd   int    `json:"line_end,omitempty"`
	Kind      string `json:"kind"` // documentation | source
	Note      string `json:"note,omitempty"`
}

var identifier = regexp.MustCompile(`^[a-z][a-z0-9-]{0,63}$`)

func Decode(raw []byte) (Document, error) {
	var d Document
	if len(raw) > MaxBytes {
		return d, fmt.Errorf("结构资料最多 64 KiB")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		return d, fmt.Errorf("结构 JSON 无效: %w", err)
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return d, fmt.Errorf("只接受一份结构 JSON")
	}
	if d.Groups == nil {
		d.Groups = []Group{}
	}
	if d.Relations == nil {
		d.Relations = []Relation{}
	}
	if d.Sources == nil {
		d.Sources = []Source{}
	}
	for i := range d.Groups {
		if d.Groups[i].Features == nil {
			d.Groups[i].Features = []Feature{}
		}
	}
	d.redact()
	return d, d.Validate()
}

func text(s string, max int, required bool) bool {
	return (!required || strings.TrimSpace(s) != "") && len([]rune(s)) <= max
}
func (d Document) Validate() error {
	if d.SchemaVersion != 1 {
		return fmt.Errorf("schema_version 应为 1")
	}
	if !text(d.Goal, 600, true) || !text(d.Audience, 300, false) || !text(d.Scope, 1200, false) || !text(d.BasisVersion, 200, true) {
		return fmt.Errorf("目标或依据字段缺失或过长")
	}
	if _, err := time.Parse("2006-01-02", d.PreparedAt); err != nil {
		return fmt.Errorf("prepared_at 应为 YYYY-MM-DD")
	}
	if len(d.Groups) > 12 || len(d.Relations) > 32 || len(d.Sources) > 24 {
		return fmt.Errorf("最多 12 类用途、32 条关系、24 项依据")
	}
	groups, features := map[string]bool{}, map[string]bool{}
	for _, g := range d.Groups {
		if !identifier.MatchString(g.ID) || g.ID == "all" || g.ID == "unclassified" || groups[g.ID] {
			return fmt.Errorf("分组 ID 无效、保留或重复: %s", g.ID)
		}
		groups[g.ID] = true
		if !text(g.Title, 60, true) || !text(g.Question, 200, false) || !text(g.Note, 600, false) || len(g.Features) > 200 {
			return fmt.Errorf("分组字段缺失或过长")
		}
		for _, f := range g.Features {
			if !identifier.MatchString(f.ID) || features[f.ID] || !text(f.Label, 120, false) {
				return fmt.Errorf("功能 ID 无效或跨组重复: %s", f.ID)
			}
			features[f.ID] = true
		}
	}
	if len(features) > 200 {
		return fmt.Errorf("最多映射 200 项功能")
	}
	edges := map[string]bool{}
	for _, r := range d.Relations {
		key := r.From + "/" + r.To
		if !groups[r.From] || !groups[r.To] || r.From == r.To || edges[key] || !text(r.Label, 160, true) {
			return fmt.Errorf("关系需引用不同的已有分组，且不可重复")
		}
		edges[key] = true
	}
	for _, s := range d.Sources {
		if !text(s.Path, 240, true) || path.IsAbs(s.Path) || path.Clean(s.Path) != s.Path || strings.ContainsAny(s.Path, "\\:\x00\r\n") || s.Path == "." || s.Path == ".." || strings.HasPrefix(s.Path, "../") || s.LineStart < 0 || s.LineEnd < 0 || s.LineEnd > 0 && (s.LineStart == 0 || s.LineEnd < s.LineStart) || !text(s.Note, 300, false) {
			return fmt.Errorf("依据只接受仓库相对路径和有效行号")
		}
		if s.Kind != "documentation" && s.Kind != "source" {
			return fmt.Errorf("依据类别应为 documentation/source")
		}
	}
	return nil
}

func (d *Document) redact() {
	clean := func(p *string) { *p = event.Redact(*p) }
	for _, p := range []*string{&d.Goal, &d.Audience, &d.Scope, &d.BasisVersion} {
		clean(p)
	}
	for i := range d.Groups {
		g := &d.Groups[i]
		for _, p := range []*string{&g.Title, &g.Question, &g.Note} {
			clean(p)
		}
		for j := range g.Features {
			clean(&g.Features[j].Label)
		}
	}
	for i := range d.Relations {
		clean(&d.Relations[i].Label)
	}
	for i := range d.Sources {
		clean(&d.Sources[i].Path)
		clean(&d.Sources[i].Note)
	}
}
