package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/xoqiu09/session-steward/internal/updater"
)

// Test identity is generated in memory for this test only, never production.
func TestOfflineSignerRoundTrip(t *testing.T) {
	dir := t.TempDir()
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	der, e := x509.MarshalPKCS8PrivateKey(key)
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(dir, "test-key.pem")
	if e = os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0600); e != nil {
		t.Fatal(e)
	}
	notes := filepath.Join(dir, "notes.txt")
	_ = os.WriteFile(notes, []byte("synthetic release"), 0600)
	for _, arch := range []string{"arm64", "amd64"} {
		_ = os.WriteFile(filepath.Join(dir, "Session-Steward_v0.2.0_macOS_"+arch+".app.zip"), []byte("synthetic package "+arch), 0600)
	}
	t.Setenv("UPDATE_PUBLIC_KEY", base64.StdEncoding.EncodeToString(pub))
	t.Setenv("UPDATE_SIGNING_KEY_FILE", path)
	original := os.Args
	originalFlags := flag.CommandLine
	t.Cleanup(func() { os.Args = original; flag.CommandLine = originalFlags })
	args := []string{"signer", "-version", "v0.2.0", "-build", "2026102902", "-commit", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "-dir", dir, "-notes", notes}
	invoke := func() error {
		os.Args = args
		flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
		return run()
	}
	if e = invoke(); e != nil {
		t.Fatal(e)
	}
	raw, e := os.ReadFile(filepath.Join(dir, "update-manifest.json"))
	if e != nil {
		t.Fatal(e)
	}
	c := updater.NewClient()
	c.Key = os.Getenv("UPDATE_PUBLIC_KEY")
	m, e := c.Verify(raw)
	if e != nil || len(m.Assets) != 2 || m.Notes != "synthetic release" {
		t.Fatal(e, m)
	}
	t.Setenv("UPDATE_PUBLIC_KEY", "")
	if invoke() == nil {
		t.Fatal("signed with mismatched key")
	}
	t.Setenv("UPDATE_SIGNING_KEY_FILE", "")
	if invoke() == nil {
		t.Fatal("invented a signing identity")
	}
}
