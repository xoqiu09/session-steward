package updater

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func signed(t *testing.T, m Manifest) (*Client, []byte) {
	t.Helper()
	pub, key, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	b, _ := json.Marshal(m)
	raw, _ := json.Marshal(Envelope{base64.StdEncoding.EncodeToString(b), base64.StdEncoding.EncodeToString(ed25519.Sign(key, b))})
	return &Client{Key: base64.StdEncoding.EncodeToString(pub)}, raw
}
func manifest() Manifest {
	return Manifest{Format: 1, Version: "0.2.0", Build: 2026102902, Commit: strings.Repeat("a", 40), Schema: 4, MinOS: 13, Notes: "synthetic notes", Assets: map[string]Asset{"arm64": {Repository + "/releases/download/v0.2.0/test.zip", strings.Repeat("a", 64), 12}, "amd64": {Repository + "/releases/download/v0.2.0/test-intel.zip", strings.Repeat("b", 64), 12}}}
}
func TestSignedManifestAndEligibility(t *testing.T) {
	m := manifest()
	c, raw := signed(t, m)
	got, e := c.Verify(raw)
	if e != nil || got.Build != m.Build {
		t.Fatal(e)
	}
	if e = got.Eligible(2026102901, 4, "arm64", 13); e != nil {
		t.Fatal(e)
	}
	for _, tc := range []struct {
		name   string
		build  int64
		schema int
		arch   string
		os     int
	}{{"repeat", m.Build, 4, "arm64", 13}, {"downgrade", m.Build + 1, 4, "arm64", 13}, {"unknown build", 0, 4, "arm64", 13}, {"migration", 1, 3, "arm64", 13}, {"architecture", 1, 4, "386", 13}, {"os", 1, 4, "arm64", 12}} {
		t.Run(tc.name, func(t *testing.T) {
			if got.Eligible(tc.build, tc.schema, tc.arch, tc.os) == nil {
				t.Fatal("accepted incompatible release")
			}
		})
	}
	got.Version = "0.3.0-rc.1"
	if got.Eligible(1, 4, "amd64", 15) == nil {
		t.Fatal("accepted prerelease")
	}
	c.Key = ""
	if _, e = c.Verify(raw); e == nil {
		t.Fatal("accepted missing key")
	}
	other, _ := signed(t, m)
	if _, e = other.Verify(raw); e == nil {
		t.Fatal("accepted wrong signer")
	}
	var env Envelope
	_ = json.Unmarshal(raw, &env)
	env.Payload = base64.StdEncoding.EncodeToString([]byte(`{"format":1}`))
	raw, _ = json.Marshal(env)
	if _, e = other.Verify(raw); e == nil {
		t.Fatal("accepted tampering")
	}
	for _, u := range []string{"http://github.com/a", "https://evil.example/a", "https://github.com.evil.example/a", "file:///tmp/a"} {
		if _, e = NewClient().get(context.Background(), u); e == nil {
			t.Fatalf("accepted %s", u)
		}
	}
}
func TestSignedBadAssets(t *testing.T) {
	for _, edit := range []func(*Manifest){func(m *Manifest) {
		m.Assets["arm64"] = Asset{"https://evil.example/archive", strings.Repeat("a", 64), 1}
	}, func(m *Manifest) { m.Version = "commit123" }, func(m *Manifest) { m.Build = 0 }, func(m *Manifest) { m.Schema = 0 }, func(m *Manifest) { m.Commit = "short" }} {
		m := manifest()
		edit(&m)
		c, raw := signed(t, m)
		if _, e := c.Verify(raw); e == nil {
			t.Fatal("accepted malformed signed metadata")
		}
	}
}
func TestDownloadRetryIntegrityAndInterruption(t *testing.T) {
	good := []byte("synthetic archive")
	sum := sha256.Sum256(good)
	body := good
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(body) }))
	defer server.Close()
	c := &Client{HTTP: server.Client(), allowLocal: true}
	a := Asset{server.URL, hex.EncodeToString(sum[:]), int64(len(good))}
	dst := filepath.Join(t.TempDir(), "download")
	body = []byte("truncated")
	if e := c.Download(context.Background(), a, dst, nil); e == nil {
		t.Fatal("accepted truncation")
	}
	if _, e := os.Stat(dst); !os.IsNotExist(e) {
		t.Fatal("partial download retained")
	}
	body = bytes.Repeat([]byte("X"), len(good))
	if c.Download(context.Background(), a, dst, nil) == nil {
		t.Fatal("accepted wrong checksum")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if c.Download(ctx, a, dst, nil) == nil {
		t.Fatal("ignored cancellation")
	}
	body = good
	var received int64
	if e := c.Download(context.Background(), a, dst, func(n, total int64) { received = n }); e != nil || received != int64(len(good)) {
		t.Fatal(e, received)
	}
	if e := c.Download(context.Background(), a, dst, nil); e == nil {
		t.Fatal("overwrote existing download")
	}
}
func archive(t *testing.T, names []string, symlink bool) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.zip")
	f, e := os.Create(path)
	if e != nil {
		t.Fatal(e)
	}
	w := zip.NewWriter(f)
	for _, name := range names {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		h.SetMode(0755)
		if symlink {
			h.SetMode(os.ModeSymlink | 0755)
		}
		out, e := w.CreateHeader(h)
		if e != nil {
			t.Fatal(e)
		}
		_, _ = out.Write([]byte("test"))
	}
	if e = w.Close(); e != nil {
		t.Fatal(e)
	}
	f.Close()
	return path
}
func TestExtractRejectsTraversalAndLinks(t *testing.T) {
	for _, names := range [][]string{{"../outside"}, {"Session Steward.app/../../outside"}, {"/Session Steward.app/bin"}, {"Session Steward.app/a", "Session Steward.app/a"}, {"Session Steward.app/./a"}, {"Session Steward.app\\a"}, {"other.app/bin"}} {
		t.Run(strings.Join(names, ";"), func(t *testing.T) {
			if Extract(archive(t, names, false), t.TempDir()) == nil {
				t.Fatal("accepted unsafe archive")
			}
		})
	}
	if Extract(archive(t, []string{"Session Steward.app/link"}, true), t.TempDir()) == nil {
		t.Fatal("accepted symlink")
	}
	dest := t.TempDir()
	if e := Extract(archive(t, []string{"Session Steward.app/Contents/MacOS/test"}, false), dest); e != nil {
		t.Fatal(e)
	}
}

