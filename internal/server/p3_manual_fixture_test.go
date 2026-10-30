package server

// 手动验收专用；正常 go test 永远跳过。不调用完整 serve、历史扫描或后台任务。
import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	steward "github.com/xoqiu09/session-steward"
	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/install"
	"github.com/xoqiu09/session-steward/internal/store"
)

func TestP3ManualAcceptanceFixture(t *testing.T) {
	root := os.Getenv("SS_P3_MANUAL_TEST_DIR")
	if root == "" {
		t.Skip("manual only: explicit empty ss-p3-acceptance-* directory required")
	}
	root = filepath.Clean(root)
	if !filepath.IsAbs(root) || !strings.HasPrefix(filepath.Base(root), "ss-p3-acceptance-") {
		t.Fatal("Use a newly created absolute ss-p3-acceptance-* directory")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("Acceptance directory must be a real empty directory")
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 0 {
		t.Fatal("Refusing to reuse a nonempty directory")
	}
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	root = realRoot
	home, _ := os.UserHomeDir()
	realHome, _ := filepath.EvalSymlinks(home)
	stewardRelative, _ := filepath.Rel(filepath.Join(realHome, ".steward"), root)
	if root == realHome || stewardRelative == "." || (stewardRelative != ".." && !strings.HasPrefix(stewardRelative, ".."+string(os.PathSeparator))) {
		t.Fatal("Refusing real application home")
	}
	if exec.Command("git", "-C", root, "rev-parse", "--show-toplevel").Run() == nil {
		t.Fatal("Refusing a directory inside an existing repository")
	}
	listen := os.Getenv("SS_P3_MANUAL_TEST_LISTEN")
	if listen == "" {
		listen = "127.0.0.1:24873"
	}
	host, port, err := net.SplitHostPort(listen)
	portNumber, portErr := strconv.Atoi(port)
	if err != nil || portErr != nil || host != "127.0.0.1" || portNumber < 1024 || portNumber > 65535 || portNumber == 7788 || portNumber == 8443 || portNumber == 18787 || portNumber == 53131 {
		t.Fatal("Use a dedicated loopback port distinct from formal and existing previews")
	}
	listener, err := net.Listen("tcp", listen)
	if err != nil {
		t.Fatal("Port unavailable; choose another test port")
	}
	t.Cleanup(func() { listener.Close() })
	dataHome := filepath.Join(root, "ss-home")
	if err := os.Mkdir(dataHome, 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("STEWARD_HOME", dataHome)
	secret := func() string {
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			t.Fatal(err)
		}
		return hex.EncodeToString(b)
	}
	ingest, panel := secret(), secret()
	for name, value := range map[string]string{"ingest.token": ingest, "panel.token": panel, "config.json": fmt.Sprintf(`{"listen":%q,"reporting_hints":false}`, listen)} {
		if err := os.WriteFile(filepath.Join(dataHome, name), []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"repo-a", "repo-b"} {
		dir := filepath.Join(root, name)
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := exec.Command("git", "-c", "init.defaultBranch=main", "-c", "core.hooksPath=/dev/null", "init", dir).Run(); err != nil {
			t.Fatal(err)
		}
	}
	st, err := store.Open(filepath.Join(dataHome, "steward.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := core.New(st, gitx.NewLocator())
	for i, name := range []string{"repo-a", "repo-b"} {
		noMerge := false
		if err := c.CreateWorkItem(context.Background(), core.WorkItemInput{ID: fmt.Sprintf("P3-%d", i+1), Title: "P3 合成目录归属验收 " + name, RepoPath: filepath.Join(root, name), NeedsMerge: &noMerge}); err != nil {
			t.Fatal(err)
		}
	}
	static, err := fs.Sub(steward.WebDist, "web/dist")
	if err != nil {
		t.Fatal(err)
	}
	monitor := &install.Monitor{Targets: []install.Target{install.ClaudeProjectTarget(filepath.Join(root, "repo-a"))}}
	s := &Server{Core: c, IngestToken: ingest, PanelToken: panel, PermWait: 10 * time.Second, Static: static, Listen: listen, BuildCommit: "P3-synthetic-acceptance", HookCoverage: monitor.Snapshot}
	handler := p3SyntheticHooksOnly(root, s.Handler())
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	marker, _ := json.MarshalIndent(map[string]any{"purpose": "P3 synthetic acceptance only", "listen": listen, "pid": os.Getpid(), "data_home": dataHome}, "", "  ")
	if err := os.WriteFile(filepath.Join(root, ".ss-p3-acceptance.json"), marker, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	deadline, cancel := context.WithTimeout(ctx, 25*time.Minute)
	defer cancel()
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		<-deadline.Done()
		shutdown, done := context.WithTimeout(context.Background(), 2*time.Second)
		defer done()
		if server.Shutdown(shutdown) != nil {
			server.Close()
		}
	}()
	t.Logf("P3 synthetic fixture ready at http://%s (no token printed); data retained under %s", listen, root)
	if err := server.Serve(listener); err != http.ErrServerClosed {
		cancel()
		t.Fatal(err)
	}
	<-stopped
}

func p3SyntheticHooksOnly(root string, product http.Handler) http.Handler {
	// 拒绝测试目录之外的 hook，避免误连客户端把正式项目带进验收库。
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/hook/") {
			body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			if err != nil {
				http.Error(w, "invalid synthetic request", 400)
				return
			}
			var paths struct {
				Cwd         string `json:"cwd"`
				ProjectPath string `json:"project_path"`
				NewCwd      string `json:"new_cwd"`
			}
			if json.Unmarshal(body, &paths) != nil {
				http.Error(w, "invalid synthetic request", 400)
				return
			}
			if paths.Cwd == "" && paths.ProjectPath == "" && paths.NewCwd == "" {
				http.Error(w, "synthetic directory required", 403)
				return
			}
			for _, path := range []string{paths.Cwd, paths.ProjectPath, paths.NewCwd} {
				if path == "" {
					continue
				}
				resolved, err := filepath.EvalSymlinks(path)
				if err != nil || !filepath.IsAbs(path) {
					http.Error(w, "synthetic directories only", 403)
					return
				}
				relative, err := filepath.Rel(root, resolved)
				if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
					http.Error(w, "synthetic directories only", 403)
					return
				}
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		product.ServeHTTP(w, r)
	})
}

func TestP3SyntheticHookDirectoryGuard(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a, b := filepath.Join(root, "a"), filepath.Join(root, "b")
	for _, dir := range []string{a, b} {
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	outside := t.TempDir()
	for _, tc := range []struct {
		name string
		body map[string]string
		want int
	}{
		{"external new cwd", map[string]string{"cwd": a, "new_cwd": outside}, 403},
		{"no directory", map[string]string{"hook_event_name": "TaskCompleted"}, 403},
		{"synthetic cwd change", map[string]string{"cwd": a, "new_cwd": b}, 204},
		{"synthetic project", map[string]string{"project_path": a}, 204},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(tc.body)
			handler := p3SyntheticHooksOnly(root, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				got, _ := io.ReadAll(r.Body)
				if !bytes.Equal(got, body) {
					t.Error("body was not preserved")
				}
				w.WriteHeader(204)
			}))
			rr := httptest.NewRecorder()
			handler.ServeHTTP(rr, httptest.NewRequest(http.MethodPost, "/hook/event", bytes.NewReader(body)))
			if rr.Code != tc.want {
				t.Fatalf("status %d, want %d", rr.Code, tc.want)
			}
		})
	}
}
