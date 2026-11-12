package core

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	mathrand "math/rand"
	"slices"
	"strings"
	"time"
)

const liveReadingPoolKey = "live:reading-pool"
const LiveReadingPoolMax = 12000

// Imported text is a separate owner-approved library, never a scan of private files.
// The display receives only a short rolling window, not the library or provenance.
type LiveReadingPool struct {
	Revision    string                  `json:"revision"`
	SourceCount int                     `json:"source_count"`
	Items       []PublicLiveContentItem `json:"items"`
}
type LiveReadingPoolUpdate struct {
	LiveReadingPool
	Confirmed bool `json:"confirmed"`
}
type LiveReadingPoolSummary struct {
	Revision    string         `json:"revision"`
	Count       int            `json:"count"`
	SourceCount int            `json:"source_count"`
	Topics      map[string]int `json:"topics"`
}

func randomLiveRevision() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func validateReadingPool(in LiveReadingPool) error {
	if len(in.Items) == 0 || len(in.Items) > LiveReadingPoolMax || in.SourceCount < len(in.Items) || in.SourceCount > 1000000 {
		return fmt.Errorf("%w: 请导入 1–12000 条经过筛选的摘句，并填写原库条数", ErrBadRequest)
	}
	ids, texts := map[string]bool{}, map[string]bool{}
	for _, item := range in.Items {
		if len(item.ID) < 8 || len(item.ID) > 64 || strings.IndexFunc(item.ID, func(r rune) bool { return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '-') }) >= 0 || ids[item.ID] ||
			item.Source != "kuangye" || !contentText(item.Title, 48) || strings.TrimSpace(item.Title) == "" || item.Body != "" || !contentText(item.Credit, 80) || item.Topic == "" || !liveContentTopic(item.Topic) || texts[strings.TrimSpace(item.Title)] {
			return fmt.Errorf("%w: 摘句需要独立短句、唯一编号和已有主题，正文留空；请先检查重复与长度", ErrBadRequest)
		}
		for _, s := range []string{item.Title, item.Credit} {
			if strings.Contains(s, "旷野之心") || strings.Contains(strings.ToLower(s), "http") || strings.Contains(s, "/Users/") || strings.Contains(s, "/Volumes/") {
				return fmt.Errorf("%w: 公开摘句不能带来源名称、链接或本机路径", ErrBadRequest)
			}
		}
		ids[item.ID] = true
		texts[strings.TrimSpace(item.Title)] = true
	}
	return nil
}
func readReadingPool(raw string) LiveReadingPool {
	var out LiveReadingPool
	if json.Unmarshal([]byte(raw), &out) != nil || validateReadingPool(out) != nil {
		return LiveReadingPool{}
	}
	return out
}
func readingPoolSummary(pool LiveReadingPool) LiveReadingPoolSummary {
	out := LiveReadingPoolSummary{Revision: pool.Revision, Count: len(pool.Items), SourceCount: pool.SourceCount, Topics: map[string]int{}}
	for _, item := range pool.Items {
		out.Topics[item.Topic]++
	}
	return out
}
func (c *Core) LiveReadingPool(ctx context.Context) (LiveReadingPoolSummary, error) {
	raw, err := c.St.Meta(ctx, liveReadingPoolKey)
	return readingPoolSummary(readReadingPool(raw)), err
}
func (c *Core) SetLiveReadingPool(ctx context.Context, in LiveReadingPoolUpdate) (LiveReadingPoolSummary, error) {
	if !in.Confirmed {
		return LiveReadingPoolSummary{}, fmt.Errorf("%w: 请先确认导入的摘句可以公开", ErrBadRequest)
	}
	if err := validateReadingPool(in.LiveReadingPool); err != nil {
		return LiveReadingPoolSummary{}, err
	}
	var out LiveReadingPool
	err := c.St.Tx(ctx, func(tx *sql.Tx) error {
		raw, err := liveMetaTx(ctx, tx, liveReadingPoolKey)
		if err != nil {
			return err
		}
		before := readReadingPool(raw)
		if before.Revision != in.Revision {
			return fmt.Errorf("%w: 摘句库已更新，请先重新读取", ErrConflict)
		}
		out = in.LiveReadingPool
		out.Revision, err = randomLiveRevision()
		if err != nil {
			return err
		}
		if err = writeLiveMetaTx(ctx, tx, liveReadingPoolKey, out); err != nil {
			return err
		}
		raw, err = liveMetaTx(ctx, tx, liveContentKey)
		if err != nil {
			return err
		}
		content := readLiveContent(raw)
		if content.Mode == "random" {
			content.RandomSeed, err = randomLiveRevision()
			if err != nil {
				return err
			}
			content.RandomOffset = 0
			content.Anchor = c.St.NowTS()
			content.Revision, err = randomLiveRevision()
			if err != nil {
				return err
			}
			return writeLiveMetaTx(ctx, tx, liveContentKey, content)
		}
		return nil
	})
	return readingPoolSummary(out), err
}
func liveMetaTx(ctx context.Context, tx *sql.Tx, key string) (string, error) {
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT v FROM meta WHERE k=?", key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return raw, err
}
func writeLiveMetaTx(ctx context.Context, tx *sql.Tx, key string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", key, string(b))
	return err
}
func readingPosition(in LiveContent, now time.Time) int64 {
	position := in.RandomOffset
	if in.Playing && liveTime(in.Anchor) != "" && in.Interval > 0 {
		age := now.Sub(liveAt(in.Anchor))
		if age > 0 {
			position += int64(age / (time.Duration(in.Interval) * time.Second))
		}
	}
	return position
}
func rawReadingOrder(n int, seed string, cycle int64) []int {
	sum := sha256.Sum256([]byte(fmt.Sprintf("reading-order:%s:%d", seed, cycle)))
	return mathrand.New(mathrand.NewSource(int64(binary.LittleEndian.Uint64(sum[:8])))).Perm(n)
}

