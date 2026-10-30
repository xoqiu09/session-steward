package core

import (
	"context"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

func TestSnapshotAtMetadataDoesNotReviveStoppedSessions(t *testing.T) {
	for _, baseline := range []event.Kind{event.KindStop, event.KindSessionEnd} {
		for _, metadata := range []event.Kind{event.KindTaskCompleted, event.KindCompact, event.KindPermissionDenied, event.KindNotifyOther, event.KindCwdChanged} {
			t.Run(string(baseline)+"/"+string(metadata), func(t *testing.T) {
				c := newCore(t, nil)
				at := time.Now().Add(-time.Minute).UTC()
				mustIngest(t, c, ev("replay-observation", event.KindSessionStart, at))
				mustIngest(t, c, ev("replay-observation", baseline, at.Add(time.Second)))
				mustIngest(t, c, ev("replay-observation", metadata, at.Add(2*time.Second)))
				snap, err := c.SnapshotAt(context.Background(), at.Add(3*time.Second))
				if err != nil {
					t.Fatal(err)
				}
				want := "idle"
				if baseline == event.KindSessionEnd {
					want = "ended"
				}
				if len(snap.Sessions) != 1 || snap.Sessions[0].State != want {
					t.Fatalf("Metadata changed replay: %+v", snap.Sessions)
				}
				if snap.Sessions[0].LastActivityAt != at.Add(2*time.Second).Format("2006-01-02T15:04:05.000000000Z") {
					t.Fatal("Metadata did not update activity clock")
				}
			})
		}
	}
}

func TestSnapshotAtQuotaSeparatesRestoredWaitingAndDisabled(t *testing.T) {
	c := newCore(t, nil)
	at := time.Now().Add(-time.Minute).UTC()
	mustIngest(t, c, ev("replay-quota", event.KindToolPre, at))
	stale := ev("replay-quota", event.KindQuotaAwaitInput, at.Add(time.Second))
	stale.Reason = "quota_auto_resume_stale"
	mustIngest(t, c, stale)
	fired := ev("replay-quota", event.KindQuotaResumed, at.Add(3*time.Second))
	fired.Reason = "quota_auto_resume_fired"
	mustIngest(t, c, fired)
	disabled := ev("replay-quota", event.KindNotifyOther, at.Add(5*time.Second))
	disabled.Reason = "quota_auto_resume_disabled"
	mustIngest(t, c, disabled)
	for _, test := range []struct {
		offset        time.Duration
		state, reason string
	}{{2 * time.Second, "idle", "quota_auto_resume_stale"}, {4 * time.Second, "running", "quota_auto_resume_fired"}, {6 * time.Second, "running", "quota_auto_resume_fired"}} {
		snap, err := c.SnapshotAt(context.Background(), at.Add(test.offset))
		if err != nil {
			t.Fatal(err)
		}
		if len(snap.Sessions) != 1 || snap.Sessions[0].State != test.state || snap.Sessions[0].StateReason != test.reason {
			t.Fatalf("Wrong quota replay: %+v", snap.Sessions)
		}
		if len(snap.Approvals) != 0 || len(snap.WorkItems) != 0 {
			t.Fatal("Quota replay invented decisions or work")
		}
	}
}

func TestSnapshotAtObservationOnlyIsUnknownAndOldEndedRemainsEnded(t *testing.T) {
	c := newCore(t, nil)
	at := time.Now().Add(-time.Minute).UTC()
	mustIngest(t, c, ev("unknown", event.KindTaskCompleted, at))
	mustIngest(t, c, ev("old-ended", event.KindSessionEnd, at.Add(-8*24*time.Hour)))
	mustIngest(t, c, ev("old-ended", event.KindPermissionDenied, at))
	snap, err := c.SnapshotAt(context.Background(), at.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	states := map[string]string{}
	for _, s := range snap.Sessions {
		states[s.ProviderSessionID] = s.State
	}
	if states["unknown"] != "unknown" || states["old-ended"] != "ended" {
		t.Fatalf("No verified state must not imply running: %v", states)
	}
}
