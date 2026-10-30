package install

import (
	"context"
	"encoding/json"
	"errors"
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
		if plan.VersionKnown || len(plan.Target.Events) != 12 || len(plan.Skipped) != 5 || plan.Target.Async {
			t.Fatalf("Unsafe unknown client: %+v", plan)
		}
	}
	old := ForVersion(target, "2.1.75")
	for _, name := range []string{"PermissionDenied", "CwdChanged", "PostCompact"} {
		if contains(old.Target.Events, name) || !contains(old.Skipped, name) {
			t.Fatalf("Old client contains %s: %+v", name, old)
		}
	}
	if !contains(old.Target.Events, "TaskCompleted") || !contains(old.Target.Events, "PreCompact") {
		t.Fatal("Known supported older events were lost")
	}
	if !contains(old.Target.Events, "StopFailure") || !contains(old.Target.Events, "PostToolUseFailure") {
		t.Fatal("基础事件不应受版本门影响")
	}
	if ForVersion(CodexTarget(t.TempDir()), "0.163.0").Target.Async {
		t.Fatal("Unverified old Codex enabled async")
	}
}

func TestMissingClaudeCLIStillInstallsTwelveBaseHooks(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	dir := t.TempDir()
	version, err := ResolveVersion(context.Background(), "claude", "", nil, nil)
	if err == nil || version != "" {
		t.Fatalf("expected missing CLI, got %q %v", version, err)
	}
	target := ClaudeTarget(dir)
	plan := ForVersion(target, version)
	installer := &Installer{StateDir: filepath.Join(dir, "state"), HookBinary: "/synthetic/steward-hook", PermWait: 60}
	if _, err := installer.Install(plan.Target); err != nil {
		t.Fatal(err)
	}
	if got := hookGroups(t, target); len(got) != 12 {
		t.Fatalf("基础十二类丢失：%d", len(got))
	}
	coverage := (&Monitor{Targets: []Target{target}}).Snapshot(context.Background())[0]
	if len(coverage.Installed) != 12 || len(coverage.Missing) != 0 || len(coverage.Skipped) != 5 || !strings.Contains(coverage.Reason, "版本未核实，已保留基础 12 种") {
		t.Fatalf("coverage=%+v", coverage)
	}
}

func TestResolveClaudeVersionPriority(t *testing.T) {
	for _, tc := range []struct {
		name, explicit, recorded, cli, want string
		reads, probes                       int
	}{
		{"explicit wins", "2.1.33", "2.1.310", "2.1.310", "2.1.33", 0, 0},
		{"recorded wins", "", "2.1.83", "2.1.310", "2.1.83", 1, 0},
		{"PATH fallback", "", "", "2.1.310", "2.1.310", 1, 1},
		{"invalid record fallback", "", "unknown", "2.1.310", "2.1.310", 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reads, probes := 0, 0
			got, err := ResolveVersion(context.Background(), "claude", tc.explicit, func(context.Context) (string, error) { reads++; return tc.recorded, nil }, func(context.Context, string) (string, error) { probes++; return tc.cli, nil })
			if err != nil || got != tc.want || reads != tc.reads || probes != tc.probes {
				t.Fatalf("got=%s err=%v reads=%d probes=%d", got, err, reads, probes)
			}
		})
	}
	probe := func(context.Context, string) (string, error) { return "2.1.310", nil }
	if _, err := ResolveVersion(context.Background(), "claude", "invalid", nil, probe); err == nil {
		t.Fatal("显式错误版本应报错，不能静默改用其他来源")
	}
	if got, err := ResolveVersion(context.Background(), "claude", "", func(context.Context) (string, error) { return "", errors.New("synthetic unavailable database") }, probe); err != nil || got != "2.1.310" {
		t.Fatalf("数据库异常未降级：%q %v", got, err)
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