type fakeHost struct {
	stopError, startError, healthError error
	starts, stops                      int
	rollback                           bool
}

func (h *fakeHost) Stop(*Plan) error { h.stops++; return h.stopError }
func (h *fakeHost) Start(_ *Plan, rollback bool) error {
	h.starts++
	h.rollback = rollback
	if !rollback {
		return h.startError
	}
	return nil
}
func (h *fakeHost) Healthy(*Plan) error {
	if h.rollback {
		return nil
	}
	return h.healthError
}
func transaction(t *testing.T) *Plan {
	t.Helper()
	dir := t.TempDir()
	p := &Plan{Work: dir, State: "prepared"}
	for _, name := range []string{"App", "steward", "steward-hook", "notifier"} {
		r := Replacement{Target: filepath.Join(dir, name), Staged: filepath.Join(dir, name+".new"), Backup: filepath.Join(dir, name+".old"), Existed: true}
		if e := os.WriteFile(r.Target, []byte("old "+name), 0700); e != nil {
			t.Fatal(e)
		}
		if e := os.WriteFile(r.Staged, []byte("new "+name), 0700); e != nil {
			t.Fatal(e)
		}
		p.Items = append(p.Items, r)
	}
	if e := Save(p); e != nil {
		t.Fatal(e)
	}
	return p
}
func assertOld(t *testing.T, p *Plan) {
	t.Helper()
	for _, r := range p.Items {
		b, e := os.ReadFile(r.Target)
		if e != nil || string(b) != "old "+filepath.Base(r.Target) {
			t.Fatalf("not restored: %s %q %v", r.Target, b, e)
		}
	}
}
func TestAtomicGroupInstallAndIdempotence(t *testing.T) {
	p := transaction(t)
	h := &fakeHost{}
	if e := Apply(p, h); e != nil {
		t.Fatal(e)
	}
	if p.State != "installed" || h.rollback {
		t.Fatal(p, h)
	}
	for _, r := range p.Items {
		b, _ := os.ReadFile(r.Target)
		if !strings.HasPrefix(string(b), "new ") {
			t.Fatal("partial update")
		}
		if _, e := os.Stat(r.Backup); e != nil {
			t.Fatal("backup lost")
		}
	}
	if Apply(p, h) == nil || Recover(p, h) == nil {
		t.Fatal("allowed duplicate install or rollback of committed update")
	}
}
func TestFailedUpdateRestoresAllAndPreservesData(t *testing.T) {
	for _, kind := range []string{"write failure", "start failure", "health failure"} {
		t.Run(kind, func(t *testing.T) {
			p := transaction(t)
			data := filepath.Join(p.Work, "synthetic.sqlite")
			_ = os.WriteFile(data, []byte("database with newer hook events"), 0600)
			h := &fakeHost{}
			switch kind {
			case "write failure":
				_ = os.Remove(p.Items[2].Staged)
			case "start failure":
				h.startError = errors.New("cannot launch")
			case "health failure":
				h.healthError = errors.New("wrong build")
			}
			if Apply(p, h) == nil {
				t.Fatal("ignored failure")
			}
			assertOld(t, p)
			if p.State != "rolled_back" || !h.rollback {
				t.Fatal("did not roll back")
			}
			b, _ := os.ReadFile(data)
			if string(b) != "database with newer hook events" {
				t.Fatal("overwrote DB")
			}
		})
	}
}
func TestInterruptedBetweenRenamesCanRecover(t *testing.T) {
	p := transaction(t)
	p.State = "installing"
	_ = Save(p)
	for i := 0; i < 2; i++ {
		r := p.Items[i]
		if e := rename(r.Target, r.Backup); e != nil {
			t.Fatal(e)
		}
		if i == 0 {
			if e := rename(r.Staged, r.Target); e != nil {
				t.Fatal(e)
			}
		}
	}
	if e := Recover(p, &fakeHost{}); e != nil {
		t.Fatal(e)
	}
	assertOld(t, p)
}
func TestStopFailureDoesNotReplaceFiles(t *testing.T) {
	p := transaction(t)
	if Apply(p, &fakeHost{stopError: errors.New("busy")}) == nil {
		t.Fatal("ignored stop failure")
	}
	assertOld(t, p)
}
func TestSymlinkDestinationRejected(t *testing.T) {
	dir := t.TempDir()
	if e := os.Symlink(dir, filepath.Join(dir, "link")); e != nil {
		t.Skip(e)
	}
	if plainPath(filepath.Join(dir, "link", "bin")) == nil {
		t.Fatal("accepted link")
	}
}

