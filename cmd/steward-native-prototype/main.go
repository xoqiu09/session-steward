// An isolated personal-use prototype. Never starts the production service or Tailscale.
package main

import (
	"context"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	steward "github.com/xoqiu09/session-steward"
	"github.com/xoqiu09/session-steward/internal/config"
	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/nativecontrol"
	"github.com/xoqiu09/session-steward/internal/server"
	"github.com/xoqiu09/session-steward/internal/store"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	home := flag.String("home", "", "required isolated state directory (never ~/.steward)")
	workspace := flag.String("workspace", "", "one explicitly authorized workspace")
	listen := flag.String("listen", "127.0.0.1:18789", "loopback listener only")
	remote := flag.String("remote-host", "", "optional existing private *.ts.net proxy host; does not configure networking")
	binary := flag.String("codex", "codex", "native Codex binary")
	flag.Parse()
	if *home == "" || *workspace == "" {
		return fmt.Errorf("--home and --workspace are required")
	}
	abs, err := filepath.Abs(*home)
	if err != nil {
		return err
	}
	if real, e := filepath.EvalSymlinks(abs); e == nil {
		abs = real
	}
	userHome, _ := os.UserHomeDir()
	if abs == filepath.Join(userHome, ".steward") {
		return fmt.Errorf("refusing production STEWARD_HOME")
	}
	if *remote != "" && !strings.HasSuffix(*remote, ".ts.net") {
		return fmt.Errorf("only an explicitly named private Tailscale host is supported")
	}
	h, _, err := net.SplitHostPort(*listen)
	if err != nil || net.ParseIP(h) == nil || !net.ParseIP(h).IsLoopback() {
		return fmt.Errorf("listener must be a loopback IP")
	}
	if err = prepareHome(abs, filepath.Join(userHome, ".steward")); err != nil {
		return err
	}
	st, err := store.Open(filepath.Join(abs, "steward.sqlite"))
	if err != nil {
		return err
	}
	defer st.Close()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	c := core.New(st, gitx.NewLocator())
	if err = c.Startup(ctx); err != nil {
		return err
	}
	bin, err := exec.LookPath(*binary)
	if err != nil {
		return err
	}
	name, _ := os.Hostname()
	m, err := nativecontrol.New(ctx, c, func(ctx context.Context) (nativecontrol.Transport, error) {
		return nativecontrol.Start(ctx, bin, *workspace)
	}, abs, *workspace, config.HostID(), name)
	if err != nil {
		return err
	}
	defer m.Close()
	// This token controls only the configured workspace in this isolated process.
	token, err := newSecret(abs, "native-control.token")
	if err != nil {
		return err
	}
	panel, err := newSecret(abs, "panel.token")
	if err != nil {
		return err
	}
	assets, _ := fs.Sub(steward.WebDist, "web/dist")
	hosts := privateHosts(*remote)
	base := &server.Server{Core: c, PanelToken: panel, Static: assets, Listen: *listen, BuildCommit: "native-prototype", RemoteHosts: hosts}
	handler := (&nativecontrol.HTTP{Manager: m, Token: token, PanelToken: panel, Hosts: hosts}).Handler(base.Handler())
	srv := &http.Server{Addr: *listen, Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	fmt.Printf("Personal noncommercial prototype: http://%s/?view=native\nWorkspace fixed on %s: %s\nControl token stays in %s (not printed). No network entry configured.\n", *listen, name, *workspace, filepath.Join(abs, "native-control.token"))
	err = srv.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
func newSecret(home, name string) (string, error) {
	// config.Secret uses STEWARD_HOME; avoid changing process/global configuration.
	return nativecontrol.WriteSecret(filepath.Join(home, name))
}

func privateHosts(remote string) []string {
	if remote == "" {
		return nil
	}
	return []string{remote}
}

func prepareHome(home, production string) error {
	var err error
	home, err = prospectivePath(home)
	if err != nil {
		return err
	}
	production, err = prospectivePath(production)
	if err != nil {
		return err
	}
	if home == production || strings.HasPrefix(home, production+string(os.PathSeparator)) {
		return fmt.Errorf("refusing production state directory")
	}
	if err := os.MkdirAll(home, 0700); err != nil {
		return err
	}
	real, err := filepath.EvalSymlinks(home)
	if err != nil {
		return err
	}
	prod := production
	if x, e := filepath.EvalSymlinks(production); e == nil {
		prod = x
	}
	if real == prod || strings.HasPrefix(real, prod+string(os.PathSeparator)) {
		return fmt.Errorf("refusing production state directory")
	}
	marker := filepath.Join(real, ".ss-native-prototype")
	if _, err = os.Lstat(marker); os.IsNotExist(err) {
		if _, e := os.Lstat(filepath.Join(real, "steward.sqlite")); !os.IsNotExist(e) {
			return fmt.Errorf("existing database is not marked as an isolated prototype")
		}
		f, e := os.OpenFile(marker, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			return e
		}
		_, e = f.WriteString("ss-native-prototype-v1\n")
		f.Close()
		if e != nil {
			return e
		}
	} else if err != nil {
		return err
	}
	b, err := os.ReadFile(marker)
	if err != nil || string(b) != "ss-native-prototype-v1\n" {
		return fmt.Errorf("invalid prototype directory marker")
	}
	for _, name := range []string{"steward.sqlite", "steward.sqlite-wal", "steward.sqlite-shm", "native-session.json", ".ss-native-prototype"} {
		if fi, e := os.Lstat(filepath.Join(real, name)); e == nil && fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing state symlink")
		}
	}
	return nil
}

// Resolve symlink ancestors before creating any missing child directory.
func prospectivePath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if _, err = os.Lstat(abs); err == nil {
		return filepath.EvalSymlinks(abs)
	} else if !os.IsNotExist(err) {
		return "", err
	}
	parent, err := prospectivePath(filepath.Dir(abs))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(abs)), nil
}
