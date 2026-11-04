// Synthetic-only preview: real SS HTTP/core/store/native adapter, no Codex/model/network calls.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/nativecontrol"
	"github.com/xoqiu09/session-steward/internal/server"
	"github.com/xoqiu09/session-steward/internal/store"
)

type fakeRPC struct {
	mu     sync.Mutex
	events chan nativecontrol.Message
	closed bool
	thread string
	turn   int
}

func (f *fakeRPC) Call(_ context.Context, method string, p, out any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	var result any = map[string]any{}
	switch method {
	case "thread/start":
		result = map[string]any{"thread": map[string]string{"id": f.thread}}
	case "thread/resume":
		f.thread = p.(map[string]any)["threadId"].(string)
		result = map[string]any{"thread": map[string]string{"id": p.(map[string]any)["threadId"].(string)}}
	case "turn/start":
		f.turn++
		turn := fmt.Sprintf("%s-turn-%d", f.thread, f.turn)
		result = map[string]any{"turn": map[string]string{"id": turn}}
		go func() {
			time.Sleep(5 * time.Second)
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.closed {
				return
			}
			b, _ := json.Marshal(map[string]any{"threadId": f.thread, "turn": map[string]string{"id": turn, "status": "completed"}})
			f.events <- nativecontrol.Message{Method: "turn/completed", Params: b}
		}()
	}
	if out != nil {
		b, _ := json.Marshal(result)
		return json.Unmarshal(b, out)
	}
	return nil
}
func (f *fakeRPC) Notify(string, any) error             { return nil }
func (f *fakeRPC) Reply(json.RawMessage, any) error     { return nil }
func (f *fakeRPC) Reject(json.RawMessage) error         { return nil }
func (f *fakeRPC) Events() <-chan nativecontrol.Message { return f.events }
func (f *fakeRPC) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		close(f.events)
	}
	return nil
}
func main() {
	if len(os.Args) != 2 {
		log.Fatal("usage: go run ./scripts/orchestration-preview <synthetic-data-directory>")
	}
	base := os.Args[1]
	if err := os.MkdirAll(base, 0700); err != nil {
		log.Fatal(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	repo := filepath.Join(base, "synthetic-project")
	if _, e := os.Stat(filepath.Join(repo, ".git")); e != nil {
		for _, a := range [][]string{{"init", "-q", "-b", "main", repo}, {"-C", repo, "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-q", "--allow-empty", "-m", "synthetic initial"}} {
			if out, e := exec.Command("git", a...).CombinedOutput(); e != nil {
				log.Fatalf("synthetic git: %s %v", out, e)
			}
		}
	}
	st, e := store.Open(filepath.Join(base, "synthetic.sqlite"))
	if e != nil {
		log.Fatal(e)
	}
	defer st.Close()
	c := core.New(st, gitx.NewLocator())
	c.WorktreeRoot = filepath.Join(base, "worktrees")
	_, e = c.Ingest(ctx, &event.Event{EventID: "synthetic-seed", SchemaVersion: 1, OccurredAt: time.Now(), Source: event.Source{Provider: "claude", HostID: "synthetic-host"}, SessionID: "synthetic-seed", Cwd: repo, Kind: event.KindSessionStart})
	if e != nil {
		log.Fatal(e)
	}
	var rid int64
	if e = st.R().QueryRow(`SELECT id FROM repos WHERE name='synthetic-project'`).Scan(&rid); e != nil {
		log.Fatal(e)
	}
	if e = c.SetDispatchProject(ctx, rid, true); e != nil {
		log.Fatal(e)
	}
	var existing int
	st.R().QueryRow(`SELECT count(*) FROM work_items WHERE id='DEMO-1'`).Scan(&existing)
	if existing == 0 {
		if e = c.CreateWorkItem(ctx, core.WorkItemInput{ID: "DEMO-1", RepoID: rid, Title: "合成示例：核对保存按钮", Acceptance: "合成测试可以保存并显示回执"}); e != nil {
			log.Fatal(e)
		}
	}
	var n atomic.Int64
	desk, e := nativecontrol.NewDesk(ctx, c, func(context.Context, string) (nativecontrol.Transport, error) {
		number := n.Add(1)
		return &fakeRPC{thread: fmt.Sprintf("synthetic-thread-%d-%d", time.Now().UnixNano(), number), events: make(chan nativecontrol.Message, 32)}, nil
	}, "synthetic-host", "合成演示电脑", "合成执行器 · 不调用真实 Codex")
	if e != nil {
		log.Fatal(e)
	}
	defer desk.Close()
	c.OrchExecutor = desk
	if e = c.RecoverOrchestration(ctx); e != nil {
		log.Fatal(e)
	}
	go c.OrchestrationRun(ctx)
	s := &server.Server{Core: c, IngestToken: "synthetic-ingest", PanelToken: "synthetic-preview", Dispatch: desk, Static: os.DirFS("web/dist"), BuildCommit: "synthetic-orchestration-preview"}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		log.Fatal(e)
	}
	address := "http://" + listener.Addr().String() + "/login?t=synthetic-preview&next=%2F%3Fview%3Ddispatch"
	if e = os.WriteFile(filepath.Join(base, "address.txt"), []byte(address+"\n"), 0600); e != nil {
		log.Fatal(e)
	}
	fmt.Println(address)
	srv := &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() { <-ctx.Done(); srv.Shutdown(context.Background()) }()
	if e = srv.Serve(listener); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}
