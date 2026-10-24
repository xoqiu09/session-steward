package install

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCodexLifecycleTimeouts(t *testing.T) {
	dir := t.TempDir()
	tg := CodexTarget(dir)
	in := &Installer{StateDir: filepath.Join(dir, "state"), HookBinary: "/bin/steward-hook", PermWait: 600}
	if _, err := in.Install(tg); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(tg.Path)
	var config struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Timeout int `json:"timeout"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(b, &config); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]int{"SessionEnd": 3, "Interrupt": 3, "PermissionRequest": 630, "PreToolUse": 10} {
		if got := config.Hooks[name][0].Hooks[0].Timeout; got != want {
			t.Fatalf("%s timeout=%d want=%d", name, got, want)
		}
	}
}

const orig = `{
    "model": "x",
    "hooks": {
        "Stop": [{"hooks": [{"type": "command", "command": "/usr/bin/orca done"}]}],
        "PermissionRequest": [{"matcher": "*", "hooks": [{"type": "command", "command": "notch gate", "timeout": 1800}]}]
    },
    "zeta": [1, 2.50, true, null]
}
`

func setup(t *testing.T) (Target, *Installer) {
	dir := t.TempDir()
	p := filepath.Join(dir, "settings.json")
	os.WriteFile(p, []byte(orig), 0o644)
	tg := ClaudeTarget(dir)
	tg.Path = p
	return tg, &Installer{StateDir: filepath.Join(dir, "state"), HookBinary: "/opt/steward hook/steward-hook", PermWait: 600}
}

func TestInstallUninstallVerbatim(t *testing.T) {
	tg, in := setup(t)
	if _, err := in.Install(tg); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(tg.Path)
	s := string(b)
	for _, want := range []string{"/usr/bin/orca done", "notch gate", Mark, `"model": "x"`, "2.50"} {
		if !strings.Contains(s, want) {
			t.Fatalf("安装后缺少 %q:\n%s", want, s)
		}
	}
	// 他人条目仍在前面
	if strings.Index(s, "notch gate") > strings.Index(s, "PermissionRequest "+Mark) {
		t.Fatal("Steward 条目应追加在他人条目之后")
	}
	// 幂等
	changed, err := in.Install(tg)
	if err != nil || changed {
		t.Fatalf("重复安装应无变化: %v %v", changed, err)
	}
	evs, _ := Status(tg)
	if len(evs) != len(tg.Events) {
		t.Fatalf("应接入 %d 个事件，实际 %d", len(tg.Events), len(evs))
	}
	mode, err := in.Uninstall(tg)
	if err != nil || mode != "restored" {
		t.Fatalf("应逐字恢复: %s %v", mode, err)
	}
	b, _ = os.ReadFile(tg.Path)
	if string(b) != orig {
		t.Fatalf("恢复后不一致:\n%s", b)
	}
	fi, _ := os.Stat(tg.Path)
	if fi.Mode().Perm() != 0o644 {
		t.Fatalf("权限变化: %v", fi.Mode())
	}
}

func TestUninstallKeepsExternalChanges(t *testing.T) {
	tg, in := setup(t)
	in.Install(tg)
	// 外部工具在安装后追加了自己的配置
	b, _ := os.ReadFile(tg.Path)
	s := strings.Replace(string(b), `"model": "x"`, `"model": "y",
  "newKey": "kept"`, 1)
	os.WriteFile(tg.Path, []byte(s), 0o644)
	mode, err := in.Uninstall(tg)
	if err != nil || mode != "surgical" {
		t.Fatalf("应只移除 Steward 条目: %s %v", mode, err)
	}
	b, _ = os.ReadFile(tg.Path)
	out := string(b)
	if strings.Contains(out, Mark) {
		t.Fatal("仍有 Steward 条目")
	}
	for _, want := range []string{`"newKey": "kept"`, `"model": "y"`, "/usr/bin/orca done", "notch gate"} {
		if !strings.Contains(out, want) {
			t.Fatalf("外部修改丢失 %q:\n%s", want, out)
		}
	}
	// 安装时新建的事件键被清理
	if strings.Contains(out, "SessionStart") {
		t.Fatalf("安装新建的空事件键应移除:\n%s", out)
	}
}

func TestInstallCreatesMissingFile(t *testing.T) {
	dir := t.TempDir()
	tg := CodexTarget(dir)
	in := &Installer{StateDir: filepath.Join(dir, "state"), HookBinary: "/bin/steward-hook", PermWait: 60}
	if _, err := in.Install(tg); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(tg.Path); err != nil {
		t.Fatal(err)
	}
	mode, _ := in.Uninstall(tg)
	if mode != "restored" {
		t.Fatalf("mode=%s", mode)
	}
	if _, err := os.Stat(tg.Path); !os.IsNotExist(err) {
		t.Fatal("原来不存在的文件应删除")
	}
}

func TestRejectsUnexpectedShape(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "settings.json")
	os.WriteFile(p, []byte(`{"hooks": {"Stop": "oops"}}`), 0o644)
	tg := ClaudeTarget(dir)
	tg.Path = p
	in := &Installer{StateDir: filepath.Join(dir, "state"), HookBinary: "/x", PermWait: 1}
	if _, err := in.Install(tg); err == nil {
		t.Fatal("hooks.Stop 不是数组时应拒绝")
	}
	b, _ := os.ReadFile(p)
	if string(b) != `{"hooks": {"Stop": "oops"}}` {
		t.Fatal("失败时不应修改文件")
	}
}

func TestCodexTrustKey(t *testing.T) {
	dir := t.TempDir()
	tg := CodexTarget(dir)
	os.MkdirAll(filepath.Dir(tg.Path), 0o700)
	os.WriteFile(tg.Path, []byte(`{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"other"}]}]}}`), 0o644)
	in := &Installer{StateDir: filepath.Join(dir, "state"), HookBinary: "/x", PermWait: 1}
	in.Install(tg)
	toml := filepath.Join(dir, "config.toml")
	os.WriteFile(toml, []byte("[hooks.state.\""+tg.Path+":stop:1:0\"]\ntrusted_hash = \"sha256:x\"\n"), 0o600)
	tr, un, err := CodexTrust(tg, toml)
	if err != nil {
		t.Fatal(err)
	}
	if len(tr) != 1 || tr[0] != "Stop" || len(un) != len(tg.Events)-1 {
		t.Fatalf("trusted=%v untrusted=%v", tr, un)
	}
}

func TestClaudeProjectTarget(t *testing.T) {
	dir := t.TempDir()
	tg := ClaudeProjectTarget(dir)
	if tg.Path != filepath.Join(dir, ".claude", "settings.local.json") {
		if r, _ := filepath.EvalSymlinks(dir); tg.Path != filepath.Join(r, ".claude", "settings.local.json") {
			t.Fatalf("路径错误: %s", tg.Path)
		}
	}
	in := &Installer{StateDir: filepath.Join(t.TempDir(), "state"), HookBinary: "/x", PermWait: 1}
	if _, err := in.Install(tg); err != nil {
		t.Fatal(err)
	}
	if mode, _ := in.Uninstall(tg); mode != "restored" {
		t.Fatalf("mode=%s", mode)
	}
	if _, err := os.Stat(tg.Path); !os.IsNotExist(err) {
		t.Fatal("原来不存在的文件应删除")
	}
}
