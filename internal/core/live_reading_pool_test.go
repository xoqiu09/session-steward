package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

func poolFixture(n int) LiveReadingPool {
	out := LiveReadingPool{SourceCount: n, Items: []PublicLiveContentItem{}}
	for i := range n {
		out.Items = append(out.Items, PublicLiveContentItem{ID: fmt.Sprintf("synthetic-%05d", i), Source: "kuangye", Title: fmt.Sprintf("合成的独立思考摘句，编号%d。", i), Credit: "摘句", Topic: []string{"emotion", "thinking", "self"}[i%3]})
	}
	return out
}
func currentReading(t *testing.T, in LiveContent, pool LiveReadingPool, now time.Time) PublicLiveContentItem {
	t.Helper()
	pub := randomPublicContent(in, pool, now)
	index := 0
	if in.Playing {
		index = int(now.Sub(liveAt(pub.Anchor)) / (time.Duration(in.Interval) * time.Second))
	} else {
		index = slices.IndexFunc(pub.Items, func(x PublicLiveContentItem) bool { return x.ID == pub.Selected })
	}
	if index < 0 || index >= len(pub.Items) {
		t.Fatalf("window does not cover cursor: %d", index)
	}
	return pub.Items[index]
}
func TestReadingShuffleAndRollingWindow(t *testing.T) {
	for _, n := range []int{1, 2, 3, 13, 37, 3000} {
		for cycle := int64(0); cycle < 4; cycle++ {
			order := readingOrder(n, "seed", cycle)
			seen := map[int]bool{}
			for _, i := range order {
				if i < 0 || i >= n || seen[i] {
					t.Fatal("not a permutation")
				}
				seen[i] = true
			}
			if n > 1 && cycle > 0 && order[0] == readingOrder(n, "seed", cycle-1)[n-1] {
				t.Fatal("boundary repeat")
			}
		}
	}
	in := emptyLiveContent()
	in.Mode = "random"
	in.RandomSeed = "private-seed"
	in.Playing = true
	in.Anchor = "2026-11-12T00:00:00Z"
	pool := poolFixture(3000)
	now := liveAt(in.Anchor)
	seen := map[string]bool{}
	// A synthetic 24-hour schedule, including every rolling-window refresh.
	for slot := 0; slot < 2160; slot++ {
		at := now.Add(time.Duration(slot) * 40 * time.Second)
		item := currentReading(t, in, pool, at)
		if seen[item.Title] {
			t.Fatalf("repeated before full cycle at %d", slot)
		}
		seen[item.Title] = true
		again := currentReading(t, in, pool, at)
		if item != again {
			t.Fatal("two displays disagree")
		}
		pub := randomPublicContent(in, pool, at)
		if len(pub.Items) != LiveContentMax {
			t.Fatal("unbounded public window")
		}
		ids := map[string]bool{}
		for _, x := range pub.Items {
			if ids[x.ID] {
				t.Fatal("duplicate occurrence ID")
			}
			ids[x.ID] = true
		}
	}
	for _, n := range []int{1, 2, 13} {
		pub := randomPublicContent(in, poolFixture(n), now)
		ids := map[string]bool{}
		for _, x := range pub.Items {
			if ids[x.ID] {
				t.Fatal("small library duplicate IDs")
			}
			ids[x.ID] = true
		}
	}
	// Refresh at stride 12 does not change the visible card at the same time.
	at := now.Add(12 * 40 * time.Second)
	old := randomPublicContent(in, pool, at.Add(-time.Millisecond))
	fresh := randomPublicContent(in, pool, at)
	if old.Items[12] != fresh.Items[0] {
		t.Fatal("window refresh skipped or replayed a card")
	}
}
func TestRandomContentControlsRetainManualDrafts(t *testing.T) {
	ctx := context.Background()
	c := newCore(t, nil)
	manual, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: contentFixture(), Action: "save"})
	if err != nil {
		t.Fatal(err)
	}
	missing := manual
	missing.Mode = "random"
	if _, err = c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: missing, Action: "save"}); !errors.Is(err, ErrBadRequest) {
		t.Fatal("missing library accepted")
	}
	pool := poolFixture(37)
	library, err := c.SetLiveReadingPool(ctx, LiveReadingPoolUpdate{LiveReadingPool: pool, Confirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	if library.Count != 37 || library.Topics["emotion"] != 13 {
		t.Fatal("incorrect library summary")
	}
	in := manual
	in.Mode = "random"
	in.RandomSeed = "CLIENT_CANNOT_CHOOSE"
	in.RandomOffset = 123456
	random, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: in, Action: "save"})
	if err != nil {
		t.Fatal(err)
	}
	if random.Playing || len(random.RandomSeed) != 32 || random.RandomOffset != 0 || random.RandomSeed == in.RandomSeed {
		t.Fatal("untrusted cursor or auto-start")
	}
	random, err = c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: random, Action: "play"})
	if err != nil {
		t.Fatal(err)
	}
	start := liveAt(random.Anchor)
	c.St.Now = func() time.Time { return start.Add(81 * time.Second) }
	current := currentReading(t, random, pool, c.St.Now())
	paused, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: random, Action: "pause"})
	if err != nil {
		t.Fatal(err)
	}
	if paused.Playing || paused.RandomOffset != 2 || currentReading(t, paused, pool, start.Add(24*time.Hour)).Title != current.Title {
		t.Fatal("pause moved card")
	}
	// A fresh Core reads the same persisted seed/cursor (no browser or process-local RNG).
	restored, err := New(c.St, nil).LiveContent(ctx)
	if err != nil || restored.RandomSeed != paused.RandomSeed || restored.RandomOffset != paused.RandomOffset {
		t.Fatal("cursor not persisted")
	}
	next, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: paused, Action: "next"})
	if err != nil || next.RandomOffset != 3 || next.Playing {
		t.Fatalf("paused next: %v", err)
	}
	if _, err = c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: paused, Action: "next"}); !errors.Is(err, ErrConflict) {
		t.Fatal("stale write accepted")
	}
	if _, err = c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: next, Action: "select"}); !errors.Is(err, ErrBadRequest) {
		t.Fatal("random select accepted")
	}
	note, err := c.LiveNote(ctx)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(note)
	for _, private := range []string{"PRIVATE_DRAFT", "DISABLED", next.RandomSeed, "random_seed", "random_offset", "source_count", "revision", "approved"} {
		if strings.Contains(string(b), private) {
			t.Fatalf("public leaked %s", private)
		}
	}
	if len(note.Content.Items) != 24 || note.Content.Mode != "random" {
		t.Fatal("wrong random projection")
	}
	original := next
	original.Mode = ""
	back, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: original, Action: "save"})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(back.Items, manual.Items) || back.Selected != manual.Selected || back.RandomSeed != "" || back.Mode != "" {
		t.Fatal("manual draft changed during random playback")
	}
	// Pool replacement resets only the random cursor and revision, preserving pause.
	original = back
	original.Mode = "random"
	random, err = c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: original, Action: "save"})
	if err != nil {
		t.Fatal(err)
	}
	pool.Revision = library.Revision
	if _, err = c.SetLiveReadingPool(ctx, LiveReadingPoolUpdate{LiveReadingPool: pool, Confirmed: true}); err != nil {
		t.Fatal(err)
	}
	replaced, _ := c.LiveContent(ctx)
	if replaced.Playing || replaced.RandomSeed == random.RandomSeed || replaced.Revision == random.Revision || !slices.Equal(replaced.Items, manual.Items) {
		t.Fatal("replace did not reset safely")
	}
}
func TestReadingPoolValidationAndRevision(t *testing.T) {
	ctx := context.Background()
	c := newCore(t, nil)
	pool := poolFixture(13)
	if _, err := c.SetLiveReadingPool(ctx, LiveReadingPoolUpdate{LiveReadingPool: pool}); !errors.Is(err, ErrBadRequest) {
		t.Fatal("unconfirmed import accepted")
	}
	for _, change := range []func(*LiveReadingPool){
		func(p *LiveReadingPool) { p.Items[0].Title = "旷野之心" },
		func(p *LiveReadingPool) { p.Items[0].Credit = "http://private" },
		func(p *LiveReadingPool) { p.Items[0].Body = "PRIVATE_BODY" },
		func(p *LiveReadingPool) { p.Items[0].Topic = "PRIVATE_TOPIC" },
		func(p *LiveReadingPool) { p.Items[0].Source = "shufang" },
		func(p *LiveReadingPool) { p.Items[0].ID = "/private/path" },
		func(p *LiveReadingPool) { p.Items[0].Title = strings.Repeat("字", 49) },
		func(p *LiveReadingPool) { p.Items[1] = p.Items[0] },
		func(p *LiveReadingPool) { p.SourceCount = 0 },
	} {
		bad := poolFixture(13)
		change(&bad)
		if _, err := c.SetLiveReadingPool(ctx, LiveReadingPoolUpdate{LiveReadingPool: bad, Confirmed: true}); !errors.Is(err, ErrBadRequest) {
			t.Fatal("malformed import accepted")
		}
	}
	saved, err := c.SetLiveReadingPool(ctx, LiveReadingPoolUpdate{LiveReadingPool: pool, Confirmed: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = c.SetLiveReadingPool(ctx, LiveReadingPoolUpdate{LiveReadingPool: pool, Confirmed: true}); !errors.Is(err, ErrConflict) {
		t.Fatal("stale library replacement accepted")
	}
	summary, err := c.LiveReadingPool(ctx)
	if err != nil || summary.Revision != saved.Revision || summary.Count != 13 {
		t.Fatal("library summary changed after rejection")
	}
}
