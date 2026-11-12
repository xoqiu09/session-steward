package core

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

func contentFixture() LiveContent {
	c := emptyLiveContent()
	c.Items = []LiveContentItem{
		{ID: "public-a", Source: "compass", Title: "公开标题", Body: "合成公开内容", Enabled: true, Approved: true},
		{ID: "private-draft", Source: "compass", Title: "PRIVATE_DRAFT", Body: "PRIVATE_DRAFT_BODY", Enabled: true},
		{ID: "disabled", Source: "kuangye", Title: "DISABLED", Body: "DISABLED_BODY", Approved: true},
		{ID: "public-b", Source: "shufang", Title: "合成阅读", Body: "另一张公开卡", Enabled: true, Approved: true},
	}
	return c
}

func TestLiveContentReadingTopics(t *testing.T) {
	for _, topic := range []string{"", "emotion", "thinking", "self", "growth", "relationships", "wealth", "investing", "business", "society", "ai", "meaning", "health", "family"} {
		in := contentFixture()
		in.Items[0].Topic = topic
		if err := validateLiveContent(in); err != nil {
			t.Fatalf("valid topic %q: %v", topic, err)
		}
		if got := publicLiveContent(in).Items[0].Topic; got != topic {
			t.Fatalf("public topic: got %q want %q", got, topic)
		}
	}
	for _, topic := range []string{"__proto__", "emotion ", "Emotion", "/PRIVATE_TOPIC_CANARY"} {
		in := contentFixture()
		in.Items[0].Topic = topic
		if err := validateLiveContent(in); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("invalid topic %q accepted: %v", topic, err)
		}
	}
	legacy := contentFixture()
	b, _ := json.Marshal(publicLiveContent(legacy))
	if strings.Contains(string(b), `"topic"`) {
		t.Fatal("legacy cards unexpectedly gained a topic")
	}
	ctx := context.Background()
	c := newCore(t, nil)
	in := contentFixture()
	in.Items[0].Topic = "emotion"
	saved, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: in, Action: "save"})
	if err != nil {
		t.Fatal(err)
	}
	read, err := c.LiveContent(ctx)
	if err != nil || read.Items[0].Topic != "emotion" {
		t.Fatalf("topic not retained: %+v %v", read, err)
	}
	saved.Items[0].Topic = "PRIVATE_TOPIC_CANARY"
	if _, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: saved, Action: "save"}); !errors.Is(err, ErrBadRequest) {
		t.Fatalf("bad update accepted: %v", err)
	}
	read, _ = c.LiveContent(ctx)
	if read.Items[0].Topic != "emotion" {
		t.Fatal("failed validation changed saved topic")
	}
}
func TestLiveContentDraftBoundary(t *testing.T) {
	ctx := context.Background()
	c := newCore(t, nil)
	blank, err := c.LiveContent(ctx)
	if err != nil || len(blank.Items) != 0 || blank.Playing {
		t.Fatalf("default: %+v %v", blank, err)
	}
	saved, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: contentFixture(), Action: "save"})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Playing {
		t.Fatal("editing must not auto-start")
	}
	note, err := c.LiveNote(ctx)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(note)
	for _, secret := range []string{"PRIVATE_DRAFT", "DISABLED", "revision", "approved", "enabled"} {
		if strings.Contains(string(b), secret) {
			t.Fatalf("display leaked %s: %s", secret, b)
		}
	}
	if len(note.Content.Items) != 2 {
		t.Fatalf("public items: %+v", note.Content)
	}
	saved.Sources = []string{"compass"}
	_, err = c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: saved, Action: "save"})
	if err != nil {
		t.Fatal(err)
	}
	note, _ = c.LiveNote(ctx)
	if len(note.Content.Items) != 1 {
		t.Fatal("disabled source still public")
	}
	// Saving a note cannot replace the owner's playlist or smuggle fields into its public projection.
	_, err = c.SetLiveNote(ctx, LiveNote{Presentation: "studio", Content: &PublicLiveContent{Items: []PublicLiveContentItem{{ID: "smuggled"}}}})
	if err != nil {
		t.Fatal(err)
	}
	note, _ = c.LiveNote(ctx)
	if note.Content.Items[0].ID != "public-a" {
		t.Fatal("note write replaced playlist")
	}
}
func TestLiveContentPlaybackAndConcurrentEdits(t *testing.T) {
	ctx := context.Background()
	c := newCore(t, nil)
	saved, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: contentFixture(), Action: "save"})
	if err != nil {
		t.Fatal(err)
	}
	playing, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: saved, Action: "play"})
	if err != nil || !playing.Playing {
		t.Fatalf("play: %v", err)
	}
	if liveContentIndex(playing, liveAt(playing.Anchor).Add(41*time.Second)) != 1 {
		t.Fatal("clock did not advance")
	}
	pausedAt := liveAt(playing.Anchor).Add(41 * time.Second)
	c.St.Now = func() time.Time { return pausedAt }
	paused, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: playing, Action: "pause"})
	if err != nil || paused.Playing {
		t.Fatalf("pause: %v", err)
	}
	if liveContentIndex(paused, liveAt(paused.Anchor).Add(24*time.Hour)) != 1 {
		t.Fatal("paused card advanced")
	}
	next, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: paused, Action: "next"})
	if err != nil || next.Selected != "public-a" {
		t.Fatalf("next: %+v %v", next, err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Go(func() {
			_, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: next, Action: "next"})
			results <- err
		})
	}
	wg.Wait()
	close(results)
	ok, conflicts := 0, 0
	for err := range results {
		if err == nil {
			ok++
		} else if errors.Is(err, ErrConflict) {
			conflicts++
		} else {
			t.Fatal(err)
		}
	}
	if ok != 1 || conflicts != 1 {
		t.Fatalf("concurrent writes: %d success / %d conflicts", ok, conflicts)
	}
}
func TestLiveContentRejectsMalformedAndCorruptData(t *testing.T) {
	c := newCore(t, nil)
	ctx := context.Background()
	for _, change := range []func(*LiveContent){
		func(c *LiveContent) { c.Items[0].Body = strings.Repeat("字", 241) },
		func(c *LiveContent) { c.Items[0].Body = "a\nb" },
		func(c *LiveContent) { c.Items[0].Source = "private-files" },
		func(c *LiveContent) { c.Items[1].ID = c.Items[0].ID },
		func(c *LiveContent) { c.Items[0].Title = " " },
		func(c *LiveContent) { c.Interval = 1 },
	} {
		in := contentFixture()
		change(&in)
		if _, err := c.SetLiveContent(ctx, LiveContentUpdate{LiveContent: in, Action: "save"}); !errors.Is(err, ErrBadRequest) {
			t.Fatalf("accepted invalid data: %v", err)
		}
	}
	if err := c.St.SetMeta(ctx, liveContentKey, `{"items":[{"body":"SECRET"}]}`); err != nil {
		t.Fatal(err)
	}
	note, _ := c.LiveNote(ctx)
	if note.Content != nil {
		t.Fatal("corrupt config reached display")
	}
}
