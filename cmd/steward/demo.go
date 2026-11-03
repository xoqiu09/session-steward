package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	steward "github.com/xoqiu09/session-steward"
	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/demodata"
	"github.com/xoqiu09/session-steward/internal/server"
	"github.com/xoqiu09/session-steward/internal/store"
)

// demo intentionally does not call serve/config.Load: it must not scan local
// sessions, discover Agent tools, install hooks, notify, or resume background jobs.
func demo(args []string) error {
	flags := flag.NewFlagSet("demo", flag.ContinueOnError)
	dir := flags.String("dir", "", "全新的绝对路径；默认创建临时目录，不复用已有目录")
	listen := flags.String("listen", "127.0.0.1:0", "演示监听地址；0 自动选空闲端口，仅允许 127.0.0.1")
	noOpen := flags.Bool("no-open", false, "只启动，不打开浏览器")
	if err := flags.Parse(args); errors.Is(err, flag.ErrHelp) {
		return nil
	} else if err != nil {
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("demo 不接受位置参数；使用 --dir 指定新目录")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runDemo(ctx, *dir, *listen, !*noOpen, os.Stdout)
}

type demoInstance struct {
	dir      string
	listener net.Listener
	store    *store.Store
	core     *core.Core
	server   *server.Server
}

func prepareDemo(ctx context.Context, requestedDir, listen string) (_ *demoInstance, err error) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil || host != "127.0.0.1" {
		return nil, fmt.Errorf("演示只允许 --listen 127.0.0.1:PORT")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 0 || p > 65535 {
		return nil, fmt.Errorf("演示端口应为 0–65535；0 自动选择空闲端口")
	}
	if requestedDir != "" && !filepath.IsAbs(requestedDir) {
		return nil, fmt.Errorf("--dir 需要全新的绝对路径")
	}
	listener, err := net.Listen("tcp4", listen)
	if err != nil {
		return nil, err
	}
	instance := &demoInstance{listener: listener}
	defer func() {
		if err != nil {
			instance.close()
		}
	}()
	if requestedDir == "" {
		instance.dir, err = os.MkdirTemp("", "session-steward-demo-*")
	} else {
		instance.dir = filepath.Clean(requestedDir)
		// Mkdir is exclusive, even for an empty directory or a symlink. Never
		// clear/reuse a user directory or trust STEWARD_HOME for a demo.
		err = os.Mkdir(instance.dir, 0o700)
	}
	if err != nil {
		return nil, fmt.Errorf("演示需要一个不存在的新目录，未清理或覆盖原路径: %w", err)
	}
	if instance.dir, err = filepath.EvalSymlinks(instance.dir); err != nil {
		return nil, err
	}
	secrets := map[string]string{}
	for _, name := range []string{"ingest.token", "panel.token"} {
		var bytes [32]byte
		if _, err = rand.Read(bytes[:]); err != nil {
			return nil, err
		}
		secrets[name] = hex.EncodeToString(bytes[:])
		if err = os.WriteFile(filepath.Join(instance.dir, name), []byte(secrets[name]+"\n"), 0o600); err != nil {
			return nil, err
		}
	}
	// This file supports a later explicit STEWARD_HOME=... steward open. The
	// demo runtime below does not load normal service configuration at all.
	configuration, _ := json.Marshal(map[string]any{
		"listen": listener.Addr().String(), "history_days": 0, "reporting_hints": false,
		"notify_macos": false, "auto_merge": false,
	})
	if err = os.WriteFile(filepath.Join(instance.dir, "config.json"), configuration, 0o600); err != nil {
		return nil, err
	}
	if instance.store, err = store.Open(filepath.Join(instance.dir, "steward.sqlite")); err != nil {
		return nil, err
	}
	instance.core = core.New(instance.store, demodata.Locator{})
	instance.core.StewardHome = instance.dir
	if err = demodata.Seed(ctx, instance.core, instance.dir); err != nil {
		return nil, err
	}
	var static fs.FS
	if static, err = fs.Sub(steward.WebDist, "web/dist"); err != nil {
		return nil, err
	}
	instance.server = &server.Server{
		BuildCommit: BuildCommit, Core: instance.core, IngestToken: secrets["ingest.token"],
		PanelToken: secrets["panel.token"], Static: static, Listen: listener.Addr().String(),
		DispatchUnavailable: "合成演示不接入真实 Agent；请退出演示后在正式 App 中使用。",
	}
	return instance, nil
}

func (instance *demoInstance) close() {
	if instance.listener != nil {
		instance.listener.Close()
	}
	if instance.core != nil {
		instance.core.CloseJobs()
	}
	if instance.store != nil {
		instance.store.Close()
	}
}

func (instance *demoInstance) handler() http.Handler {
	next := instance.server.Handler()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The conversation resolver normally consults the real Agent home.
		// Demo sessions are fictional; never resolve them or ingest live hooks.
		if strings.HasPrefix(r.URL.Path, "/hook/") ||
			strings.HasPrefix(r.URL.Path, "/api/sessions/") && strings.HasSuffix(r.URL.Path, "/conversation") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			json.NewEncoder(w).Encode(map[string]string{"error": "合成演示不接收真实 hooks，也不读取或恢复真实会话。"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func runDemo(ctx context.Context, dir, listen string, launchBrowser bool, output io.Writer) error {
	instance, err := prepareDemo(ctx, dir, listen)
	if err != nil {
		return err
	}
	defer instance.close()
	base := "http://" + instance.listener.Addr().String()
	panel := base + "/?view=town&world=1"
	srv := &http.Server{Handler: instance.handler(), ReadHeaderTimeout: 10 * time.Second}
	shutdownSignal, stop := context.WithCancel(ctx)
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-shutdownSignal.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if srv.Shutdown(shutdown) != nil {
			srv.Close()
		}
	}()
	// If Serve fails early, also release the shutdown goroutine before closing
	// the store. Shutdown waits for in-flight API handlers to finish.
	defer func() { stop(); <-stopped }()
	served := make(chan error, 1)
	go func() { served <- srv.Serve(instance.listener) }()
	fmt.Fprintf(output, "合成演示已启动：%s\n三个示例项目、模拟进展；不安装 hooks、不读取真实会话、不启动 Agent。\n演示数据：%s\n按 Ctrl+C 停止；数据保留，重新运行会创建另一份新演示。\n", panel, instance.dir)
	if launchBrowser {
		login := base + "/login?t=" + url.QueryEscape(instance.server.PanelToken) + "&next=" + url.QueryEscape("/?view=town&world=1")
		command := "open"
		if runtime.GOOS != "darwin" {
			command = "xdg-open"
		}
		openContext, cancelOpen := context.WithTimeout(ctx, 5*time.Second)
		err := exec.CommandContext(openContext, command, login).Run()
		cancelOpen()
		if err != nil {
			// Do not put the token URL in logs or terminal history.
			binary, executableErr := os.Executable()
			if executableErr != nil {
				fmt.Fprintln(output, "浏览器未打开。请保持此终端运行，在另一终端指定上述 STEWARD_HOME，用当前 steward 程序执行 open。")
			} else {
				quote := func(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
				fmt.Fprintf(output, "浏览器未打开。请保持此终端运行，在另一终端执行：\nSTEWARD_HOME=%s %s open\n", quote(instance.dir), quote(binary))
			}
		}
	}
	err = <-served
	if errors.Is(err, http.ErrServerClosed) || errors.Is(err, net.ErrClosed) {
		err = nil
	}
	return err
}
