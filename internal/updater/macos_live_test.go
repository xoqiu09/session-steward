//go:build darwin

package updater

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/service"
)

// Opt-in, real binaries and a real *isolated* launchd service. The ordinary test
// suite never loads/unloads the user's service. All data is synthetic.
func TestMacIsolatedInstall(t *testing.T) {
	bundle := os.Getenv("SS_UPDATE_TEST_BUNDLE")
	if bundle == "" {
		t.Skip("set SS_UPDATE_TEST_BUNDLE to a freshly built test App")
	}
	for _, mode := range []string{"own", "shared"} {
		for _, failHealth := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/healthFailure=%v", mode, failHealth), func(t *testing.T) {
				interactive := os.Getenv("SS_UPDATE_TEST_INTERACTIVE_DIR")
				if interactive != "" && (mode != "own" || failHealth) {
					t.Skip("interactive notifications use the successful App-owned transaction; run the full matrix separately")
				}
				dir := t.TempDir()
				home := filepath.Join(dir, "home")
				if os.Getenv("SS_UPDATE_TEST_INTERNAL_HOME") == "1" {
					// macOS grants a freshly signed App ordinary access to its
					// Application Support data; removable-volume access may
					// await a human permission prompt during LaunchServices launch.
					root := filepath.Join(os.Getenv("HOME"), "Library/Application Support/Session Steward Update Tests")
					if e := os.MkdirAll(root, 0700); e != nil {
						t.Fatal(e)
					}
					runtimeHome, e := os.MkdirTemp(root, "isolated-")
					if e != nil {
						t.Fatal(e)
					}
					home = runtimeHome
					t.Cleanup(func() { _ = os.RemoveAll(runtimeHome); _ = os.Remove(root) })
				}
				if e := os.MkdirAll(filepath.Join(home, "bin"), 0700); e != nil {
					t.Fatal(e)
				}
				listener, e := net.Listen("tcp", "127.0.0.1:0")
				if e != nil {
					t.Fatal(e)
				}
				listen := listener.Addr().String()
				listener.Close()
				config := []byte(fmt.Sprintf(`{"listen":%q,"notify_macos":false,"remote_hosts":["synthetic.invalid"],"hub":{"role":"hub"}}`, listen))
				if e = os.WriteFile(filepath.Join(home, "config.json"), config, 0600); e != nil {
					t.Fatal(e)
				}
				secret := []byte("synthetic-secret-only")
				if e = os.WriteFile(filepath.Join(home, "hub.secret"), secret, 0600); e != nil {
					t.Fatal(e)
				}
				app := filepath.Join(dir, "Session Steward.app")
				if e = copyTree(bundle, app); e != nil {
					t.Fatal(e)
				}
				work := filepath.Join(home, "updates/test")
				if e = os.MkdirAll(filepath.Join(work, "unpacked"), 0700); e != nil {
					t.Fatal(e)
				}
				if e = copyTree(bundle, filepath.Join(work, "unpacked/Session Steward.app")); e != nil {
					t.Fatal(e)
				}
				for _, name := range []string{"steward", "steward-hook", "Session Steward.app"} {
					if e = copyTree(filepath.Join(bundle, "Contents/MacOS", name), filepath.Join(home, "bin", name)); e != nil {
						t.Fatal(e)
					}
				}
				version, e := plist(filepath.Join(bundle, "Contents/Info.plist"), "CFBundleShortVersionString")
				if e != nil {
					t.Fatal(e)
				}
				buildText, _ := plist(filepath.Join(bundle, "Contents/Info.plist"), "CFBundleVersion")
				build, _ := strconv.ParseInt(buildText, 10, 64)
				commit, e := command(filepath.Join(bundle, "Contents/MacOS/steward"), "version")
				if e != nil {
					t.Fatal(e)
				}
				m := manifest()
				m.Version = version
				m.Build = build
				m.Commit = strings.TrimSpace(string(commit))
				label := fmt.Sprintf("io.github.xoqiu09.session-steward.update-test-%d", time.Now().UnixNano())
				agent := &service.Agent{Label: label, PlistPath: filepath.Join(os.Getenv("HOME"), "Library/LaunchAgents", label+".plist"), Binary: filepath.Join(home, "bin/steward"), Home: home, Env: map[string]string{"STEWARD_HOME": home, "PATH": os.Getenv("PATH"), "LANG": "en_US.UTF-8"}, UID: os.Getuid()}
				// launchd cannot open logs/cwd on this removable volume before
				// spawning. Keep data/binaries external; use its safe defaults
				// for the isolated fixture's initial cwd and log descriptors.
				plistData := string(agent.Plist())
				plistData = strings.ReplaceAll(plistData, "<key>WorkingDirectory</key>\n\t<string>"+home+"</string>", "<key>WorkingDirectory</key>\n\t<string>/</string>")
				plistData = strings.ReplaceAll(plistData, filepath.Join(home, "logs/serve.out.log"), "/dev/null")
				plistData = strings.ReplaceAll(plistData, filepath.Join(home, "logs/serve.err.log"), "/dev/null")
				var child *exec.Cmd
				stopChild := func() {
					if child != nil {
						_ = child.Process.Signal(syscall.SIGTERM)
						_ = child.Wait()
						child = nil
					}
				}
				defer stopChild()
				createdPlist := false
				t.Cleanup(func() {
					_, _ = command("/bin/launchctl", "bootout", fmt.Sprintf("gui/%d/%s", os.Getuid(), label))
					if createdPlist {
						_ = os.Remove(agent.PlistPath)
					}
					_, _ = command("/usr/bin/pkill", "-TERM", "-f", "^"+regexpQuote(filepath.Join(app, "Contents/MacOS/SessionSteward"))+"( |$)")
					for _, path := range []string{app, filepath.Join(app, "Contents/MacOS/Session Steward.app"), filepath.Join(home, "bin/Session Steward.app")} {
						_, _ = command("/usr/bin/pkill", "-TERM", "-f", "^"+regexpQuote(filepath.Join(path, "Contents/MacOS/StewardNotifications"))+"( |$)")
						_, _ = command(launchServicesRegister, "-u", path)
					}
				})
				run := func(name string, args ...string) ([]byte, error) {
					if name == "/usr/bin/open" {
						if os.Getenv("SS_UPDATE_TEST_NATIVE") == "1" && len(args) > 0 {
							if os.Getenv("SS_UPDATE_TEST_LAUNCHSERVICES") == "1" {
								return command(name, append(args, "--update-no-onboard")...)
							}
							// Direct child launch inherits the test runner's already granted
							// external-disk access; LaunchServices permission UI is
							// a separately recorded manual acceptance boundary.
							child = exec.Command(filepath.Join(app, "Contents/MacOS/SessionSteward"), append(args[4:], "--update-no-onboard")...)
							child.Env = append(os.Environ(), "STEWARD_HOME="+home)
							return nil, child.Start()
						}
						if mode == "shared" {
							return nil, nil
						}
						child = exec.Command(filepath.Join(app, "Contents/MacOS/steward"), "serve")
						child.Env = append(os.Environ(), "STEWARD_HOME="+home)
						return nil, child.Start()
					}
					if name == "/usr/bin/pkill" {
						if strings.Contains(strings.Join(args, " "), "SessionSteward") {
							stopChild()
						}
						if os.Getenv("SS_UPDATE_TEST_NATIVE") == "1" {
							return command(name, args...)
						}
						return nil, nil
					}
					for i, a := range args {
						if a == target() {
							args[i] = fmt.Sprintf("gui/%d/%s", os.Getuid(), label)
						}
					}
					return command(name, args...)
				}
				host := MacHost{run: run}
				if mode == "shared" {
					if e = os.MkdirAll(filepath.Join(home, "logs"), 0700); e != nil {
						t.Fatal(e)
					}
					if e = writeExclusive(agent.PlistPath, []byte(plistData)); e != nil {
						t.Fatal(e)
					}
					createdPlist = true
					if _, e = command("/bin/launchctl", "bootstrap", fmt.Sprintf("gui/%d", os.Getuid()), agent.PlistPath); e != nil {
						t.Fatal(e)
					}
				} else {
					if _, e = run("/usr/bin/open"); e != nil {
						t.Fatal(e)
					}
				}
				old := &Plan{Home: home, Listen: listen, Commit: m.Commit}
				// Wait for synthetic token creation; never read the user's .steward.
				for i := 0; i < 100; i++ {
					if _, e = os.Stat(filepath.Join(home, "panel.token")); e == nil {
						break
					}
					time.Sleep(100 * time.Millisecond)
				}
				if e = host.Healthy(old); e != nil {
					for _, name := range []string{"serve.out.log", "serve.err.log"} {
						b, _ := os.ReadFile(filepath.Join(home, "logs", name))
						t.Log(name, string(b))
					}
					state, _ := command("/bin/launchctl", "print", fmt.Sprintf("gui/%d/%s", os.Getuid(), label))
					for _, line := range strings.Split(string(state), "\n") {
						if strings.Contains(line, "state =") || strings.Contains(line, "exit") || strings.Contains(line, "spawn") {
							t.Log(line)
						}
					}
					t.Fatal(e)
				}
				if os.Getenv("SS_UPDATE_TEST_NATIVE") == "1" {
					setTestIdentity(t, app, label)
					setTestHelperIdentity(t, filepath.Join(home, "bin/Session Steward.app"), label)
				}
				p, e := prepare(app, home, mode, work, 123, m, agent.PlistPath)
				if e != nil {
					t.Fatal(e)
				}
				if os.Getenv("SS_UPDATE_TEST_NATIVE") == "1" {
					// Keep the runtime fixture distinct from the user's App.
					// Re-sign only our local staged test copy after production
					// validation; downloads cannot use this test-only seam.
					for i := range p.Items {
						item := &p.Items[i]
						if item.Target == app {
							setTestIdentity(t, item.Staged, label)
						} else if filepath.Base(item.Target) == "Session Steward.app" {
							setTestHelperIdentity(t, item.Staged, label)
						} else {
							continue
						}
						item.NewDigest, e = DigestTree(item.Staged)
						if e != nil {
							t.Fatal(e)
						}
					}
					if e = Save(p); e != nil {
						t.Fatal(e)
					}
				}
				if failHealth {
					p.Commit = strings.Repeat("f", 40)
				}
				if interactive != "" {
					start := exec.Command(filepath.Join(app, "Contents/MacOS/steward-hook"), "codex", "SessionStart")
					start.Env = append(os.Environ(), "STEWARD_HOME="+home)
					payload, _ := json.Marshal(map[string]string{"session_id": "synthetic-update-notification", "cwd": dir, "hook_event_name": "SessionStart"})
					start.Stdin = strings.NewReader(string(payload))
					if output, err := start.CombinedOutput(); err != nil {
						t.Fatalf("synthetic session: %v %s", err, output)
					}
					seed := exec.Command(filepath.Join(app, "Contents/MacOS/steward-hook"), "begin", "--title", "T0 合成升级通知验收", "--project", dir, "--provider", "codex", "--session", "synthetic-update-notification")
					seed.Dir = dir
					seed.Env = append(os.Environ(), "STEWARD_HOME="+home)
					if output, err := seed.CombinedOutput(); err != nil {
						t.Fatalf("synthetic item: %v %s", err, output)
					}
					if e = host.Start(p, false); e != nil {
						t.Fatal(e)
					}
					interactiveCheckpoint(t, interactive, "before", app, home, label)
				}
				err := Apply(p, host)
				if failHealth {
					if err == nil || p.State != "rolled_back" {
						t.Fatalf("recovery failed %s %v", p.State, err)
					}
				} else if err != nil || p.State != "installed" {
					b, _ := os.ReadFile(filepath.Join(work, "app-startup.log"))
					t.Log("native startup", string(b))
					t.Fatalf("install failed %s %v", p.State, err)
				}
				if interactive != "" {
					interactiveCheckpoint(t, interactive, "after", app, home, label)
				}
				b, _ := os.ReadFile(filepath.Join(home, "config.json"))
				if string(b) != string(config) {
					t.Fatal("configuration changed")
				}
				b, _ = os.ReadFile(filepath.Join(home, "hub.secret"))
				if string(b) != string(secret) {
					t.Fatal("hub identity changed")
				}
				if mode == "shared" {
					b, _ = os.ReadFile(agent.PlistPath)
					if string(b) != plistData {
						t.Fatal("launchd configuration changed")
					}
				}
				for _, bin := range []string{"steward", "steward-hook"} {
					b, e = command(filepath.Join(home, "bin", bin), "version")
					if e != nil || strings.TrimSpace(string(b)) != m.Commit {
						t.Fatal("component version mismatch", bin, e)
					}
				}
			})
		}
	}
}

