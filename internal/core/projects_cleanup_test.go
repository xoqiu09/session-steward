package core

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/projectstructure"
)

func TestProjectListCarriesFeatureAndStructureEvidence(t *testing.T) {
	c := newCore(t, mixedLocator{})
	ctx := context.Background()
	at := time.Now().UTC()
	send := func(sid, cwd string, kind event.Kind, configure func(*event.Event)) {
		t.Helper()
		e := ev(sid, kind, at)
		e.Cwd = cwd
		if configure != nil {
			configure(e)
		}
		if _, err := c.Ingest(ctx, e); err != nil {
			t.Fatal(err)
		}
	}
	send("plain", "/synthetic/notes", event.KindPrompt, nil)
	send("built", "/repo-built", event.KindSessionStart, nil)
	// 功能登记的完整流程另有测试；这里只需要一条登记记录。
	if err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO project_features(repo_id,feature_id,title,created_at) SELECT repo_id,'synthetic-feature','合成功能',? FROM sessions WHERE provider_session_id='built'`, c.St.NowTS())
		return err
	}); err != nil {
		t.Fatal(err)
	}
	projects, err := c.Projects(ctx)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]ProjectInfo{}
	for _, p := range projects {
		byName[p.Name] = p
	}
	if p := byName["notes"]; p.Features != 0 || p.HasStructure {
		t.Fatalf("plain directory should have no evidence: %+v", p)
	}
	built := byName["repo-built"]
	if built.Features != 1 || built.HasStructure {
		t.Fatalf("feature count missing: %+v", built)
	}
	doc, _ := json.Marshal(projectstructure.Document{SchemaVersion: 1, Goal: "合成目标", BasisVersion: "synthetic", PreparedAt: "2026-11-04", Groups: []projectstructure.Group{{ID: "g", Title: "合成", Question: "合成？", Features: []projectstructure.Feature{{ID: "synthetic-feature"}}}}})
	if _, err := c.SaveProjectStructure(ctx, built.ID, doc, "", "user"); err != nil {
		t.Fatal(err)
	}
	projects, _ = c.Projects(ctx)
	for _, p := range projects {
		if p.ID == built.ID && !p.HasStructure {
			t.Fatal("structure not reported")
		}
	}
}
