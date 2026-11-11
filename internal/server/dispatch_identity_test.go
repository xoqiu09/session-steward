package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestDispatchProjectIdentityUsesExecutionRepository(t *testing.T) {
	h, st := dispatchServer(t, true)
	if err := st.Tx(context.Background(), func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO repos(id,name,common_dir,is_git,created_at) VALUES
		 (1,'同名项目','/synthetic/first/clone/.git',1,'2026-11-11T00:00:00Z'),
		 (2,'同名项目','/synthetic/second/clone.git',1,'2026-11-11T00:00:00Z'),
		 (3,'未授权项目','/synthetic/not-allowed/.git',1,'2026-11-11T00:00:00Z');
		 INSERT INTO dispatch_projects(repo_id,added_at) VALUES(1,'2026-11-11T00:00:00Z'),(2,'2026-11-11T00:00:00Z')`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	for _, q := range []drq{
		{method: "GET", host: localHost, remote: loopPeer, path: "/api/dispatch", cookie: cookieName, value: "pan"},
		{method: "POST", host: localHost, remote: loopPeer, path: "/api/dispatch/acquire", body: `{"client":"synthetic-identity-client"}`, cookie: cookieName, value: "pan"},
	} {
		w := ddo(h, q)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", q.path, w.Code, w.Body.String())
		}
		var got struct {
			Projects []struct {
				ID        int64  `json:"repo_id"`
				Name      string `json:"name"`
				CommonDir string `json:"common_dir"`
			} `json:"projects"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		if len(got.Projects) != 2 {
			t.Fatalf("only allowlisted identities: %+v", got.Projects)
		}
		want := map[int64]string{1: "/synthetic/first/clone/.git", 2: "/synthetic/second/clone.git"}
		for _, p := range got.Projects {
			if p.Name != "同名项目" || p.CommonDir != want[p.ID] {
				t.Fatalf("must show exact common_dir used by launch, not a guessed display root: %+v", p)
			}
		}
		if strings.Contains(w.Body.String(), "not-allowed") {
			t.Fatal("unrelated repository identity entered dispatch response")
		}
	}
}

func TestDispatchProjectIdentityIsNotAvailableToLiveCookie(t *testing.T) {
	h := liveServer(t, "liv")
	w := ddo(h, drq{method: "GET", host: localHost, remote: loopPeer, path: "/api/dispatch", cookie: liveCookie, value: "liv"})
	if w.Code != http.StatusUnauthorized || strings.Contains(w.Body.String(), "common_dir") {
		t.Fatalf("display token cannot read panel repository identity: %d %s", w.Code, w.Body.String())
	}
}
