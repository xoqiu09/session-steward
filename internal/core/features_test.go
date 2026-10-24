package core

import (
	"context"
	"github.com/xoqiu09/session-steward/internal/event"
	"strings"
	"testing"
	"time"
)

func featureCore(t *testing.T) (*Core, time.Time) {
	c := newCore(t, nil)
	at := time.Now().Add(-time.Hour)
	mustIngest(t, c, ev("s1", event.KindSessionStart, at))
	var repo int64
	if err := c.St.R().QueryRow(`SELECT id FROM repos LIMIT 1`).Scan(&repo); err != nil {
		t.Fatal(err)
	}
	if err := c.CreateWorkItem(context.Background(), WorkItemInput{ID: "FEAT-1", RepoID: repo, Title: "Synthetic task"}); err != nil {
		t.Fatal(err)
	}
	cl := ev("s1", event.KindClaim, at.Add(time.Second))
	cl.WorkTag = "FEAT-1"
	mustIngest(t, c, cl)
	return c, at
}
func ptr(s string) *string { return &s }
func featureEvent(sid string, at time.Time, updates ...event.FeatureUpdate) *event.Event {
	e := ev(sid, event.KindFeatures, at)
	e.Features = &event.FeatureBatch{ScopeBasis: "Synthetic acceptance spec", ScopeStatus: "documented", Features: updates}
	return e
}
func update() event.FeatureUpdate {
	return event.FeatureUpdate{ID: "export", Title: "Synthetic export", Acceptance: "export rows", Candidate: "sha-one", Implementation: "implemented", Validation: "passed", Evidence: "Agent ran synthetic unit checks", Next: ptr("review export"), NextOwner: ptr("agent")}
}
func featureOf(t *testing.T, c *Core) ProjectFeature {
	t.Helper()
	s, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Features) != 1 {
		t.Fatalf("want one stable feature, got %d", len(s.Features))
	}
	return s.Features[0]
}

