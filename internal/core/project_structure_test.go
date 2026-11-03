package core

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/projectstructure"
)

func syntheticStructure() json.RawMessage {
	d := projectstructure.Document{SchemaVersion: 1, Goal: "Synthetic project", Audience: "Operator", Scope: "Read and export", PreparedAt: "2026-11-03", BasisVersion: "synthetic-sha", Groups: []projectstructure.Group{{ID: "output", Title: "Output", Features: []projectstructure.Feature{{ID: "export", Label: "Export rows"}}}}}
	raw, _ := json.Marshal(d)
	return raw
}

func TestProjectStructurePreservesBusinessFactsAndManualEdits(t *testing.T) {
	ctx := context.Background()
	c, at := featureCore(t)
	mustIngest(t, c, featureEvent("s1", at.Add(time.Minute), update()))
	f := featureOf(t, c)
	if err := c.AcceptFeature(ctx, f.RepoID, f.ID, f.Candidate, f.Revision, "accepted"); err != nil {
		t.Fatal(err)
	}
	before, _ := c.Snapshot(ctx)
	p, err := c.SaveProjectStructure(ctx, f.RepoID, syntheticStructure(), "", "agent")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.SaveProjectStructure(ctx, f.RepoID, syntheticStructure(), "", "agent"); !errors.Is(err, ErrConflict) {
		t.Fatal("stale replacement accepted", err)
	}
	bad := json.RawMessage(string(syntheticStructure()))
	bad = []byte(string(bad[:]))
	var d projectstructure.Document
	json.Unmarshal(bad, &d)
	d.Groups[0].Features[0].ID = "foreign-feature"
	bad, _ = json.Marshal(d)
	if _, err = c.SaveProjectStructure(ctx, f.RepoID, bad, p.Revision, "agent"); !errors.Is(err, ErrBadRequest) {
		t.Fatal("unregistered feature accepted", err)
	}
	p, err = c.SaveProjectStructure(ctx, f.RepoID, syntheticStructure(), p.Revision, "user")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.SaveProjectStructure(ctx, f.RepoID, syntheticStructure(), p.Revision, "agent"); !errors.Is(err, ErrConflict) {
		t.Fatal("manual directory overwritten", err)
	}
	read, err := c.ProjectStructure(ctx, f.RepoID)
	if err != nil || !reflect.DeepEqual(read, p) {
		t.Fatal(read, err)
	}
	after, _ := c.Snapshot(ctx)
	for name, pair := range map[string][2]any{"features": {before.Features, after.Features}, "work": {before.WorkItems, after.WorkItems}, "runs": {before.Runs, after.Runs}, "sessions": {before.Sessions, after.Sessions}, "approvals": {before.Approvals, after.Approvals}} {
		if !reflect.DeepEqual(pair[0], pair[1]) {
			t.Fatalf("structure changed %s", name)
		}
	}
	if len(after.Structures) != 1 {
		t.Fatal("structure missing from snapshot")
	}
	if err = c.ArchiveProjects(ctx, []int64{f.RepoID}, true); err != nil {
		t.Fatal(err)
	}
	hidden, _ := c.Snapshot(ctx)
	if len(hidden.Structures) != 0 {
		t.Fatal("archived description leaked")
	}
	if err = c.ArchiveProjects(ctx, []int64{f.RepoID}, false); err != nil {
		t.Fatal(err)
	}
	restored, _ := c.Snapshot(ctx)
	if len(restored.Structures) != 1 || restored.Structures[0].Revision != p.Revision {
		t.Fatal("restore lost directory")
	}
	if len(trimForHub(restored).Structures) != 0 {
		t.Fatal("private description added to device export")
	}
	merged, err := c.HubCombine(ctx, "self", "Synthetic device", &Snapshot{})
	if err != nil || len(merged.Structures) != 1 || len(merged.Features) != 1 {
		t.Fatal("local directory missing in combined view", err)
	}
	replay, err := c.SnapshotAt(ctx, at.Add(2*time.Minute))
	if err != nil || len(replay.Structures) != 0 {
		t.Fatal("live description leaked into historical replay", err)
	}
}

func TestConcurrentStructureUpdatesRequireExactRevision(t *testing.T) {
	ctx := context.Background()
	c, at := featureCore(t)
	mustIngest(t, c, featureEvent("s1", at.Add(time.Minute), update()))
	repo := featureOf(t, c).RepoID
	p, err := c.SaveProjectStructure(ctx, repo, syntheticStructure(), "", "agent")
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := c.SaveProjectStructure(ctx, repo, syntheticStructure(), p.Revision, "agent")
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	ok, conflict := 0, 0
	for err := range results {
		if err == nil {
			ok++
		} else if errors.Is(err, ErrConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatal("lost update", ok, conflict)
	}
}