// Each full cycle visits every excerpt once. Avoid repeating the boundary card.
func readingOrder(n int, seed string, cycle int64) []int {
	if n == 2 {
		return rawReadingOrder(n, seed, 0)
	}
	order := rawReadingOrder(n, seed, cycle)
	if n > 2 && cycle > 0 && order[0] == rawReadingOrder(n, seed, cycle-1)[n-1] {
		order[0], order[1] = order[1], order[0]
	}
	return order
}
func randomPublicContent(in LiveContent, pool LiveReadingPool, now time.Time) PublicLiveContent {
	out := PublicLiveContent{Items: []PublicLiveContentItem{}, Mode: "random", Playing: in.Playing, Interval: in.Interval, Focus: in.Focus, Anchor: in.Anchor}
	if len(pool.Items) == 0 || !slices.Contains(in.Sources, "kuangye") {
		out.Playing = false
		return out
	}
	position := readingPosition(in, now)
	// Refresh halfway through the window. A delayed poll still has future cards;
	// the browser holds the last known card instead of wrapping a stale window.
	start := position / 12 * 12
	orders := map[int64][]int{}
	for slot := start; slot < start+LiveContentMax; slot++ {
		cycle := slot / int64(len(pool.Items))
		order, ok := orders[cycle]
		if !ok {
			order = readingOrder(len(pool.Items), in.RandomSeed, cycle)
			orders[cycle] = order
		}
		item := pool.Items[order[slot%int64(len(pool.Items))]]
		sum := sha256.Sum256([]byte(fmt.Sprintf("reading-card:%s:%s:%d", in.RandomSeed, item.ID, slot)))
		item.ID = hex.EncodeToString(sum[:16])
		out.Items = append(out.Items, item)
	}
	if in.Playing {
		out.Selected = out.Items[0].ID
		out.Anchor = liveAt(in.Anchor).Add(time.Duration(start-in.RandomOffset) * time.Duration(in.Interval) * time.Second).UTC().Format(time.RFC3339Nano)
	} else {
		out.Selected = out.Items[position-start].ID
	}
	return out
}
