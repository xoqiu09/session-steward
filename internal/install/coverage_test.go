package install

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func hookGroups(t *testing.T, target Target) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile(target.Path)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Hooks map[string]json.RawMessage `json:"hooks"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	return data.Hooks
}

func TestLegacyUpgradeOnlyAddsMissingHooks(t *testing.T) {
	target, installer := setup(t)
	legacy := target
	legacy.Events = append([]string(nil), target.Events[:12]...)
	if _, err := installer.Install(legacy); err != nil {
		t.Fatal(err)
	}
	before := hookGroups(t, target)
	plan := ForVersion(target, "2.1.310 (Claude Code)")
	if !plan.VersionKnown || len(plan.Skipped) != 0 {
		t.Fatalf("plan=%+v", plan)
	}
	if changed, err := installer.Install(plan.Target); err != nil || !changed {
		t.Fatalf("upgrade=%v %v", changed, err)
	}
	after := hookGroups(t, target)
	for _, name := range legacy.Events {
		var a, b any
		json.Unmarshal(before[name], &a)
		json.Unmarshal(after[name], &b)
		if !reflect.DeepEqual(a, b) {
			t.Fatalf("Existing %s was rewritten", name)
		}
	}
	for _, name := range []string{"PermissionDenied", "CwdChanged", "PreCompact", "PostCompact", "TaskCompleted"} {
		if !strings.Contains(string(after[name]), `"async": true`) {
			t.Fatalf("New %s should be async: %s", name, after[name])
		}
	}
	if changed, err := installer.Install(plan.Target); err != nil || changed {
		t.Fatalf("Repeated upgrade changed hooks: %v %v", changed, err)
	}
	if c := CheckCoverage(target, "2.1.310"); len(c.Missing) != 0 {
		t.Fatalf("Upgrade advice should clear: %+v", c)
	}
	if _, err := installer.Uninstall(target); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(target.Path); string(got) != orig {
		t.Fatal("Uninstall did not restore other tool hooks verbatim")
	}
	if _, err := installer.Install(plan.Target); err != nil {
		t.Fatal(err)
	}
	if c := CheckCoverage(target, "2.1.310"); len(c.Installed) != 17 {
		t.Fatalf("Reinstall=%+v", c)
	}
}

func TestFreshInstallAsyncKeepsDecisionHooksSynchronous(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		t.Run(provider, func(t *testing.T) {
			dir := t.TempDir()
			target := ClaudeTarget(dir)
			version := "2.1.310"
			if provider == "codex" {
				target, version = CodexTarget(dir), "codex-cli 0.164.0"
			}
			plan := ForVersion(target, version)
			installer := &Installer{StateDir: filepath.Join(dir, "state"), HookBinary: "/test/steward-hook", PermWait: 60}
			if _, err := installer.Install(plan.Target); err != nil {
				t.Fatal(err)
			}
			for name, raw := range hookGroups(t, target) {
				async := strings.Contains(string(raw), `"async": true`)
				want := name != "SessionStart" && name != "UserPromptSubmit" && name != "PermissionRequest" && !(provider == "codex" && name == "SessionEnd")
				if async != want {
					t.Fatalf("%s %s async=%t want=%t", provider, name, async, want)
				}
			}
		})
	}
}

func TestCompatibilityDoesNotGuessUnknownOrOldClients(t *testing.T) {
	target := ClaudeTarget(t.TempDir())
	for _, raw := range []string{"", "not a version", "2.1.310-preview"} {
		plan := ForVersion(target, raw)
		if plan.VersionKnown || len(plan.Target.Events) != 0 || plan.Target.Async {
			t.Fatalf("Unsafe unknown client: %+v", plan)
		}
	}
	old := ForVersion(target, "2.1.75")
	for _, name := range []string{"PermissionDenied", "CwdChanged", "PostCompact", "StopFailure"} {
		if contains(old.Target.Events, name) || !contains(old.Skipped, name) {
			t.Fatalf("Old client contains %s: %+v", name, old)
		}
	}
	if !contains(old.Target.Events, "TaskCompleted") || !contains(old.Target.Events, "PreCompact") {
		t.Fatal("Known supported older events were lost")
	}
	if ForVersion(CodexTarget(t.TempDir()), "0.163.0").Target.Async {
		t.Fatal("Unverified old Codex enabled async")
	}
}

func TestCoverageWhitelistAndVersionCache(t *testing.T) {
	dir := t.TempDir()
	target := ClaudeTarget(dir)
	os.MkdirAll(filepath.Dir(target.Path), 0700)
	os.WriteFile(target.Path, []byte(`{"hooks":{"Stop":[{"hooks":[{"command":"other secret-command /private/path"}]}],"Unrelated":[{"hooks":[{"command":"other --mark=steward-v1"}]}]}}`), 0600)
	calls := 0
	now := time.Now()
	monitor := &Monitor{Targets: []Target{target}, Now: func() time.Time { return now }, Probe: func(context.Context, string) (string, error) { calls++; return "2.1.310", nil }}
	first := monitor.Snapshot(context.Background())
	if calls != 1 || len(first[0].Installed) != 0 || len(first[0].Missing) != 17 {
		t.Fatalf("first=%+v calls=%d", first, calls)
	}
	installer := &Installer{StateDir: filepath.Join(dir, "state"), HookBinary: "/test/steward-hook", PermWait: 1}
	if _, err := installer.Install(ForVersion(target, "2.1.310").Target); err != nil {
		t.Fatal(err)
	}
	second := monitor.Snapshot(context.Background())
	if calls != 1 || len(second[0].Missing) != 0 {
		t.Fatalf("Cache hid hook updates or spawned again: %+v calls=%d", second, calls)
	}
	raw, _ := json.Marshal(second)
	for _, forbidden := range []string{"secret-command", "/private/path", target.Path, "Unrelated", "/test/steward-hook"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatalf("Coverage leaked %q", forbidden)
		}
	}
	now = now.Add(time.Minute)
	monitor.Snapshot(context.Background())
	if calls != 2 {
		t.Fatal("Version cache never refreshes")
	}
	os.WriteFile(target.Path, []byte(`not json; /private/path secret-command`), 0600)
	third := monitor.Snapshot(context.Background())
	if !third[0].ReadError || third[0].Reason != "hooks 配置无法读取，请在本机检查" {
		t.Fatalf("Bad config not fail closed: %+v", third)
	}
}
