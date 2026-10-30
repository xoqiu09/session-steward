package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/store"
)

func collectedSignalEvent(id string, kind event.Kind, channel string, at time.Time) event.Event {
	return event.Event{EventID: id, SchemaVersion: 1, SessionID: "synthetic-signal", Source: event.Source{Provider: "claude", HostID: "synthetic", Channel: channel}, Kind: kind, OccurredAt: at, WorkTag: "SIG-1", Text: "合成交付", Brief: map[string]string{"progress": "合成进展"}}
}

func seedCollectedSignal(t *testing.T, c *core.Core) time.Time {
	t.Helper()
	at := time.Date(2026, 10, 30, 10, 0, 0, 0, time.UTC)
	c.St.Now = func() time.Time { return at.Add(2 * time.Hour) }
	if err := c.CreateWorkItem(context.Background(), core.WorkItemInput{ID: "SIG-1", Title: "合成工作"}); err != nil {
		t.Fatal(err)
	}
	for i, kind := range []event.Kind{event.KindSessionStart, event.KindClaim} {
		e := collectedSignalEvent(fmt.Sprint("seed-", i), kind, "hook", at.Add(time.Duration(i)*time.Second))
		if _, err := c.Ingest(context.Background(), &e); err != nil {
			t.Fatal(err)
		}
	}
	return at
}

func signalHookRequest(t *testing.T, ts *httptest.Server, path string, body any) (int, []byte) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	r, err := http.NewRequest("POST", ts.URL+path, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	r.Header.Set("Authorization", "Bearer ing")
	resp, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err = io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, b
}

