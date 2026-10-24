package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNotificationsDefaultToBannerAndPreserveExplicitPreference(t *testing.T) {
	if c := Default(); !c.NotifyMacOS || c.NotifyDialog {
		t.Fatal("default notifications must be non-modal")
	}
	dir := t.TempDir()
	t.Setenv("STEWARD_HOME", dir)
	for _, dialog := range []bool{false, true} {
		value := `{"notify_dialog":false}`
		if dialog {
			value = `{"notify_dialog":true}`
		}
		if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
		c, err := Load()
		if err != nil || c.NotifyDialog != dialog {
			t.Fatal(c.NotifyDialog, err)
		}
	}
}
