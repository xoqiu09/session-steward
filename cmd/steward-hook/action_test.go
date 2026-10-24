package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/hook"
)

func TestStructuredDeliveryDoesNotPublishOptionsAsProse(t *testing.T) {
	var got event.Event
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"acked": []string{got.EventID}})
	}))
	defer server.Close()
	client := &hook.Client{BaseURL: server.URL, HostID: "test-host"}
	code := agentAction(context.Background(), client, []string{"deliver", "--stage", "validating", "--summary", "Candidate ready", "--progress", "Checks passed", "--blocker", "", "--next", "Review report", "--next-owner", "user", "--session=test-session", "--provider", "codex"})
	if code != 0 || got.Text != "Candidate ready" || got.Brief["progress"] != "Checks passed" || got.Brief["blocker"] != "" || got.SessionID != "test-session" || got.Source.Provider != "codex" {
		t.Fatalf("code=%d event=%+v", code, got)
	}
	for _, args := range [][]string{{"deliver", "--sumary", "Typo"}, {"deliver", "--summary"}, {"ask", "--stage", "validating"}} {
		if code := agentAction(context.Background(), client, args); code != 2 {
			t.Fatalf("invalid options published as prose: %v, code=%d", args, code)
		}
	}
	if calls != 1 {
		t.Fatal("invalid input reached the service")
	}
}

// A delivered HTTP response for another event must not become CLI success.
func TestAgentActionRejectsAnotherEventACK(t *testing.T) {
	ids := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var e event.Event
		if err := json.NewDecoder(r.Body).Decode(&e); err != nil {
			t.Error(err)
			http.Error(w, "bad synthetic input", 400)
			return
		}
		ids <- e.EventID
		json.NewEncoder(w).Encode(map[string]any{"acked": []string{"unrelated-synthetic-event"}})
	}))
	defer srv.Close()
	client := &hook.Client{BaseURL: srv.URL, HostID: "synthetic-host", Token: "synthetic-token", HTTP: srv.Client()}
	code := agentAction(context.Background(), client, []string{"deliver", "--summary", "Synthetic delivery", "--session", "synthetic-session", "--provider", "codex"})
	if code == 0 {
		t.Fatal("CLI reported success without this event's ACK")
	}
	select {
	case id := <-ids:
		if id == "" || id == "unrelated-synthetic-event" {
			t.Fatal("invalid synthetic request ID")
		}
	default:
		t.Fatal("valid action never reached synthetic server")
	}
}