func signalState(t *testing.T, c *core.Core) (*core.Snapshot, int) {
	t.Helper()
	snap, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := c.St.R().QueryRow(`SELECT COUNT(*) FROM events`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return snap, count
}

func TestHookRoutesRejectReservedChannelsWithoutChangingFacts(t *testing.T) {
	for _, path := range []string{"/hook/event", "/hook/agent-action"} {
		t.Run(path, func(t *testing.T) {
			ts, c, _ := start(t)
			at := seedCollectedSignal(t, c)
			before, count := signalState(t, c)
			for i, channel := range []string{"user", "git", "github", "hub", "model", "future", "HOOK", " hook"} {
				t.Run(channel, func(t *testing.T) {
					kind := event.KindSessionEnd
					if path == "/hook/agent-action" {
						kind = event.KindDeliver
					}
					e := collectedSignalEvent(fmt.Sprint("untrusted-", i), kind, channel, at.Add(time.Hour))
					code, body := signalHookRequest(t, ts, path, e)
					if code != http.StatusBadRequest || !strings.Contains(string(body), "仅允许空值、hook、transcript、process") || !strings.Contains(string(body), channel) {
						t.Fatalf("%q: %d %s", channel, code, body)
					}
					after, gotCount := signalState(t, c)
					if count != gotCount || !reflect.DeepEqual(before, after) {
						t.Fatal("rejected channel changed last signal, activity, work state, cursor or event history")
					}
				})
			}
		})
	}
}

func TestHookRoutesAcceptCollectionChannels(t *testing.T) {
	for _, path := range []string{"/hook/event", "/hook/agent-action"} {
		for _, channel := range []string{"", "hook", "transcript", "process"} {
			t.Run(path+"/"+channel, func(t *testing.T) {
				ts, c, _ := start(t)
				at := seedCollectedSignal(t, c).Add(time.Hour)
				kind := event.KindToolPost
				if path == "/hook/agent-action" {
					kind = event.KindReport
				}
				e := collectedSignalEvent("accepted-channel", kind, channel, at)
				code, body := signalHookRequest(t, ts, path, e)
				var result struct{ Acked []string }
				if err := json.Unmarshal(body, &result); err != nil || code != http.StatusOK || len(result.Acked) != 1 || result.Acked[0] != e.EventID {
					t.Fatalf("%d %s (%v)", code, body, err)
				}
				snap, _ := signalState(t, c)
				for _, signal := range []*core.Signal{snap.Sessions[0].Signal, snap.WorkItems[0].Signal} {
					if signal == nil || signal.Channel != event.Channel(channel) || signal.At != store.TS(at) {
						t.Fatalf("allowed channel not recorded: %+v", signal)
					}
				}
			})
		}
	}
}

func TestHookBatchChecksChannelsBeforeWritingAnyEvent(t *testing.T) {
	ts, c, _ := start(t)
	at := seedCollectedSignal(t, c)
	before, count := signalState(t, c)
	batch := []event.Event{
		collectedSignalEvent("would-be-valid", event.KindToolPost, "hook", at.Add(time.Hour)),
		collectedSignalEvent("spoofed-user", event.KindSessionEnd, "user", at.Add(time.Hour)),
	}
	if code, body := signalHookRequest(t, ts, "/hook/event", batch); code != http.StatusBadRequest {
		t.Fatalf("%d %s", code, body)
	}
	after, gotCount := signalState(t, c)
	if count != gotCount || !reflect.DeepEqual(before, after) {
		t.Fatal("batch wrote a valid prefix before rejecting an untrusted source")
	}
}

func TestTrustedPanelStillRecordsUserSignalAfterHookRejection(t *testing.T) {
	ts, c, _ := start(t)
	at := seedCollectedSignal(t, c)
	before, _ := signalState(t, c)
	e := collectedSignalEvent("spoofed-user", event.KindSessionEnd, "user", at.Add(time.Hour))
	if code, body := signalHookRequest(t, ts, "/hook/event", e); code != http.StatusBadRequest {
		t.Fatalf("%d %s", code, body)
	}
	path := fmt.Sprintf("/api/sessions/%d/unbind", before.Sessions[0].ID)
	if code, body := panelReq(t, ts, "POST", path, map[string]string{}); code != http.StatusOK {
		t.Fatalf("panel user action rejected: %d %s", code, body)
	}
	after, _ := signalState(t, c)
	if after.Sessions[0].Signal == nil || after.Sessions[0].Signal.Channel != "user" || after.Sessions[0].Signal.At != c.St.NowTS() || after.Sessions[0].LastActivityAt != before.Sessions[0].LastActivityAt {
		t.Fatalf("trusted user signal missing or refreshed agent activity: %+v", after.Sessions[0])
	}
}

func TestPanelSignalUsesUserChannelOnlyAfterAuthorizedSuccessfulChange(t *testing.T) {
	ts, c, _ := start(t)
	_, err := c.Ingest(context.Background(), &event.Event{EventID: "synthetic", SessionID: "synthetic", SchemaVersion: 1, Source: event.Source{Provider: "claude", HostID: "synthetic"}, Kind: event.KindSessionStart, OccurredAt: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if code, b := panelReq(t, ts, "POST", "/api/work-items", map[string]any{"id": "SIG-1", "title": "Synthetic"}); code != 201 {
		t.Fatalf("%d %s", code, b)
	}
	var body string
	c.St.R().QueryRow(`SELECT body FROM events WHERE kind='user_action'`).Scan(&body)
	var e event.Event
	if err := json.Unmarshal([]byte(body), &e); err != nil || e.Source.Channel != "user" || e.Source.Ref != "panel:work_item.create" {
		t.Fatalf("%s %v", body, err)
	}
	if code, _ := panelReq(t, ts, "GET", "/api/snapshot", nil); code != 200 {
		t.Fatal(code)
	}
	var count int
	c.St.R().QueryRow(`SELECT COUNT(*) FROM sessions`).Scan(&count)
	if count != 1 {
		t.Fatal("user edit fabricated a session")
	}
	if code, _ := panelReq(t, ts, "PATCH", "/api/work-items/MISSING-1", map[string]any{"title": "should fail"}); code != 404 {
		t.Fatal(code)
	}
	c.St.R().QueryRow(`SELECT COUNT(*) FROM events WHERE kind='user_action'`).Scan(&count)
	if count != 1 {
		t.Fatal("failed operation audited")
	}
}
