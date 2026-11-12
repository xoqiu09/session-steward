package core

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const liveContentKey = "live:content"
const LiveContentMax = 24

// Drafts belong to the owner. Only explicitly approved and enabled cards enter LiveNote.
type LiveContentItem struct {
	ID       string `json:"id"`
	Source   string `json:"source"`
	Title    string `json:"title"`
	Body     string `json:"body"`
	Credit   string `json:"credit"`
	Enabled  bool   `json:"enabled"`
	Approved bool   `json:"approved"`
}
type LiveContent struct {
	Revision string            `json:"revision"`
	Items    []LiveContentItem `json:"items"`
	Sources  []string          `json:"sources"`
	Playing  bool              `json:"playing"`
	Interval int               `json:"interval_seconds"`
	Selected string            `json:"selected_id"`
	Anchor   string            `json:"anchor"`
	Focus    string            `json:"focus"`
}
type LiveContentUpdate struct {
	LiveContent
	Action string `json:"action"`
}
type PublicLiveContentItem struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	Credit string `json:"credit"`
}
type PublicLiveContent struct {
	Items    []PublicLiveContentItem `json:"items"`
	Playing  bool                    `json:"playing"`
	Interval int                     `json:"interval_seconds"`
	Selected string                  `json:"selected_id"`
	Anchor   string                  `json:"anchor"`
	Focus    string                  `json:"focus"`
}

func emptyLiveContent() LiveContent {
	return LiveContent{Items: []LiveContentItem{}, Sources: []string{"compass", "kuangye", "shufang"}, Interval: 40, Focus: "town"}
}
func contentText(value string, max int) bool {
	return utf8.ValidString(value) && utf8.RuneCountInString(value) <= max && strings.IndexFunc(value, unicode.IsControl) < 0
}
func validateLiveContent(in LiveContent) error {
	if len(in.Items) > LiveContentMax || !slices.Contains([]int{20, 40, 60}, in.Interval) || !slices.Contains([]string{"town", "reading"}, in.Focus) || len(in.Sources) > 3 {
		return fmt.Errorf("%w: 最多 24 张卡片，请选择已有的播放时长和画面重心", ErrBadRequest)
	}
	sources, ids := map[string]bool{}, map[string]bool{}
	for _, source := range in.Sources {
		if oneOf(source, "compass", "kuangye", "shufang") == "" || sources[source] {
			return fmt.Errorf("%w: 请选择已有的内容来源", ErrBadRequest)
		}
		sources[source] = true
	}
	for _, item := range in.Items {
		if item.ID == "" || !contentText(item.ID, 64) || ids[item.ID] || oneOf(item.Source, "compass", "kuangye", "shufang") == "" ||
			!contentText(item.Title, 48) || !contentText(item.Body, 240) || !contentText(item.Credit, 80) ||
			(item.Approved && (strings.TrimSpace(item.Title) == "" || strings.TrimSpace(item.Body) == "")) {
			return fmt.Errorf("%w: 卡片标题最多 48 字，正文 240 字，出处 80 字；公开前请填写标题和正文", ErrBadRequest)
		}
		ids[item.ID] = true
	}
	return nil
}
func readLiveContent(raw string) LiveContent {
	if raw == "" {
		return emptyLiveContent()
	}
	var out LiveContent
	if json.Unmarshal([]byte(raw), &out) != nil || validateLiveContent(out) != nil {
		return emptyLiveContent()
	}
	return out
}
func (c *Core) LiveContent(ctx context.Context) (LiveContent, error) {
	raw, err := c.St.Meta(ctx, liveContentKey)
	return readLiveContent(raw), err
}
func publicLiveContent(in LiveContent) PublicLiveContent {
	out := PublicLiveContent{Items: []PublicLiveContentItem{}, Playing: in.Playing, Interval: in.Interval, Selected: in.Selected, Anchor: in.Anchor, Focus: in.Focus}
	for _, item := range in.Items {
		if !item.Approved || !item.Enabled || !slices.Contains(in.Sources, item.Source) {
			continue
		}
		out.Items = append(out.Items, PublicLiveContentItem{ID: item.ID, Source: item.Source, Title: item.Title, Body: item.Body, Credit: item.Credit})
	}
	if len(out.Items) == 0 {
		out.Selected = ""
		out.Playing = false
	}
	return out
}
func liveContentIndex(in LiveContent, now time.Time) int {
	pub := publicLiveContent(in)
	if len(pub.Items) == 0 {
		return 0
	}
	index := slices.IndexFunc(pub.Items, func(item PublicLiveContentItem) bool { return item.ID == in.Selected })
	if index < 0 {
		index = 0
	}
	if in.Playing && liveTime(in.Anchor) != "" {
		age := now.Sub(liveAt(in.Anchor))
		if age > 0 {
			index = (index + int(age/(time.Duration(in.Interval)*time.Second))%len(pub.Items)) % len(pub.Items)
		}
	}
	return index
}

// The revision check and write share a transaction. A second controller cannot silently overwrite a newer playlist.
func (c *Core) SetLiveContent(ctx context.Context, in LiveContentUpdate) (LiveContent, error) {
	if oneOf(in.Action, "save", "play", "pause", "next", "select") == "" {
		return LiveContent{}, fmt.Errorf("%w: 请选择播放操作", ErrBadRequest)
	}
	if in.Action == "save" {
		if err := validateLiveContent(in.LiveContent); err != nil {
			return LiveContent{}, err
		}
	}
	var out LiveContent
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		var raw string
		err := tx.QueryRowContext(ctx, "SELECT v FROM meta WHERE k=?", liveContentKey).Scan(&raw)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		before := readLiveContent(raw)
		if before.Revision != in.Revision {
			return fmt.Errorf("%w: 播放清单已在另一处更新，请先重新读取", ErrConflict)
		}
		now := c.St.NowTS()
		oldPublic := publicLiveContent(before)
		current := ""
		if len(oldPublic.Items) > 0 {
			current = oldPublic.Items[liveContentIndex(before, liveAt(now))].ID
		}
		out = before
		if in.Action == "save" {
			out = in.LiveContent
			// Playback is controlled separately so editing copy never starts a stopped show.
			out.Playing = before.Playing
		}
		pub := publicLiveContent(out)
		index := slices.IndexFunc(pub.Items, func(item PublicLiveContentItem) bool { return item.ID == current })
		if index < 0 {
			index = 0
		}
		if in.Action == "next" && len(pub.Items) > 0 {
			index = (index + 1) % len(pub.Items)
		}
		if in.Action == "select" {
			index = slices.IndexFunc(pub.Items, func(item PublicLiveContentItem) bool { return item.ID == in.Selected })
			if index < 0 {
				return fmt.Errorf("%w: 这张卡片尚未加入公开播放清单", ErrBadRequest)
			}
		}
		if len(pub.Items) > 0 {
			out.Selected = pub.Items[index].ID
		} else {
			out.Selected = ""
			out.Playing = false
		}
		if in.Action == "play" && len(pub.Items) > 0 {
			out.Playing = true
		}
		if in.Action == "pause" {
			out.Playing = false
		}
		out.Anchor = now
		var revision [16]byte
		if _, err := rand.Read(revision[:]); err != nil {
			return err
		}
		out.Revision = hex.EncodeToString(revision[:])
		b, err := json.Marshal(out)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", liveContentKey, string(b))
		return err
	})
	return out, err
}
