package scan

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

// Title comes from a title index, never from conversation messages or firstPrompt.
type Title struct {
	Provider, SessionID, Text, Source string
	UpdatedAt                         time.Time
}

func CodexTitles(path string) []Title {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 4096), 1024*1024)
	latest := map[string]Title{}
	for sc.Scan() {
		var row struct {
			ID   string    `json:"id"`
			Name string    `json:"thread_name"`
			At   time.Time `json:"updated_at"`
		}
		if json.Unmarshal(sc.Bytes(), &row) != nil || row.ID == "" || row.Name == "" {
			continue
		}
		if old, ok := latest[row.ID]; ok && old.UpdatedAt.After(row.At) {
			continue
		}
		latest[row.ID] = Title{"codex", row.ID, event.Redact(event.Truncate(row.Name, 160)), "codex_title_index", row.At}
	}
	out := make([]Title, 0, len(latest))
	for _, title := range latest {
		out = append(out, title)
	}
	return out
}

func ClaudeTitles(root string) []Title {
	files, _ := filepath.Glob(filepath.Join(root, "*", "sessions-index.json"))
	var out []Title
	for _, path := range files {
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var index struct {
			Entries []struct {
				ID      string    `json:"sessionId"`
				Custom  string    `json:"customTitle"`
				Summary string    `json:"summary"`
				At      time.Time `json:"modified"`
			} `json:"entries"`
		}
		if json.Unmarshal(raw, &index) != nil {
			continue
		}
		for _, row := range index.Entries {
			text := row.Custom
			if text == "" {
				text = row.Summary
			}
			if row.ID != "" && text != "" {
				out = append(out, Title{"claude", row.ID, event.Redact(event.Truncate(text, 160)), "claude_title_index", row.At})
			}
		}
	}
	return out
}
