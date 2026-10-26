package service

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeLaunchctl 模拟 launchctl：记录调用，并按 bootstrap / bootout 维护加载状态。
type fakeLaunchctl struct {
	loaded bool
	calls  []string
	fail   string // 让该子命令失败
}

func (f *fakeLaunchctl) run(name string, args ...string) ([]byte, error) {
	if name != "launchctl" {
		return nil, errors.New("unexpected command " + name)
	}
	f.calls = append(f.calls, strings.Join(args, " "))
	if args[0] == f.fail {
		return []byte("Bootstrap failed: 5: Input/output error"), errors.New("exit status 5")
	}
	switch args[0] {
	case "print":
		if !f.loaded {
			return []byte("Could not find service"), errors.New("exit status 113")
		}
		return []byte("gui/501/x = {\n\tstate = running\n\truns = 1\n\tpid = 42\n\tendpoints = {\n\t\tstate = active\n\t}\n\tlast exit code = (never exited)\n}\n"), nil
	case "bootstrap":
		f.loaded = true
	case "bootout":
		f.loaded = false
	}
	return nil, nil
}

// mutating 只保留会改变状态的调用，便于断言。
func (f *fakeLaunchctl) mutating() []string {
	var out []string
	for _, c := range f.calls {
		if !strings.HasPrefix(c, "print ") {
			out = append(out, c)
		}
	}
	return out
}

func setup(t *testing.T) (*Agent, *fakeLaunchctl) {
	dir := t.TempDir()
	f := &fakeLaunchctl{}
	data := filepath.Join(dir, "steward data")
	a := New(filepath.Join(dir, "home"), "/opt/steward & co/bin/steward", data, map[string]string{"STEWARD_HOME": data, "LANG": "en_US.UTF-8"}, 501)
	a.Run, a.Sleep = f.run, func(time.Duration) {}
	return a, f
}

func TestInstallWritesPlistAndBootstraps(t *testing.T) {
	a, f := setup(t)
	res, err := a.Install(false)
	if err != nil || res != "installed" {
		t.Fatalf("res=%q err=%v", res, err)
	}
	if want := filepath.Join(filepath.Dir(a.Home), "home", "Library", "LaunchAgents", Label+".plist"); a.PlistPath != want {
		t.Fatalf("plist path %s", a.PlistPath)
	}
	b, err := os.ReadFile(a.PlistPath)
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	for _, want := range []string{Marker, "<string>" + Label + "</string>", "<string>/opt/steward &amp; co/bin/steward</string>\n\t\t<string>serve</string>",
		"<key>RunAtLoad</key>\n\t<true/>", "<key>KeepAlive</key>\n\t<true/>", "<key>LANG</key>\n\t\t<string>en_US.UTF-8</string>",
		filepath.Join(a.Home, "logs", "serve.err.log")} {
		if !strings.Contains(s, want) {
			t.Errorf("plist missing %q:\n%s", want, s)
		}
	}
	if info, err := os.Stat(filepath.Join(a.Home, "logs")); err != nil || !info.IsDir() {
		t.Fatalf("logs dir: %v", err)
	}
	if got := f.mutating(); len(got) != 1 || got[0] != "bootstrap gui/501 "+a.PlistPath {
		t.Fatalf("calls %v", got)
	}
	if path, err := exec.LookPath("plutil"); err == nil {
		if out, err := exec.Command(path, "-lint", a.PlistPath).CombinedOutput(); err != nil {
			t.Fatalf("plutil -lint: %v %s", err, out)
		}
	}
}

func TestInstallIdempotentAndUpdate(t *testing.T) {
	a, f := setup(t)
	if _, err := a.Install(false); err != nil {
		t.Fatal(err)
	}
	if res, err := a.Install(false); err != nil || res != "unchanged" {
		t.Fatalf("second install res=%q err=%v", res, err)
	}
	if len(f.mutating()) != 1 {
		t.Fatalf("unchanged install should not call launchctl: %v", f.mutating())
	}
	// 未加载但 plist 相同：只重新加载。
	f.loaded = false
	if res, err := a.Install(false); err != nil || res != "loaded" {
		t.Fatalf("res=%q err=%v", res, err)
	}
	// 换了二进制路径：先 bootout 再 bootstrap。
	f.calls = nil
	a.Binary = "/usr/local/bin/steward"
	if res, err := a.Install(false); err != nil || res != "updated" {
		t.Fatalf("res=%q err=%v", res, err)
	}
	if got := f.mutating(); len(got) != 2 || got[0] != "bootout gui/501/"+Label || !strings.HasPrefix(got[1], "bootstrap ") {
		t.Fatalf("calls %v", got)
	}
	b, _ := os.ReadFile(a.PlistPath)
	if !strings.Contains(string(b), "/usr/local/bin/steward") {
		t.Fatal("plist not updated")
	}
}

