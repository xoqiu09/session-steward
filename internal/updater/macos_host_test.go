//go:build darwin

package updater

import (
	"errors"
	"reflect"
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
