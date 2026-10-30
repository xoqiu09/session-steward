package notify

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"
	"unicode/utf8"

	"github.com/xoqiu09/session-steward/internal/core"
)

type nativeNotice struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Body  string `json:"body"`
	Link  string `json:"link"`
}

// Only local panel deep links, never credentials, remote origins, commands or API actions.
func validNoticeLink(link string) bool {
	u, err := url.Parse(link)
	if err != nil || u.Scheme != "http" || u.User != nil || u.RawQuery != "" || (u.Path != "" && u.Path != "/") {
		return false
	}
	if h := u.Hostname(); h != "127.0.0.1" && h != "localhost" && h != "::1" {
		return false
	}
	f, err := url.ParseQuery(u.Fragment)
	if err != nil || len(f) != 1 {
		return false
	}
	for k, v := range f {
		return (k == "item" || k == "approval" || k == "session") && len(v) == 1 && v[0] != ""
	}
	return false
}

func (m *MacOS) sendNative(ctx context.Context, a core.Alert) error {
	if !validNoticeLink(a.Link) || utf8.RuneCountInString(a.Title) > 256 || utf8.RuneCountInString(a.Body) > 2048 {
		return errors.New("invalid native notification")
	}
	if m.SpoolDir == "" {
		return errors.New("native notification spool is not configured")
	}
	if err := os.MkdirAll(m.SpoolDir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(m.SpoolDir, "notice-*.stewardnotice")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	defer os.Remove(name + ".result")
	hash := sha256.Sum256([]byte(a.Key))
	b, err := json.Marshal(nativeNotice{ID: hex.EncodeToString(hash[:]), Title: a.Title, Body: a.Body, Link: a.Link})
	if err == nil {
		_, err = f.Write(b)
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if _, err = m.run(ctx, "/usr/bin/open", "-g", "-a", filepath.Clean(m.AppPath), name, "--args", "--steward-home", filepath.Dir(filepath.Clean(m.SpoolDir))); err != nil {
		return err
	}
	// Wait for the OS enqueue acknowledgement, not a user's click. No database lock is held.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	for {
		b, err := os.ReadFile(name + ".result")
		if err == nil {
			var result struct {
				Status string `json:"status"`
			}
			if err := json.Unmarshal(b, &result); err != nil {
				return err
			}
			if result.Status == "queued" {
				return nil
			}
			return fmt.Errorf("native notification: %s", result.Status)
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
		}
	}
}
