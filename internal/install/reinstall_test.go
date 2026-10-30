package install

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReinstallUpdatesOwnCommandAndTimeoutInPlace(t *testing.T) {
	for _, provider := range []string{"claude", "codex"} {
		for _, change := range []string{"command", "timeout"} {
			t.Run(provider+"/"+change, func(t *testing.T) {
				dir := t.TempDir()
				target := ClaudeTarget(dir)
				if provider == "codex" {
					target = CodexTarget(dir)
				}
				target.Events = []string{"PermissionRequest"}
				target.Async = true // 既有 async 字段仍然不强制更改。
				installer := &Installer{StateDir: filepath.Join(dir, "state"), HookBinary: "/synthetic/old-hook", PermWait: 60}
				raw := fmt.Sprintf(`{"hooks":{"PermissionRequest":[{"matcher":"*","group_keep":"untouched","hooks":[{"type":"command","command":"third before","timeout":7},{"type":"command","command":%q,"timeout":90,"async":false,"custom":"keep"},{"type":"command","command":"third after","timeout":8}]},{"matcher":"other","hooks":[{"type":"command","command":"third group","timeout":9}]}]},"other_setting":"keep"}`, installer.command(target, "PermissionRequest"))
				if err := os.MkdirAll(filepath.Dir(target.Path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(target.Path, []byte(raw), 0600); err != nil {
					t.Fatal(err)
				}
				trustPath := filepath.Join(filepath.Dir(target.Path), "config.toml")
				trust := []byte("# synthetic other-tool and existing trust\ntrusted_hash = 'preserve'\n")
				os.WriteFile(trustPath, trust, 0600)
				if _, err := installer.Install(target); err != nil {
					t.Fatal(err)
				}
				var expected, got any
				json.Unmarshal(hookGroups(t, target)["PermissionRequest"], &expected)
				own := expected.([]any)[0].(map[string]any)["hooks"].([]any)[1].(map[string]any)
				if change == "command" {
					installer.HookBinary = "/synthetic/new path/steward-hook"
					own["command"] = installer.command(target, "PermissionRequest")
				} else {
					installer.PermWait = 120
					own["timeout"] = float64(150)
				}
				if changed, err := installer.Install(target); err != nil || !changed {
					t.Fatalf("reinstall changed=%v err=%v", changed, err)
				}
				json.Unmarshal(hookGroups(t, target)["PermissionRequest"], &got)
				if !reflect.DeepEqual(got, expected) {
					t.Fatalf("第三方、顺序或自有其他字段被改变：got=%#v want=%#v", got, expected)
				}
				if gotTrust, _ := os.ReadFile(trustPath); string(gotTrust) != string(trust) {
					t.Fatal("安装器改变了信任设置")
				}
				if changed, err := installer.Install(target); err != nil || changed {
					t.Fatalf("repeat changed=%v err=%v", changed, err)
				}
			})
		}
	}
}