func TestRefusesForeignPlist(t *testing.T) {
	a, f := setup(t)
	os.MkdirAll(filepath.Dir(a.PlistPath), 0o755)
	foreign := []byte("<plist><dict><key>Label</key><string>someone else</string></dict></plist>\n")
	os.WriteFile(a.PlistPath, foreign, 0o644)
	if _, err := a.Install(true); !errors.Is(err, ErrNotOurs) {
		t.Fatalf("install err=%v", err)
	}
	if _, err := a.Uninstall(); !errors.Is(err, ErrNotOurs) {
		t.Fatalf("uninstall err=%v", err)
	}
	if b, _ := os.ReadFile(a.PlistPath); string(b) != string(foreign) {
		t.Fatal("foreign plist changed")
	}
	if len(f.mutating()) != 0 {
		t.Fatalf("launchctl called: %v", f.mutating())
	}
	if s := a.Status(); s.Plist != "foreign" {
		t.Fatalf("status %+v", s)
	}
}

func TestRefusesWhenPortBusy(t *testing.T) {
	a, f := setup(t)
	a.PortInUse = func() bool { return true }
	if _, err := a.Install(false); err == nil || !strings.Contains(err.Error(), "已被占用") {
		t.Fatalf("err=%v", err)
	}
	if _, err := os.Stat(a.PlistPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("plist written despite busy port")
	}
	if res, err := a.Install(true); err != nil || res != "installed" {
		t.Fatalf("force res=%q err=%v", res, err)
	}
	// 已加载时端口自然被自己占用，重装不应拒绝。
	a.Binary = "/usr/local/bin/steward"
	if _, err := a.Install(false); err != nil {
		t.Fatal(err)
	}
	if !f.loaded {
		t.Fatal("not loaded")
	}
}

func TestRefusesGoRunBinary(t *testing.T) {
	a, _ := setup(t)
	a.Binary = "/private/var/folders/x/T/go-build123/b001/exe/steward"
	if _, err := a.Install(false); err == nil {
		t.Fatal("want error for go run binary")
	}
	a.Binary = "bin/steward"
	if _, err := a.Install(false); err == nil {
		t.Fatal("want error for relative path")
	}
}

func TestBootstrapFailureReported(t *testing.T) {
	a, f := setup(t)
	f.fail = "bootstrap"
	if _, err := a.Install(false); err == nil || !strings.Contains(err.Error(), "Input/output error") {
		t.Fatalf("err=%v", err)
	}
}

func TestUninstall(t *testing.T) {
	a, f := setup(t)
	if res, err := a.Uninstall(); err != nil || res != "absent" {
		t.Fatalf("res=%q err=%v", res, err)
	}
	if _, err := a.Install(false); err != nil {
		t.Fatal(err)
	}
	logs := filepath.Join(a.Home, "logs", "serve.err.log")
	os.WriteFile(logs, []byte("x"), 0o600)
	f.calls = nil
	if res, err := a.Uninstall(); err != nil || res != "removed" {
		t.Fatalf("res=%q err=%v", res, err)
	}
	if _, err := os.Stat(a.PlistPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("plist not removed")
	}
	if _, err := os.Stat(logs); err != nil {
		t.Fatal("logs should be kept")
	}
	if got := f.mutating(); len(got) != 1 || got[0] != "bootout gui/501/"+Label {
		t.Fatalf("calls %v", got)
	}
	if f.loaded {
		t.Fatal("still loaded")
	}
}

func TestRestartAndStatus(t *testing.T) {
	a, f := setup(t)
	if err := a.Restart(); err == nil {
		t.Fatal("restart before install should fail")
	}
	if s := a.Status(); s.Plist != "absent" || s.Loaded {
		t.Fatalf("status %+v", s)
	}
	a.Install(false)
	f.calls = nil
	if err := a.Restart(); err != nil {
		t.Fatal(err)
	}
	if got := f.mutating(); len(got) != 1 || got[0] != "kickstart -k gui/501/"+Label {
		t.Fatalf("calls %v", got)
	}
	s := a.Status()
	want := []string{"state = running", "runs = 1", "pid = 42", "last exit code = (never exited)"}
	if s.Plist != "ours" || !s.Loaded || strings.Join(s.Detail, "|") != strings.Join(want, "|") {
		t.Fatalf("status %+v", s)
	}
}

func TestEnv(t *testing.T) {
	get := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	e := Env(get(map[string]string{"LANG": "C", "PATH": "/opt/homebrew/bin:/usr/bin"}), "/h")
	if e["LANG"] != "en_US.UTF-8" || e["PATH"] != "/opt/homebrew/bin:/usr/bin" || e["STEWARD_HOME"] != "/h" {
		t.Fatalf("%v", e)
	}
	if _, ok := e["CODEX_HOME"]; ok {
		t.Fatal("empty CODEX_HOME should be omitted")
	}
	e = Env(get(map[string]string{"LANG": "zh_CN.utf-8", "CODEX_HOME": "/c"}), "/h")
	if e["LANG"] != "zh_CN.utf-8" || e["CODEX_HOME"] != "/c" {
		t.Fatalf("%v", e)
	}
}