func TestFeatureDedupOrderingAndAcceptance(t *testing.T) {
	c, at := featureCore(t)
	e := featureEvent("s1", at.Add(3*time.Minute), update())
	mustIngest(t, c, e)
	mustIngest(t, c, e)
	old := update()
	old.Implementation = "implementing"
	old.Validation = "not_verified"
	mustIngest(t, c, featureEvent("s1", at.Add(2*time.Minute), old))
	f := featureOf(t, c)
	if f.Implementation != "implemented" || f.Validation != "passed" || f.Accepted {
		t.Fatalf("wrong aggregate: %+v", f)
	}
	var n int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM feature_reports`).Scan(&n)
	if n != 2 {
		t.Fatal("duplicate event created report")
	}
	ctx := context.Background()
	if err := c.AcceptFeature(ctx, f.RepoID, f.ID, f.Candidate, "stale", "accepted"); err == nil {
		t.Fatal("accepted obsolete revision")
	}
	if err := c.AcceptFeature(ctx, f.RepoID, f.ID, f.Candidate, f.Revision, "accepted"); err != nil {
		t.Fatal(err)
	}
	if !featureOf(t, c).Accepted {
		t.Fatal("explicit user acceptance missing")
	}
	newer := update()
	newer.Candidate = "sha-two"
	newer.Implementation = "implementing"
	newer.Validation = "not_verified"
	mustIngest(t, c, featureEvent("s1", at.Add(4*time.Minute), newer))
	f = featureOf(t, c)
	if f.Accepted || f.Validation == "passed" {
		t.Fatal("old candidate validation/acceptance leaked into new version")
	}
}
func TestFeatureParallelFailuresAndCandidateConflict(t *testing.T) {
	c, at := featureCore(t)
	mustIngest(t, c, featureEvent("s1", at.Add(2*time.Minute), update()))
	mustIngest(t, c, ev("s2", event.KindSessionStart, at))
	cl := ev("s2", event.KindClaim, at.Add(time.Second))
	cl.WorkTag = "FEAT-1"
	mustIngest(t, c, cl)
	u := update()
	u.Implementation = ""
	u.Validation = "failed"
	u.Blocker = ptr("encoding sample fails")
	u.NextOwner = ptr("claude")
	mustIngest(t, c, featureEvent("s2", at.Add(3*time.Minute), u))
	u2 := update()
	u2.Blocker = ptr("")
	mustIngest(t, c, featureEvent("s1", at.Add(4*time.Minute), u2))
	f := featureOf(t, c)
	if len(f.Contributions) != 2 || f.Validation != "failed" || f.Implementation != "implemented" {
		t.Fatalf("peer failure erased: %+v", f)
	}
	if err := c.AcceptFeature(context.Background(), f.RepoID, f.ID, f.Candidate, f.Revision, "accepted"); err == nil {
		t.Fatal("accepted failing candidate")
	}
	u.Candidate = "sha-other"
	mustIngest(t, c, featureEvent("s2", at.Add(5*time.Minute), u))
	f = featureOf(t, c)
	if !f.Conflict || f.Implementation != "conflict" || f.Accepted {
		t.Fatal("parallel versions combined as complete")
	}
}
func TestFeatureRequiresBoundProjectAndAtomicBatch(t *testing.T) {
	c := newCore(t, nil)
	e := featureEvent("unbound", time.Now(), update())
	if _, err := c.Ingest(context.Background(), e); err == nil {
		t.Fatal("unbound report accepted")
	}
	var n int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM events`).Scan(&n)
	if n != 0 {
		t.Fatal("rejected report left partial event")
	}
	c, at := featureCore(t)
	bad := update()
	bad.ID = "second"
	bad.Title = ""
	if _, err := c.Ingest(context.Background(), featureEvent("s1", at.Add(time.Minute), update(), bad)); err == nil {
		t.Fatal("invalid new feature accepted")
	}
	c.St.R().QueryRow(`SELECT COUNT(*) FROM project_features`).Scan(&n)
	if n != 0 {
		t.Fatal("partial batch persisted")
	}
}
func TestFeatureRedactsAuditAndDoesNotPromoteStop(t *testing.T) {
	c, at := featureCore(t)
	u := update()
	u.Implementation = "unknown"
	u.Validation = "not_verified"
	u.Evidence = "password=synthetic-secret-value"
	mustIngest(t, c, featureEvent("s1", at.Add(time.Minute), u))
	mustIngest(t, c, ev("s1", event.KindStop, at.Add(2*time.Minute)))
	f := featureOf(t, c)
	if f.Implementation != "unknown" || f.Accepted {
		t.Fatal("Stop promoted feature")
	}
	var body string
	c.St.R().QueryRow(`SELECT body FROM events WHERE kind='features'`).Scan(&body)
	if strings.Contains(body, "synthetic-secret-value") {
		t.Fatal("raw audit contains secret")
	}
	u.Implementation = "accepted"
	if _, err := c.Ingest(context.Background(), featureEvent("s1", at.Add(3*time.Minute), u)); err == nil {
		t.Fatal("Agent set acceptance")
	}
}
func TestFeaturePartialValidationPreservesImplementationProvenance(t *testing.T) {
	c, at := featureCore(t)
	u := update()
	u.Validation = "not_verified"
	mustIngest(t, c, featureEvent("s1", at.Add(time.Minute), u))
	u.Implementation = ""
	u.Validation = "passed"
	mustIngest(t, c, featureEvent("s1", at.Add(2*time.Minute), u))
	f := featureOf(t, c)
	p := f.Contributions[0]
	if f.Implementation != "implemented" || p.ImplementationAt == p.ValidationAt {
		t.Fatal("validation changed implementation evidence age")
	}
}

func TestFeatureClosedReviewerFailureAndScopeConfirmation(t *testing.T) {
	c, at := featureCore(t)
	e := featureEvent("s1", at.Add(time.Minute), update())
	e.Features.ScopeStatus = "proposed"
	mustIngest(t, c, e)
	f := featureOf(t, c)
	if f.ScopeStatus != "proposed" {
		t.Fatal("scope implicitly confirmed")
	}
	if err := c.ConfirmFeatureScope(context.Background(), f.RepoID, f.ID, f.Revision); err != nil {
		t.Fatal(err)
	}
	if featureOf(t, c).ScopeStatus != "confirmed" {
		t.Fatal("explicit scope decision missing")
	}
	mustIngest(t, c, ev("reviewer", event.KindSessionStart, at))
	cl := ev("reviewer", event.KindClaim, at.Add(time.Second))
	cl.WorkTag = "FEAT-1"
	mustIngest(t, c, cl)
	u := update()
	u.Implementation = ""
	u.Validation = "failed"
	u.Blocker = ptr("review failed")
	mustIngest(t, c, featureEvent("reviewer", at.Add(2*time.Minute), u))
	mustIngest(t, c, ev("reviewer", event.KindSessionEnd, at.Add(3*time.Minute)))
	if featureOf(t, c).Validation != "failed" {
		t.Fatal("ending reviewer session erased failure")
	}
}
