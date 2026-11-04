package projectstructure

import (
	"encoding/json"
	"strings"
	"testing"
)

func valid() Document {
	return Document{SchemaVersion: 1, Goal: "Synthetic export tool", PreparedAt: "2026-11-03", BasisVersion: "synthetic-sha", Groups: []Group{{ID: "read", Title: "Read", Features: []Feature{{ID: "export"}}}}, Sources: []Source{{Path: "docs/overview.md", Kind: "documentation", LineStart: 2, LineEnd: 9}}}
}
func TestPortableDocumentRejectsUnsafeOrAmbiguousData(t *testing.T) {
	for name, change := range map[string]func(*Document){
		"version":          func(d *Document) { d.SchemaVersion = 2 },
		"missing goal":     func(d *Document) { d.Goal = "" },
		"duplicate groups": func(d *Document) { d.Groups = append(d.Groups, d.Groups[0]) },
		"duplicate features": func(d *Document) {
			d.Groups = append(d.Groups, Group{ID: "other", Title: "Other", Features: []Feature{{ID: "export"}}})
		},
		"external path":     func(d *Document) { d.Sources[0].Path = "https://example.test/a" },
		"absolute path":     func(d *Document) { d.Sources[0].Path = "/private/data" },
		"traversal":         func(d *Document) { d.Sources[0].Path = "../../private/data" },
		"reverse lines":     func(d *Document) { d.Sources[0].LineEnd = 1 },
		"dangling relation": func(d *Document) { d.Relations = []Relation{{From: "read", To: "missing", Label: "flows"}} },
	} {
		t.Run(name, func(t *testing.T) {
			d := valid()
			change(&d)
			raw, _ := json.Marshal(d)
			if _, err := Decode(raw); err == nil {
				t.Fatal("invalid document accepted")
			}
		})
	}
	raw, _ := json.Marshal(valid())
	if _, err := Decode(raw); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{string(raw) + ` {}`, strings.Replace(string(raw), `"schema_version":1`, `"accepted":true,"schema_version":1`, 1), strings.Repeat(" ", MaxBytes+1)} {
		if _, err := Decode([]byte(bad)); err == nil {
			t.Fatal("extra state, trailing input or oversize accepted")
		}
	}
}
