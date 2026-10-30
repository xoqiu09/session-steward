// Offline release manifest signer. Never creates or uploads signing keys.
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/xoqiu09/session-steward/internal/store"
	"github.com/xoqiu09/session-steward/internal/updater"
)

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run() error {
	version := flag.String("version", "", "semantic release version")
	build := flag.Int64("build", 0, "monotonic release ordinal")
	commit := flag.String("commit", "", "full commit")
	dir := flag.String("dir", "", "release asset directory")
	notes := flag.String("notes", "", "UTF-8 release notes file")
	flag.Parse()
	keyPath := os.Getenv("UPDATE_SIGNING_KEY_FILE")
	if keyPath == "" {
		return fmt.Errorf("UPDATE_SIGNING_KEY_FILE must point to an existing offline Ed25519 PKCS#8 PEM key; no key was generated")
	}
	b, e := os.ReadFile(keyPath)
	if e != nil {
		return e
	}
	block, _ := pem.Decode(b)
	if block == nil {
		return fmt.Errorf("key must be PKCS#8 PEM")
	}
	parsed, e := x509.ParsePKCS8PrivateKey(block.Bytes)
	if e != nil {
		return e
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		return fmt.Errorf("key must be Ed25519")
	}
	public := base64.StdEncoding.EncodeToString(key.Public().(ed25519.PublicKey))
	if public != os.Getenv("UPDATE_PUBLIC_KEY") {
		return fmt.Errorf("signing key does not match UPDATE_PUBLIC_KEY pinned in the App")
	}
	text, e := os.ReadFile(*notes)
	if e != nil {
		return e
	}
	m := updater.Manifest{Format: 1, Version: strings.TrimPrefix(*version, "v"), Build: *build, Commit: *commit, Schema: store.SchemaVersion(), MinOS: 13, Notes: string(text), Assets: map[string]updater.Asset{}}
	for _, arch := range []string{"arm64", "amd64"} {
		name := fmt.Sprintf("Session-Steward_v%s_macOS_%s.app.zip", m.Version, arch)
		b, e := os.ReadFile(filepath.Join(*dir, name))
		if e != nil {
			return e
		}
		sum := sha256.Sum256(b)
		m.Assets[arch] = updater.Asset{URL: updater.Repository + "/releases/download/v" + m.Version + "/" + name, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(b))}
	}
	payload, e := json.Marshal(m)
	if e != nil {
		return e
	}
	raw, e := json.MarshalIndent(updater.Envelope{Payload: base64.StdEncoding.EncodeToString(payload), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(key, payload))}, "", "  ")
	if e != nil {
		return e
	}
	c := updater.NewClient()
	c.Key = public
	if _, e = c.Verify(raw); e != nil {
		return e
	}
	return os.WriteFile(filepath.Join(*dir, "update-manifest.json"), append(raw, '\n'), 0644)
}
