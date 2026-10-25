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

func writeConfig(t *testing.T, body string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("STEWARD_HOME", dir)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// 校验失败时不能返回带非法 listen 的配置，否则忽略错误的调用方会把 token 发往非回环地址。
func TestLoadErrorReturnsSafeDefaults(t *testing.T) {
	for name, body := range map[string]string{
		"非回环 listen": `{"listen":"0.0.0.0:7788","spool_max":5000}`,
		"非法 JSON":    `{"listen":"10.0.0.2:7788",`,
		"类型错误":       `{"listen":"10.0.0.2:7788","spool_max":"many"}`,
	} {
		t.Run(name, func(t *testing.T) {
			writeConfig(t, body)
			c, err := Load()
			if err == nil {
				t.Fatal("应返回错误")
			}
			if c.Listen != Default().Listen || c.SpoolMax != Default().SpoolMax {
				t.Fatalf("出错时应返回默认配置: %+v", c)
			}
		})
	}
}

func TestLoadMissingFileIsDefault(t *testing.T) {
	t.Setenv("STEWARD_HOME", t.TempDir())
	c, err := Load()
	if err != nil || c.Listen != Default().Listen {
		t.Fatal(c, err)
	}
}

func TestNumericFieldsFallBackBelowMinimum(t *testing.T) {
	d := Default()
	writeConfig(t, `{"permission_wait_sec":0,"spool_max":-1,"check_timeout_sec":3,"stale_after_min":0,"history_days":-7}`)
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.PermissionWaitSec != d.PermissionWaitSec || c.SpoolMax != d.SpoolMax || c.CheckTimeoutSec != d.CheckTimeoutSec ||
		c.StaleAfterMin != d.StaleAfterMin || c.HistoryDays != d.HistoryDays {
		t.Fatalf("低于下限应回落默认值: %+v", c)
	}
	writeConfig(t, `{"permission_wait_sec":45,"spool_max":10,"check_timeout_sec":60,"stale_after_min":1,"history_days":0}`)
	c, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.PermissionWaitSec != 45 || c.SpoolMax != 10 || c.CheckTimeoutSec != 60 || c.StaleAfterMin != 1 || c.HistoryDays != 0 {
		t.Fatalf("合法值应保留: %+v", c)
	}
}
