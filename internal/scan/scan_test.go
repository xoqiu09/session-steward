package scan

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexColdStartClientVariants(t *testing.T) {
	for originator, want := range map[string]string{"Codex Desktop": "desktop", "codex-tui": "cli", "codex_cli_rs": "cli", "future-client": "unknown"} {
		t.Run(originator, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "2026", "10", "18")
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			raw, _ := json.Marshal(map[string]any{"type": "session_meta", "payload": map[string]string{
				"id": "01a14d32-c360-77e3-bdbf-47c8a9aea2cc", "cwd": "/repo", "originator": originator, "cli_version": "0.163.0",
			}})
			if err := os.WriteFile(filepath.Join(dir, "rollout.jsonl"), raw, 0o600); err != nil {
				t.Fatal(err)
			}
			found := Codex(root, time.Time{})
			if len(found) != 1 || found[0].Client != want {
				t.Fatalf("%+v", found)
			}
		})
	}
}
