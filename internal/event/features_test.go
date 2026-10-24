package event

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestFeatureMetadataAndForbiddenStates(t *testing.T) {
	var b FeatureBatch
	d := json.NewDecoder(strings.NewReader(`{"reported_at":"2026-10-21T10:00:00Z","provenance":"Agent summary, no new check","scope_status":"documented","scope_basis":"Synthetic spec","features":[{"id":"export","title":"Export","candidate":"sha-one","implementation":"implemented","validation":"not_verified"}]}`))
	d.DisallowUnknownFields()
	if err := d.Decode(&b); err != nil {
		t.Fatal(err)
	}
	if err := b.Validate(); err != nil {
		t.Fatal(err)
	}
	b.Features[0].Implementation = "accepted"
	if b.Validate() == nil {
		t.Fatal("Agent acceptance allowed")
	}
	b.Features[0].Implementation = "implemented"
	b.Features[0].Validation = "passed"
	if b.Validate() == nil {
		t.Fatal("passed without evidence")
	}
	b.Features[0].Evidence = "synthetic check"
	b.ReportedAt = "yesterday"
	if b.Validate() == nil {
		t.Fatal("invalid content time accepted")
	}
}
