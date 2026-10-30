//go:build darwin

package updater

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestMacStartRegistersInstalledAppOnInstallAndRecovery(t *testing.T) {
	for _, rollback := range []bool{false, true} {
		for _, mode := range []string{"own", "shared"} {
			var calls [][]string
			h := MacHost{run: func(name string, args ...string) ([]byte, error) {
				calls = append(calls, append([]string{name}, args...))
				return nil, nil
			}}
			p := &Plan{App: "/synthetic/Session Steward.app", Home: "/synthetic/home", Work: "/synthetic/transaction", Mode: mode, Plist: "/synthetic/service.plist"}
			if err := h.Start(p, rollback); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(calls[0], []string{launchServicesRegister, "-f", p.App}) {
				t.Fatal("install and rollback must re-register the restored path", calls)
			}
			if mode == "shared" && calls[1][1] != "bootstrap" {
				t.Fatal("original shared service must restart after registration", calls)
			}
			last := calls[len(calls)-1]
			if !reflect.DeepEqual(last, []string{"/usr/bin/open", "-n", "-a", p.App, "--args", "--steward-home", p.Home, "--update-transaction", p.Work}) {
				t.Fatal("restart lost its exact App or data directory", calls)
			}
		}
	}
}

func TestMacStartRegistrationFailureDoesNotLaunch(t *testing.T) {
	calls := 0
	h := MacHost{run: func(name string, args ...string) ([]byte, error) {
		calls++
		return nil, errors.New("synthetic registration failure")
	}}
	if err := h.Start(&Plan{App: "/synthetic/Session Steward.app", Mode: "shared"}, false); err == nil || calls != 1 {
		t.Fatal("registration failure must enter transaction recovery", err, calls)
	}
}

func TestMacStartRecoveryContinuesAfterRegistrationFailure(t *testing.T) {
	for _, mode := range []string{"own", "shared"} {
		for _, logWritable := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/log-writable=%t", mode, logWritable), func(t *testing.T) {
				p := &Plan{App: "/synthetic/Session Steward.app", Home: "/synthetic/home", Work: t.TempDir(), Mode: mode, Plist: "/synthetic/service.plist"}
				logPath := filepath.Join(p.Work, "install.log")
				const previousLog = "synthetic previous install entry\n"
				if logWritable {
					if err := os.WriteFile(logPath, []byte(previousLog), 0600); err != nil {
						t.Fatal(err)
					}
				} else if err := os.Mkdir(logPath, 0700); err != nil {
					t.Fatal(err)
				}
				var calls [][]string
				h := MacHost{run: func(name string, args ...string) ([]byte, error) {
					calls = append(calls, append([]string{name}, args...))
					if name == launchServicesRegister {
						return nil, errors.New("synthetic registration failure")
					}
					return nil, nil
				}}
				if err := h.Start(p, true); err != nil {
					t.Fatal("registration or log failure must not block recovery", err)
				}
				want := [][]string{{launchServicesRegister, "-f", p.App}}
				if mode == "shared" {
					want = append(want, []string{"/bin/launchctl", "bootstrap", fmt.Sprintf("gui/%d", os.Getuid()), p.Plist})
				}
				want = append(want, []string{"/usr/bin/open", "-n", "-a", p.App, "--args", "--steward-home", p.Home, "--update-transaction", p.Work})
				if !reflect.DeepEqual(calls, want) {
					t.Fatal("recovery must register, bootstrap if shared, then open", calls)
				}
				if logWritable {
					b, err := os.ReadFile(logPath)
					if err != nil {
						t.Fatal(err)
					}
					if !strings.HasPrefix(string(b), previousLog) || !strings.Contains(string(b), "恢复旧版时无法重新登记 App 链接") || !strings.Contains(string(b), "synthetic registration failure") {
						t.Fatal("recovery must append the registration failure to install.log", string(b))
					}
				}
			})
		}
	}
}
