package server

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"testing"
)

func TestOrchestrationAuthorizationAndLocalBoundary(t *testing.T) {
	h, st := dispatchServer(t, false)
	tests := []struct {
		name string
		q    drq
		want int
	}{
		{"local read", drq{method: "GET", host: localHost, remote: loopPeer, path: "/api/orchestration", cookie: cookieName, value: "pan"}, 200},
		{"hook cannot authorize", drq{method: "POST", host: localHost, remote: loopPeer, path: "/api/orchestration/mode", body: `{"mode":"enabled"}`, headers: map[string]string{"Authorization": "Bearer ing"}}, 401},
		{"remote read", drq{method: "GET", host: rh, remote: loopPeer, path: "/api/orchestration", cookie: remoteCookie, value: "rem"}, 403},
		{"proxy local read", drq{method: "GET", host: localHost, remote: loopPeer, path: "/api/orchestration", cookie: cookieName, value: "pan", headers: map[string]string{"X-Forwarded-For": "192.0.2.1"}}, 403},
		{"CSRF", drq{method: "POST", host: localHost, remote: loopPeer, path: "/api/orchestration/mode", body: `{"mode":"enabled"}`, cookie: cookieName, value: "pan", headers: map[string]string{"X-Steward": ""}}, 403},
		{"invented mode", drq{method: "POST", host: localHost, remote: loopPeer, path: "/api/orchestration/mode", body: `{"mode":"allow_everything"}`, cookie: cookieName, value: "pan"}, 400},
		{"cannot self attest authority", drq{method: "POST", host: localHost, remote: loopPeer, path: "/api/orchestration/mandates", body: `{"actor":"user","accepted":true}`, cookie: cookieName, value: "pan"}, 400},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			w := ddo(h, test.q)
			if w.Code != test.want {
				t.Fatalf("%d want %d: %s", w.Code, test.want, w.Body.String())
			}
		})
	}
	var n int
	st.R().QueryRow(`SELECT count(*) FROM orchestration_mandates`).Scan(&n)
	if n != 0 {
		t.Fatal("unauthorized mandate")
	}
	if !remoteBlocked(http.MethodGet, "/api/orchestration") {
		t.Fatal("remote orchestration information leaked")
	}
}
func TestOrchestrationLocalGrantReadAndRevoke(t *testing.T) {
	h, st := dispatchServer(t, false)
	if e := st.Tx(context.Background(), func(tx *sql.Tx) error {
		_, e := tx.Exec(`INSERT INTO repos(id,common_dir,name,is_git,created_at) VALUES(1,'/synthetic/.git','synthetic',1,'2026-11-02T00:00:00Z'); INSERT INTO dispatch_projects(repo_id,added_at) VALUES(1,'2026-11-02T00:00:00Z'); INSERT INTO work_items(id,repo_id,title,acceptance,created_at,updated_at) VALUES('ORC-1',1,'Synthetic work','Synthetic requirement','2026-11-02T00:00:00Z','2026-11-02T00:00:00Z')`)
		return e
	}); e != nil {
		t.Fatal(e)
	}
	q := drq{method: "POST", host: localHost, remote: loopPeer, path: "/api/orchestration/mandates", cookie: cookieName, value: "pan", body: `{"work_item_id":"ORC-1","revision":"user-grant","input":"SYNTHETIC-PRIVATE-TASK","store_input":true}`}
	if w := ddo(h, q); w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	q.method = "GET"
	q.path = "/api/orchestration"
	if w := ddo(h, q); w.Code != 200 || strings.Contains(w.Body.String(), "SYNTHETIC-PRIVATE-TASK") || !strings.Contains(w.Body.String(), `"mode":"disabled"`) {
		t.Fatal("view leaked or enabled", w.Body.String())
	}
	q.method = "POST"
	q.path = "/api/orchestration/mandates/ORC-1/revoke"
	q.body = `{"revision":"wrong-revision"}`
	if w := ddo(h, q); w.Code != 409 {
		t.Fatal("stale revoke accepted", w.Code)
	}
	q.body = `{"revision":"user-grant"}`
	if w := ddo(h, q); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var input string
	st.R().QueryRow(`SELECT input FROM orchestration_deliveries`).Scan(&input)
	if input != "" {
		t.Fatal("revoked input retained")
	}
}