func TestPreparationSnapshotsRejectConcurrentChanges(t *testing.T) {
	for _, what := range []string{"target", "staged", "config"} {
		t.Run(what, func(t *testing.T) {
			p := transaction(t)
			r := &p.Items[0]
			r.OldDigest, _ = DigestTree(r.Target)
			r.NewDigest, _ = DigestTree(r.Staged)
			cfg := filepath.Join(p.Work, "config.json")
			_ = os.WriteFile(cfg, []byte("synthetic config"), 0600)
			digest, _ := DigestTree(cfg)
			p.Guards = map[string]string{cfg: digest}
			path := r.Target
			if what == "staged" {
				path = r.Staged
			}
			if what == "config" {
				path = cfg
			}
			_ = os.WriteFile(path, []byte("changed while waiting"), 0700)
			h := &fakeHost{}
			if Apply(p, h) == nil || h.stops != 0 {
				t.Fatal("overwrote a changed installation")
			}
		})
	}
}
func TestReleaseCannotUseNewOrdinalToDowngradeSemanticVersion(t *testing.T) {
	m := manifest()
	m.Version = "0.1.0"
	if m.Eligible(1, 4, "arm64", 15) == nil {
		t.Fatal("accepted semantic downgrade with a new ordinal")
	}
}
func TestInstallerLockRejectsConcurrentInstall(t *testing.T) {
	if os.PathSeparator == '\\' {
		t.Skip("macOS lock")
	}
	home := t.TempDir()
	_ = os.MkdirAll(filepath.Join(home, "updates"), 0700)
	unlock, e := Lock(home)
	if e != nil {
		t.Fatal(e)
	}
	if release, e := Lock(home); e == nil {
		release()
		t.Fatal("accepted concurrent installer")
	}
	unlock()
	again, e := Lock(home)
	if e != nil {
		t.Fatal(e)
	}
	again()
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestFetchBoundedOfficialManifestAndMissingRelease(t *testing.T) {
	c := NewClient()
	c.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != Latest {
			t.Fatal(r.URL)
		}
		return &http.Response{StatusCode: 404, Body: io.NopCloser(strings.NewReader("missing"))}, nil
	})}
	if _, e := c.Fetch(context.Background()); e == nil || !strings.Contains(e.Error(), "v0.1.0") {
		t.Fatal("old release not explained", e)
	}
	c.HTTP.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", (1<<20)+2)))}, nil
	})
	if _, e := c.Fetch(context.Background()); e == nil {
		t.Fatal("accepted oversized manifest")
	}
}
