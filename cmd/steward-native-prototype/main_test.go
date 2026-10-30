package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrototypeHomeRefusesExistingUnmarkedDatabase(t *testing.T) {
	home := t.TempDir()
	db := filepath.Join(home, "steward.sqlite")
	if err := os.WriteFile(db, []byte("synthetic-existing-database"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareHome(home, filepath.Join(t.TempDir(), "production")); err == nil {
		t.Fatal("opened unmarked existing database")
	}
	b, _ := os.ReadFile(db)
	if string(b) != "synthetic-existing-database" {
		t.Fatal("existing data changed")
	}
}
func TestPrototypeHomeMarkerAndSymlinkProtection(t *testing.T) {
	home := t.TempDir()
	production := filepath.Join(t.TempDir(), "production")
	if err := prepareHome(home, production); err != nil {
		t.Fatal(err)
	}
	if err := prepareHome(home, production); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "synthetic.sqlite")
	_ = os.WriteFile(target, []byte("keep"), 0600)
	if err := os.Symlink(target, filepath.Join(home, "steward.sqlite")); err != nil {
		t.Fatal(err)
	}
	if err := prepareHome(home, production); err == nil {
		t.Fatal("accepted state symlink")
	}
}

func TestProductionChildViaSymlinkIsRejectedBeforeWriting(t *testing.T) {
	root := t.TempDir()
	prod := filepath.Join(root, "production")
	if err := os.Mkdir(prod, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(prod, alias); err != nil {
		t.Fatal(err)
	}
	if err := prepareHome(filepath.Join(alias, "child"), prod); err == nil {
		t.Fatal("production child accepted")
	}
	if _, err := os.Stat(filepath.Join(prod, "child")); !os.IsNotExist(err) {
		t.Fatal("wrote into production before rejecting")
	}
}

func TestPrivateHostsOmitsUnconfiguredRemote(t *testing.T) {
	if got := privateHosts(""); got != nil {
		t.Fatalf("empty remote produced an allowlist: %#v", got)
	}
	if got := privateHosts("synthetic.ts.net"); len(got) != 1 || got[0] != "synthetic.ts.net" {
		t.Fatalf("explicit remote lost: %#v", got)
	}
}