// Optional human/CUA checkpoints exercise real notification banners and clicks.
// A marker only resumes the fixture; it is never interpreted as user acceptance.
func interactiveCheckpoint(t *testing.T, dir, phase, app, home, label string) {
	t.Helper()
	if !filepath.IsAbs(dir) || os.Getenv("SS_UPDATE_TEST_NATIVE") != "1" || os.Getenv("SS_UPDATE_TEST_LAUNCHSERVICES") != "1" {
		t.Fatal("interactive checks require an absolute output path and isolated native LaunchServices mode")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.MarshalIndent(map[string]string{"phase": phase, "app": app, "home": home, "bundle_identifier": label}, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, phase+".json"), b, 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("notification checkpoint %s; waiting for %s", phase, filepath.Join(dir, phase+".continue"))
	for until := time.Now().Add(10 * time.Minute); time.Now().Before(until); {
		if _, err := os.Stat(filepath.Join(dir, phase+".continue")); err == nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatal("notification click checkpoint expired; no click verification claimed")
}

func writeExclusive(path string, b []byte) error {
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if e != nil {
		return e
	}
	_, e = f.Write(b)
	ce := f.Close()
	if e != nil {
		return e
	}
	return ce
}

func setTestIdentity(t *testing.T, app, label string) {
	t.Helper()
	if _, e := command("/usr/libexec/PlistBuddy", "-c", "Set :CFBundleIdentifier "+label, "-c", "Set :CFBundleDisplayName SS 升级隔离验收", "-c", "Set :CFBundleURLTypes:0:CFBundleURLSchemes:0 "+label, filepath.Join(app, "Contents/Info.plist")); e != nil {
		t.Fatal(e)
	}
	setTestHelperIdentity(t, filepath.Join(app, "Contents/MacOS/Session Steward.app"), label)
	if _, e := command("/usr/bin/codesign", "--force", "--sign", "-", "--identifier", label, app); e != nil {
		t.Fatal(e)
	}
}

func setTestHelperIdentity(t *testing.T, app, hostLabel string) {
	t.Helper()
	if _, e := command("/usr/libexec/PlistBuddy", "-c", "Set :CFBundleIdentifier "+hostLabel+".notifications", "-c", "Set :CFBundleDisplayName SS 升级隔离验收", "-c", "Set :StewardHostBundleIdentifier "+hostLabel, filepath.Join(app, "Contents/Info.plist")); e != nil {
		t.Fatal(e)
	}
	if _, e := command("/usr/bin/codesign", "--force", "--sign", "-", "--identifier", hostLabel+".notifications", app); e != nil {
		t.Fatal(e)
	}
}
