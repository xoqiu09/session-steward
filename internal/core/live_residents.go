package core

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"time"
)

var liveResidentIDs = []string{"gpt", "claude", "deepseek", "gemini", "glm", "grok", "qwen"}

const liveResidentsKey = "live:residents"

// Only visual settings are public. The anchor synchronizes App/OBS without writes from the display.
type LiveResidents struct {
	Resident string `json:"resident"`
	Mode     string `json:"mode"`
	Interval int    `json:"interval_seconds"`
	Anchor   string `json:"anchor"`
}

func validLiveResident(id string) bool { return slices.Contains(liveResidentIDs, id) }
func validLiveResidents(c LiveResidents) bool {
	return validLiveResident(c.Resident) && (c.Mode == "auto" || c.Mode == "fixed") && (c.Interval == 60 || c.Interval == 120 || c.Interval == 300)
}
func (c *Core) liveResidents(ctx context.Context) (*LiveResidents, error) {
	raw, err := c.St.Meta(ctx, liveResidentsKey)
	if err != nil {
		return nil, err
	}
	var r LiveResidents
	if json.Unmarshal([]byte(raw), &r) != nil || !validLiveResidents(r) || liveTime(r.Anchor) == "" {
		return nil, nil
	}
	return &r, nil
}
func (c *Core) SetLiveResidents(ctx context.Context, in LiveResidents) (LiveResidents, error) {
	if !validLiveResidents(in) {
		return LiveResidents{}, fmt.Errorf("%w: 请选择七位居民、轮换方式和已有时长", ErrBadRequest)
	}
	out := LiveResidents{Resident: in.Resident, Mode: in.Mode, Interval: in.Interval, Anchor: c.St.NowTS()}
	b, _ := json.Marshal(out)
	err := c.St.SetMeta(ctx, liveResidentsKey, string(b))
	return out, err
}
func currentLiveResident(c *LiveResidents, now time.Time) string {
	r := LiveResidents{Resident: "gpt", Mode: "auto", Interval: 120, Anchor: time.Unix(0, 0).UTC().Format(time.RFC3339)}
	if c != nil && validLiveResidents(*c) {
		r = *c
	}
	index := slices.Index(liveResidentIDs, r.Resident)
	if r.Mode == "auto" {
		age := now.Sub(liveAt(r.Anchor))
		if age > 0 {
			index = (index + int(age/(time.Duration(r.Interval)*time.Second))%len(liveResidentIDs)) % len(liveResidentIDs)
		}
	}
	return liveResidentIDs[index]
}
