package conversation

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const syntheticSession = "11111111-2222-4333-8444-555555555555"

func TestDesktopTargetsAreBoundToExistingIDs(t *testing.T) {
	c := Resolve("codex", "desktop", syntheticSession, "")
	if c.Mode != "app" || c.URL != "codex://threads/"+syntheticSession {
		t.Fatal(c)
	}
	c = Resolve("claude", "desktop", syntheticSession, t.TempDir())
	if c.Mode != "app" || c.URL != "claude://resume?session="+syntheticSession {
		t.Fatal(c)
	}
	for _, input := range []struct{ provider, client, id string }{
		{"codex", "cli", syntheticSession}, {"claude", "sdk-cli", syntheticSession},
		{"codex", "unknown", syntheticSession}, {"other", "desktop", syntheticSession},
		{"codex", "desktop", "../another?command=anything"}, {"claude", "desktop", "not-a-session"},
	} {
		if got := Resolve(input.provider, input.client, input.id, ""); got.Mode != "manual" || got.URL != "" {
			t.Fatal(got)
		}
	}
}

func TestClaudeUsesOnlyMatchingBoundedLiveMetadata(t *testing.T) {
	dir := t.TempDir()
	write := func(name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("unrelated.json", `{"sessionId":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee","hostSessionId":"local_wrong"}`)
	write("invalid.json", `{"sessionId":"`+syntheticSession+`","hostSessionId":"local_bad?command=anything"}`)
	write("large.json", strings.Repeat("x", (64<<10)+1))
	write("selected.json", `{"sessionId":"`+syntheticSession+`","hostSessionId":"local_synthetic-host","entrypoint":"claude-desktop"}`)
	got := Resolve("claude", "desktop", syntheticSession, dir)
	if got.URL != "claude://code/continue?session=local_synthetic-host" {
		t.Fatal(got)
	}
	if ClaudeDesktopHost(dir, "../../private") != "" {
		t.Fatal("unsafe ID")
	}
	if err := os.Remove(filepath.Join(dir, "selected.json")); err != nil {
		t.Fatal(err)
	}
	if ClaudeDesktopHost(dir, syntheticSession) != "" {
		t.Fatal("unrelated metadata was used")
	}
}
