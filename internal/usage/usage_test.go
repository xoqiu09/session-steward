package usage

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, path, s string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

// 合成 transcript：含正文的字段不会被读出。
func TestClaudeDedupByMessage(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "proj", "sid-1.jsonl"), `{"type":"user","message":{"content":"合成提问"}}
{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"x"}],"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":100,"cache_creation_input_tokens":5}}}
{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":7,"cache_read_input_tokens":100,"cache_creation_input_tokens":5}}}
{"type":"assistant","message":{"id":"m2","usage":{"input_tokens":3,"output_tokens":2}}}
not json
`)
	got, ok := Finder{ClaudeRoot: root}.Totals("claude", "sid-1")
	if !ok || got != (Totals{Input: 13, Output: 9, CacheRead: 100, CacheWrite: 5}) {
		t.Fatalf("%+v %v", got, ok)
	}
}

func TestCodexLastTotal(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, "2026", "10", "23", "rollout-2026-10-23T00-00-00-abc-123.jsonl"), `{"type":"session_meta","payload":{"id":"abc-123"}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":5,"reasoning_output_tokens":1}}}}
{"type":"event_msg","payload":{"type":"token_count","info":null}}
{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":300,"cached_input_tokens":200,"output_tokens":20,"reasoning_output_tokens":4}}}}
`)
	got, ok := Finder{CodexRoot: root}.Totals("codex", "abc-123")
	if !ok || got != (Totals{Input: 100, Output: 20, CacheRead: 200}) {
		t.Fatalf("%+v %v", got, ok)
	}
}

func TestRejectsUnsafeIDsAndUnknown(t *testing.T) {
	f := Finder{ClaudeRoot: t.TempDir(), CodexRoot: t.TempDir()}
	for _, id := range []string{"", "../x", "*", "a/b"} {
		if _, ok := f.Totals("claude", id); ok {
			t.Fatal(id)
		}
	}
	if _, ok := f.Totals("other", "x"); ok {
		t.Fatal("unknown provider")
	}
	if _, ok := f.Totals("claude", "missing"); ok {
		t.Fatal("missing file")
	}
}
