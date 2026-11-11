package core

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestLiveResidentsRotationCoversSevenAndWraps(t *testing.T) {
	anchor := time.Date(2026, 11, 11, 0, 0, 0, 0, time.UTC)
	r := &LiveResidents{Resident: "gpt", Mode: "auto", Interval: 120, Anchor: anchor.Format(time.RFC3339)}
	for step, want := range append(append([]string{}, liveResidentIDs...), "gpt") {
		if got := currentLiveResident(r, anchor.Add(time.Duration(step)*120*time.Second)); got != want {
			t.Fatalf("step %d: got %s want %s", step, got, want)
		}
	}
	r.Mode = "fixed"
	r.Resident = "claude"
	if currentLiveResident(r, anchor.Add(24*time.Hour)) != "claude" {
		t.Fatal("fixed mode rotated")
	}
	r.Mode = "auto"
	if currentLiveResident(r, anchor.Add(-time.Second)) != "claude" {
		t.Fatal("future anchor produced a negative step")
	}
}

func TestLiveResidentsOnlyWriteVisualMetaAndPinGesture(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	saved, err := c.SetLiveResidents(ctx, LiveResidents{Resident: "claude", Mode: "fixed", Interval: 120, Anchor: "ignored"})
	if err != nil || saved.Anchor == "" || saved.Anchor == "ignored" {
		t.Fatal(saved, err)
	}
	n, err := c.LiveNote(ctx)
	if err != nil || n.Residents == nil || *n.Residents != saved {
		t.Fatal("control not read back", n, err)
	}
	a, err := c.SetLiveCompanion(ctx, "pat")
	if err != nil || a.Resident != "claude" {
		t.Fatal("gesture did not target the current resident", a, err)
	}
	if _, err = c.SetLiveNote(ctx, LiveNote{Doing: "合成公开主题", Residents: &LiveResidents{Resident: "grok"}}); err != nil {
		t.Fatal(err)
	}
	n, _ = c.LiveNote(ctx)
	if n.Doing != "合成公开主题" || n.Residents == nil || *n.Residents != saved || n.Companion == nil || n.Companion.Resident != "claude" {
		t.Fatal("note overwrote independent controls", n)
	}
	for _, bad := range []LiveResidents{{Resident: "unknown", Mode: "auto", Interval: 120}, {Resident: "gpt", Mode: "run", Interval: 120}, {Resident: "gpt", Mode: "auto", Interval: 1}, {Resident: "../../private", Mode: "fixed", Interval: 60}} {
		if _, err := c.SetLiveResidents(ctx, bad); !errors.Is(err, ErrBadRequest) {
			t.Fatal("invalid public setting accepted", bad, err)
		}
	}
	n, _ = c.LiveNote(ctx)
	if n.Residents == nil || *n.Residents != saved {
		t.Fatal("rejected update changed control")
	}
	if err := c.St.SetMeta(ctx, liveResidentsKey, `{"resident":"private-path","mode":"auto","interval_seconds":120,"anchor":"2026-11-11T00:00:00Z"}`); err != nil {
		t.Fatal(err)
	}
	n, _ = c.LiveNote(ctx)
	if n.Residents != nil {
		t.Fatal("invalid saved control leaked")
	}
}
