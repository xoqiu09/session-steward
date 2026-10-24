package scan

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexTitleIndexUsesLatestTitleAndRedacts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session_index.jsonl")
	raw := `{"id":"one","thread_name":"新的工作 token=private-secret-value","updated_at":"2026-10-18T02:00:00Z"}
{"id":"one","thread_name":"旧标题","updated_at":"2026-10-18T01:00:00Z"}
not-json
{"id":"two","firstPrompt":"不读取这段正文","updated_at":"2026-10-18T03:00:00Z"}
`
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	got := CodexTitles(path)
	if len(got) != 1 || got[0].SessionID != "one" || !strings.Contains(got[0].Text, "新的工作") || strings.Contains(got[0].Text, "private-secret") {
		t.Fatalf("%+v", got)
	}
	if len(CodexTitles(path+"-absent")) != 0 {
		t.Fatal("missing index")
	}
}

func TestClaudeTitleIndexDoesNotImportFirstPrompt(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "repo")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "sessions-index.json"), []byte(`{"entries":[{"sessionId":"one","customTitle":"人工标题","summary":"摘要标题"},{"sessionId":"two","firstPrompt":"不得当成标题"}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got := ClaudeTitles(root)
	if len(got) != 1 || got[0].Text != "人工标题" {
		t.Fatalf("%+v", got)
	}
}
