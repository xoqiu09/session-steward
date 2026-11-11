package core

import (
	"context"
	"errors"
	"testing"
)

func TestLiveCompanionDoesNotReplaceNotesOrReplayFromNoteInput(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	for _, p := range []string{"companion", "town", ""} {
		if _, err := c.SetLiveNote(ctx, LiveNote{Doing: "合成主题", Presentation: p}); err != nil {
			t.Fatal(err)
		}
		got, _ := c.LiveNote(ctx)
		if got.Presentation != p {
			t.Fatalf("layout not saved: %+v", got)
		}
	}
	if _, err := c.SetLiveNote(ctx, LiveNote{Presentation: "unknown"}); !errors.Is(err, ErrBadRequest) {
		t.Fatal("unknown layout accepted", err)
	}
	a, err := c.SetLiveCompanion(ctx, "walk")
	if err != nil || len(a.ID) != 32 || a.At == "" {
		t.Fatalf("gesture: %+v %v", a, err)
	}
	n, _ := c.LiveNote(ctx)
	if n.Doing != "合成主题" || n.Companion == nil || *n.Companion != a {
		t.Fatalf("gesture damaged note: %+v", n)
	}
	if _, err := c.SetLiveNote(ctx, LiveNote{Doing: "新主题", Presentation: "companion", Companion: &LiveCompanionAction{ID: "fake", Kind: "home"}}); err != nil {
		t.Fatal(err)
	}
	n, _ = c.LiveNote(ctx)
	if n.Doing != "新主题" || n.Companion == nil || *n.Companion != a {
		t.Fatalf("note save replaced gesture: %+v", n)
	}
	for _, bad := range []string{"", "run", "approve", "你好", "walk\n"} {
		if _, err := c.SetLiveCompanion(ctx, bad); !errors.Is(err, ErrBadRequest) {
			t.Fatal("arbitrary command accepted", bad, err)
		}
	}
	next, _ := c.SetLiveCompanion(ctx, "walk")
	if next.ID == a.ID {
		t.Fatal("repeated gesture needs a fresh identifier")
	}
	if err := c.St.SetMeta(ctx, liveCompanionKey, `{"id":"private-path","kind":"run","at":"2026-11-11T00:00:00Z"}`); err != nil {
		t.Fatal(err)
	}
	n, _ = c.LiveNote(ctx)
	if n.Companion != nil {
		t.Fatal("invalid saved gesture leaked")
	}
}
