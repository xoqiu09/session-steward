package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/hook"
	"github.com/xoqiu09/session-steward/internal/store"
)

type loc struct{}

func (loc) Locate(context.Context, string) gitx.Location {
	return gitx.Location{IsGit: true, CommonDir: "/r/.git", Worktree: "/r", RepoName: "r"}
}

func start(t *testing.T) (*httptest.Server, *core.Core, *Server) {
	st, err := store.Open(filepath.Join(t.TempDir(), "s.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := core.New(st, loc{})
	s := &Server{Core: c, IngestToken: "ing", PanelToken: "pan", PermWait: 5 * time.Second}
	ts := httptest.NewUnstartedServer(s.Handler())
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	ts.Listener = l
	ts.Start()
	t.Cleanup(ts.Close)
	return ts, c, s
}

func panelReq(t *testing.T, ts *httptest.Server, method, path string, body any) (int, []byte) {
	var r io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, ts.URL+path, r)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	req.Header.Set("X-Steward", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func TestStaleDismissKeepsReplacementQuestionPending(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "synthetic.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	base := time.Now().Add(-time.Minute)
	now := base
	st.Now = func() time.Time { return now }
	c := core.New(st, nil)
	const itemID = "DEMO-1"
	if err := c.CreateWorkItem(ctx, core.WorkItemInput{ID: itemID, Title: itemID}); err != nil {
		t.Fatal(err)
	}
	h := (&Server{Core: c, IngestToken: "ing", PanelToken: "pan"}).Handler()
	panel := func(method, path, body string) *httptest.ResponseRecorder {
		return ddo(h, drq{method: method, host: localHost, remote: loopPeer, path: path, body: body, cookie: cookieName, value: "pan"})
	}
	ask := func(id, question string, at time.Time) {
		t.Helper()
		body, err := json.Marshal(event.Event{EventID: id, SchemaVersion: event.SchemaVersion, OccurredAt: at,
			Kind: event.KindAsk, SessionID: "synthetic-session", Source: event.Source{Provider: "codex", HostID: "synthetic-host"}, Text: question})
		if err != nil {
			t.Fatal(err)
		}
		w := ddo(h, drq{method: "POST", host: localHost, remote: loopPeer, path: "/hook/event", body: string(body),
			headers: map[string]string{"Authorization": "Bearer ing"}})
		if w.Code != http.StatusOK {
			t.Fatalf("ask: status=%d body=%s", w.Code, w.Body.String())
		}
	}
	snapshot := func() core.Snapshot {
		t.Helper()
		w := panel("GET", "/api/snapshot", "")
		var snap core.Snapshot
		if err := json.Unmarshal(w.Body.Bytes(), &snap); err != nil || w.Code != http.StatusOK {
			t.Fatalf("snapshot: status=%d err=%v", w.Code, err)
		}
		return snap
	}
	question := func(snap core.Snapshot, wantPreview, wantStatus string) core.Approval {
		t.Helper()
		if len(snap.Approvals) != 1 {
			t.Fatalf("want one question, got %d", len(snap.Approvals))
		}
		a := snap.Approvals[0]
		if a.Status != wantStatus || a.Preview != wantPreview {
			t.Fatalf("question %q status=%s, want %q status=%s", a.Preview, a.Status, wantPreview, wantStatus)
		}
		return a
	}
	dismiss := func(cardID, questionID string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"reason":"ignored","question_id":%q}`, questionID)
		return panel("POST", "/api/approvals/"+cardID+"/dismiss", body)
	}
	notifier := core.Notifier{C: c, BaseURL: "http://" + localHost}
	if _, err := notifier.Pending(ctx); err != nil {
		t.Fatal(err)
	}
	now = base.Add(time.Second)
	ask("first-question", "封面用浅色吗", base)
	old := question(snapshot(), "封面用浅色吗", "pending")
	if old.SessionID == nil {
		t.Fatal("first question has no session")
	}
	if err := c.BindManual(ctx, *old.SessionID, itemID); err != nil {
		t.Fatal(err)
	}
	alerts, err := notifier.Pending(ctx)
	if err != nil || len(alerts) != 1 {
		t.Fatalf("first question alerts = %v, err=%v, want one notification", alerts, err)
	}
	oldLink := alerts[0].Link
	if err := notifier.Check(ctx); err != nil {
		t.Fatal(err)
	}
	now = base.Add(2 * time.Second)
	ask("second-question", "标题用哪一版", base)
	if w := dismiss(old.ID, old.ID); w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "已更新") {
		t.Errorf("stale dismiss: status=%d body=%s, want 409 with refresh message", w.Code, strings.TrimSpace(w.Body.String()))
	}
	if w := dismiss(old.ID, ""); w.Code != http.StatusConflict {
		t.Errorf("unversioned dismiss after replacement: status=%d, want 409", w.Code)
	}
	snap := snapshot()
	current := question(snap, "标题用哪一版", "pending")
	var item string
	if oldLink == notifier.BaseURL+"/#approval="+current.ID && current.SessionID != nil {
		for _, s := range snap.Sessions {
			if s.ID == *current.SessionID {
				item = s.WorkItemID
				break
			}
		}
	}
	if item != itemID {
		t.Errorf("old notification resolves to work item %q, want %s", item, itemID)
	}
	if alerts, err := notifier.Pending(ctx); err != nil || len(alerts) != 0 {
		t.Errorf("replacement alerts = %v, err=%v, want no duplicate notification", alerts, err)
	}
	var payload struct {
		QuestionID string `json:"question_id"`
	}
	if err := json.Unmarshal(current.Payload, &payload); err != nil || payload.QuestionID == "" || payload.QuestionID == old.ID {
		t.Fatalf("replacement question ID = %q, err=%v, want a new question ID", payload.QuestionID, err)
	}
	if w := dismiss(current.ID, payload.QuestionID); w.Code != http.StatusOK {
		t.Fatalf("current dismiss: status=%d body=%s", w.Code, w.Body.String())
	}
	if a := question(snapshot(), "标题用哪一版", "cancelled"); a.CloseReason != "ignored" {
		t.Fatalf("current dismiss close reason=%q, want ignored", a.CloseReason)
	}
}

func TestAuthSeparation(t *testing.T) {
	ts, _, _ := start(t)
	// 采集 token 不能访问面板
	req, _ := http.NewRequest("GET", ts.URL+"/api/snapshot", nil)
	req.Header.Set("Authorization", "Bearer ing")
	resp, _ := http.DefaultClient.Do(req)
	if resp.StatusCode != 401 {
		t.Fatalf("采集 token 访问面板应 401: %d", resp.StatusCode)
	}
	// 面板 cookie 不能写事件
	req, _ = http.NewRequest("POST", ts.URL+"/hook/event", strings.NewReader("{}"))
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 401 {
		t.Fatalf("面板凭据写事件应 401: %d", resp.StatusCode)
	}
	// 面板写操作缺少 X-Steward 头被拒绝（CSRF 防护）
	req, _ = http.NewRequest("POST", ts.URL+"/api/work-items", strings.NewReader(`{"id":"A-1","title":"x"}`))
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 403 {
		t.Fatalf("缺少 X-Steward 应 403: %d", resp.StatusCode)
	}
	// 非回环 Host 被拒绝（DNS rebinding）
	req, _ = http.NewRequest("GET", ts.URL+"/api/snapshot", nil)
	req.Host = "evil.example:80"
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	resp, _ = http.DefaultClient.Do(req)
	if resp.StatusCode != 403 {
		t.Fatalf("非回环 Host 应 403: %d", resp.StatusCode)
	}
}

// 端到端：适配器发起权限请求 → 面板批准 → 适配器输出 Claude 协议的决定 → 送达确认。
func TestHookPermissionRoundTrip(t *testing.T) {
	ts, c, _ := start(t)
	hc := &hook.Client{BaseURL: ts.URL, Token: "ing", HostID: "h", PermWait: 5 * time.Second, Env: func(string) string { return "" }}
	stdin := `{"session_id":"S1","cwd":"/r","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"}}`
	var out bytes.Buffer
	done := make(chan struct{})
	go func() {
		hc.Handle(context.Background(), "claude", "PermissionRequest", []byte(stdin), &out)
		close(done)
	}()
	var snap core.Snapshot
	var ap *core.Approval
	for i := 0; i < 200 && ap == nil; i++ {
		time.Sleep(10 * time.Millisecond)
		_, b := panelReq(t, ts, "GET", "/api/snapshot", nil)
		json.Unmarshal(b, &snap)
		for i := range snap.Approvals {
			if snap.Approvals[i].Status == "pending" && snap.Approvals[i].Handleable {
				ap = &snap.Approvals[i]
			}
		}
	}
	if ap == nil {
		t.Fatal("面板没有看到权限请求")
	}
	code, b := panelReq(t, ts, "POST", "/api/approvals/"+ap.ID+"/decide", map[string]string{"fingerprint": ap.Fingerprint, "behavior": "allow"})
	if code != 200 {
		t.Fatalf("decide: %d %s", code, b)
	}
	<-done
	var res struct {
		HookSpecificOutput struct {
			HookEventName string `json:"hookEventName"`
			Decision      struct {
				Behavior     string          `json:"behavior"`
				UpdatedInput json.RawMessage `json:"updatedInput"`
			} `json:"decision"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(out.Bytes(), &res); err != nil {
		t.Fatalf("stdout 不是合法 JSON: %q", out.String())
	}
	if res.HookSpecificOutput.Decision.Behavior != "allow" || !strings.Contains(string(res.HookSpecificOutput.Decision.UpdatedInput), "ls") {
		t.Fatalf("输出不符合协议: %s", out.String())
	}
	var st string
	c.St.R().QueryRow(`SELECT status FROM approvals WHERE id=?`, ap.ID).Scan(&st)
	if st != "delivered" {
		t.Fatalf("应为 delivered: %s", st)
	}
}

// 服务不在线时：适配器不输出任何内容（回到原生审批），普通事件进入暂存，恢复后补发。
func TestHookFallbackAndSpool(t *testing.T) {
	dir := t.TempDir()
	hc := &hook.Client{BaseURL: "http://127.0.0.1:1", Token: "ing", HostID: "h", PermWait: time.Second,
		Spool: &hook.Spool{Dir: dir, Max: 3}, Env: func(string) string { return "" }}
	var out bytes.Buffer
	hc.Handle(context.Background(), "claude", "PermissionRequest", []byte(`{"session_id":"S","hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{}}`), &out)
	if out.Len() != 0 {
		t.Fatalf("服务不在线时不应输出决定: %q", out.String())
	}
	for i := 0; i < 5; i++ {
		hc.Handle(context.Background(), "claude", "Stop", []byte(`{"session_id":"S","hook_event_name":"Stop"}`), &out)
	}
	if hc.Spool.Len() != 3 || hc.Spool.Dropped() != 2 {
		t.Fatalf("暂存应有界: len=%d dropped=%d", hc.Spool.Len(), hc.Spool.Dropped())
	}
	ts, c, _ := start(t)
	hc.BaseURL = ts.URL
	hc.Flush(context.Background())
	if hc.Spool.Len() != 0 {
		t.Fatal("补发后暂存应清空")
	}
	var n int
	c.St.R().QueryRow(`SELECT COUNT(1) FROM events`).Scan(&n)
	if n != 3 {
		t.Fatalf("应补发 3 条，实际 %d", n)
	}
	// 重复补发不重复计数
	hc.Flush(context.Background())
	c.St.R().QueryRow(`SELECT COUNT(1) FROM events`).Scan(&n)
	if n != 3 {
		t.Fatal("重复补发产生了重复事件")
	}
}

// handlerTransport exercises the HTTP handler without opening a listening socket.
type handlerTransport struct{ http.Handler }

func (h handlerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	defer r.Body.Close()
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Result(), nil
}

func TestHookSpoolRetriesFailedDatabaseWrite(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "spool.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	s := &Server{Core: core.New(st, nil), IngestToken: "ing"}
	ctx := context.Background()
	hc := &hook.Client{
		BaseURL: "http://127.0.0.1", Token: "ing", Spool: &hook.Spool{Dir: t.TempDir()},
		HTTP: &http.Client{Transport: handlerTransport{s.Handler()}},
	}
	e := event.Event{
		EventID: "synthetic-queued-event", SchemaVersion: event.SchemaVersion, OccurredAt: time.Now().UTC(),
		Source: event.Source{Provider: "codex", HostID: "synthetic"}, Kind: event.KindSessionStart, SessionID: "synthetic-session",
	}
	exec := func(query string) {
		t.Helper()
		if err := st.Tx(ctx, func(tx *sql.Tx) error {
			_, err := tx.Exec(query)
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}
	exec(`CREATE TRIGGER fail_event_insert BEFORE INSERT ON events
		BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`)
	hc.Spool.Append(&e)
	hc.Flush(ctx)
	if got := hc.Spool.Len(); got != 1 {
		t.Fatalf("database write failed: queued events = %d, want 1", got)
	}

	exec(`DROP TRIGGER fail_event_insert`)
	hc.Spool.Append(&e) // Replaying the same event ID must not store it twice.
	invalid := e
	invalid.EventID = "synthetic-invalid-event"
	invalid.SessionID = ""
	hc.Spool.Append(&invalid)
	hc.Flush(ctx)
	if got := hc.Spool.Len(); got != 0 {
		t.Fatalf("database recovered: queued events = %d, want 0", got)
	}
	var count int
	if err := st.R().QueryRow(`SELECT COUNT(*) FROM events WHERE event_id = ?`, e.EventID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("stored copies of queued event = %d, want 1", count)
	}
}

func TestAgentActionsAndStream(t *testing.T) {
	ts, _, _ := start(t)
	hc := &hook.Client{BaseURL: ts.URL, Token: "ing", HostID: "h", Env: func(string) string { return "" }}
	panelReq(t, ts, "POST", "/api/work-items", map[string]string{"id": "QM-5", "title": "t"})
	var out bytes.Buffer
	hc.Handle(context.Background(), "codex", "UserPromptSubmit", []byte(`{"session_id":"C1","cwd":"/r","hook_event_name":"UserPromptSubmit","prompt":"开始"}`), &out)

	// SSE：先连上，记录游标
	req, _ := http.NewRequest("GET", ts.URL+"/api/stream", nil)
	req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req = req.WithContext(ctx)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got := make(chan string, 10)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				got <- string(buf[:n])
			}
			if err != nil {
				return
			}
		}
	}()

	if err := hc.AgentAction(context.Background(), "claim", "QM-5", "", "", "/r"); err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := hc.AgentAction(context.Background(), "claim", "QM-404", "", "", "/r"); err == nil {
		t.Fatal("不存在的工作项应报错")
	}
	if err := hc.AgentAction(context.Background(), "ask", "用方案 A 还是 B？", "", "", "/r"); err != nil {
		t.Fatal(err)
	}
	if err := hc.AgentAction(context.Background(), "deliver", "完成，测试已通过", "", "", "/r"); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(2 * time.Second)
	sawChanges := false
	for !sawChanges {
		select {
		case s := <-got:
			sawChanges = strings.Contains(s, "event: changes")
		case <-deadline:
			t.Fatal("SSE 没有推送变更")
		}
	}
	_, b := panelReq(t, ts, "GET", "/api/snapshot", nil)
	var snap core.Snapshot
	json.Unmarshal(b, &snap)
	var item core.WorkItem
	for _, w := range snap.WorkItems {
		if w.ID == "QM-5" {
			item = w
		}
	}
	if item.Status != "review" || len(item.Agents) != 1 || item.Agents[0] != "codex" {
		t.Fatalf("工作项应进入待验收且显示 codex: %+v", item)
	}
	decisions := 0
	for _, a := range snap.Approvals {
		if a.Kind == "decision" && a.Status == "pending" {
			decisions++
		}
	}
	if decisions != 1 {
		t.Fatalf("应有 1 条决策: %d", decisions)
	}
}

func TestAttributionEndpointsRequirePanelAuthentication(t *testing.T) {
	ts, _, _ := start(t)
	for _, path := range []string{"/api/attributions/reconcile", "/api/attributions/decide"} {
		req, _ := http.NewRequest("POST", ts.URL+path, strings.NewReader(`{"decisions":[]}`))
		req.Header.Set("Authorization", "Bearer ing")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatalf("%s: %d", path, resp.StatusCode)
		}
	}
	if code, body := panelReq(t, ts, "POST", "/api/attributions/reconcile", map[string]any{}); code != 200 {
		t.Fatalf("%d %s", code, body)
	}
	if code, _ := panelReq(t, ts, "POST", "/api/attributions/decide", map[string]any{"decisions": []any{}}); code != 400 {
		t.Fatalf("empty batch: %d", code)
	}
}

func TestReportAndBriefEdit(t *testing.T) {
	ts, _, _ := start(t)
	hc := &hook.Client{BaseURL: ts.URL, Token: "ing", HostID: "h", Env: func(string) string { return "" }}
	ctx := context.Background()
	panelReq(t, ts, "POST", "/api/work-items", map[string]string{"id": "QM-7", "title": "t"})
	var out bytes.Buffer
	hc.Handle(ctx, "codex", "UserPromptSubmit", []byte(`{"session_id":"C7","cwd":"/r","hook_event_name":"UserPromptSubmit","prompt":"开始"}`), &out)

	// 未关联工作项时明确拒绝
	if err := hc.Report(ctx, map[string]string{"progress": "p"}, "codex", "C7", "/r"); err == nil || !strings.Contains(err.Error(), "claim") {
		t.Fatalf("未关联时应拒绝并提示 claim，得到 %v", err)
	}
	if err := hc.Report(ctx, nil, "codex", "C7", "/r"); err == nil {
		t.Fatal("空回报应报错")
	}
	if err := hc.AgentAction(ctx, event.KindClaim, "QM-7", "codex", "C7", "/r"); err != nil {
		t.Fatal(err)
	}
	if err := hc.Report(ctx, map[string]string{"progress": "已修复重连循环", "next": "断网验收"}, "codex", "C7", "/r"); err != nil {
		t.Fatal(err)
	}
	brief := func() map[string]map[string]any {
		_, b := panelReq(t, ts, "GET", "/api/snapshot", nil)
		var snap struct {
			WorkItems []struct {
				ID    string `json:"id"`
				Brief *struct {
					Fields map[string]map[string]any `json:"fields"`
				} `json:"brief"`
			} `json:"work_items"`
		}
		json.Unmarshal(b, &snap)
		for _, w := range snap.WorkItems {
			if w.ID == "QM-7" && w.Brief != nil {
				return w.Brief.Fields
			}
		}
		return nil
	}
	f := brief()
	if f["progress"]["text"] != "已修复重连循环" || f["progress"]["kind"] != "agent" {
		t.Fatalf("快照简报 = %v", f)
	}
	code, b := panelReq(t, ts, "POST", "/api/work-items/QM-7/brief", map[string]any{"field": "goal", "action": "set", "text": "断网后保留行情"})
	if code != 200 || !strings.Contains(string(b), "entry_id") {
		t.Fatalf("%d %s", code, b)
	}
	if brief()["goal"]["kind"] != "user" {
		t.Fatal("面板编辑应为 user")
	}
	if code, _ := panelReq(t, ts, "POST", "/api/work-items/QM-7/brief", map[string]any{"field": "nope", "action": "set"}); code != 400 {
		t.Fatalf("未知字段应 400，得到 %d", code)
	}
	if code, b := panelReq(t, ts, "GET", "/api/work-items/QM-7/brief/history", nil); code != 200 || !strings.Contains(string(b), "断网后保留行情") {
		t.Fatalf("%d %s", code, b)
	}
	// 采集 token 不能调用面板接口
	req, _ := http.NewRequest("POST", ts.URL+"/api/work-items/QM-7/brief", strings.NewReader(`{"field":"goal","action":"set","text":"x"}`))
	req.Header.Set("Authorization", "Bearer ing")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == 200 {
		t.Fatal("采集 token 不应能编辑简报")
	}
}

func TestBeginAndSessionGuidanceFlow(t *testing.T) {
	ts, c, s := start(t)
	s.ReportingHints = true
	client := &hook.Client{BaseURL: ts.URL, Token: "ing", HostID: "h"}
	var output bytes.Buffer
	client.Handle(context.Background(), "claude", "SessionStart", []byte(`{"session_id":"brief-flow","cwd":"/r"}`), &output)
	if !strings.Contains(output.String(), "additionalContext") || !strings.Contains(output.String(), "brief-flow") {
		t.Fatalf("SessionStart 未收到回报说明: %s", output.String())
	}
	item, err := client.Begin(context.Background(), "创建简报工作流", "", map[string]string{"goal": "不逐个手工建任务", "progress": "首份回报"}, "claude", "brief-flow", "/r")
	if err != nil || item == "" {
		t.Fatalf("begin: %s %v", item, err)
	}
	if err = client.Report(context.Background(), map[string]string{"progress": "阶段更新", "next": "真实使用验收"}, "claude", "brief-flow", "/r"); err != nil {
		t.Fatal(err)
	}
	snap, err := c.Snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.WorkItems) != 1 || snap.WorkItems[0].Brief.Fields["progress"].Text != "阶段更新" {
		t.Fatalf("没有正确更新简报: %+v", snap.WorkItems)
	}
	output.Reset()
	client.Handle(context.Background(), "claude", "SessionStart", []byte(`{"session_id":"brief-flow","cwd":"/r","source":"resume"}`), &output)
	if !strings.Contains(output.String(), " report ") {
		t.Fatal("已有归属的会话未收到 report 指令")
	}
}

func TestEndedSessionCanResumeReportingWithoutDuplicateItem(t *testing.T) {
	ts, c, s := start(t)
	s.ReportingHints = true
	client := &hook.Client{BaseURL: ts.URL, Token: "ing", HostID: "h"}
	raw := []byte(`{"session_id":"resume-report","cwd":"/r"}`)
	var out bytes.Buffer
	client.Handle(context.Background(), "claude", "SessionStart", raw, &out)
	item, err := client.Begin(context.Background(), "Original task", "", nil, "claude", "resume-report", "/r")
	if err != nil {
		t.Fatal(err)
	}
	client.Handle(context.Background(), "claude", "SessionEnd", raw, &out)
	out.Reset()
	client.Handle(context.Background(), "claude", "SessionStart", raw, &out)
	if !strings.Contains(out.String(), "claim '"+item+"'") {
		t.Fatalf("missing precise continuation: %s", out.String())
	}
	snap, _ := c.Snapshot(context.Background())
	if snap.Sessions[0].WorkItemID != "" {
		t.Fatal("hint must not silently bind")
	}
	if err := client.AgentAction(context.Background(), event.KindClaim, item, "claude", "resume-report", "/r"); err != nil {
		t.Fatal(err)
	}
	if err := client.Report(context.Background(), map[string]string{"progress": "new resumed progress"}, "claude", "resume-report", "/r"); err != nil {
		t.Fatal(err)
	}
	snap, _ = c.Snapshot(context.Background())
	if len(snap.WorkItems) != 1 || len(snap.Runs) != 2 || snap.WorkItems[0].Brief.Fields["progress"].Text != "new resumed progress" {
		t.Fatalf("incorrect resume: %+v", snap)
	}
	if err := c.Unbind(context.Background(), snap.Sessions[0].ID, "", testUnbindTarget(t, c, snap.Sessions[0].ID)); err != nil {
		t.Fatal(err)
	}
	previous, err := c.ReportingPreviousItem(context.Background(), "h", "claude", "resume-report")
	if err != nil || previous != "" {
		t.Fatalf("manual unbind must not be revived: %s %v", previous, err)
	}
}

func TestLateSessionEndPreservesResumedRun(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "s.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := core.New(st, loc{})
	for _, id := range []string{"RUN-1", "RUN-2"} {
		if err := c.CreateWorkItem(ctx, core.WorkItemInput{ID: id, Title: id}); err != nil {
			t.Fatal(err)
		}
	}

	at := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	source := event.Source{Provider: "claude", HostID: "h"}
	for _, e := range []event.Event{
		{EventID: "start", Kind: event.KindSessionStart, OccurredAt: at.Add(-5 * time.Minute)},
		{EventID: "claim-first", Kind: event.KindClaim, WorkTag: "RUN-1", OccurredAt: at.Add(-4 * time.Minute)},
		{EventID: "resume", Kind: event.KindSessionStart, OccurredAt: at.Add(5 * time.Minute)},
		{EventID: "claim-second", Kind: event.KindClaim, WorkTag: "RUN-2", OccurredAt: at.Add(5 * time.Minute)},
		{EventID: "late-end", Kind: event.KindSessionEnd, OccurredAt: at},
	} {
		e.SchemaVersion, e.Source, e.SessionID = 1, source, "resume-report"
		if _, err := c.Ingest(ctx, &e); err != nil {
			t.Fatalf("%s: %v", e.EventID, err)
		}
	}

	report := event.Event{EventID: "report", SchemaVersion: 1, Source: source, SessionID: "resume-report",
		Kind: event.KindReport, OccurredAt: at.Add(7 * time.Minute), Brief: map[string]string{"progress": "新一轮进展"}}
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/hook/agent-action", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer ing")
	w := httptest.NewRecorder()
	(&Server{Core: c, IngestToken: "ing"}).Handler().ServeHTTP(w, req)
	var result struct{ Acked []string }
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != http.StatusOK || len(result.Acked) != 1 || result.Acked[0] != report.EventID {
		t.Fatalf("10:07 的进展回报应被接收，实际 HTTP %d %s", w.Code, w.Body.String())
	}
	var item string
	if err := st.R().QueryRow(`SELECT work_item_id FROM brief_entries WHERE source='report' AND field='progress'`).Scan(&item); err != nil || item != "RUN-2" {
		t.Fatalf("进展应写入 RUN-2，实际 %q (%v)", item, err)
	}
}

func TestRunOutcomeOnlyFillsEndedRunsOnce(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(filepath.Join(t.TempDir(), "s.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	c := core.New(st, loc{})
	h := (&Server{Core: c, PanelToken: "pan"}).Handler()
	if err := c.CreateWorkItem(ctx, core.WorkItemInput{ID: "RUN-1", Title: "synthetic"}); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)
	for _, e := range []event.Event{
		{EventID: "prompt-ended", SessionID: "ended", Kind: event.KindPrompt, WorkTag: "RUN-1", OccurredAt: at},
		{EventID: "session-end", SessionID: "ended", Kind: event.KindSessionEnd, OccurredAt: at.Add(time.Minute)},
		{EventID: "prompt-active", SessionID: "active", Kind: event.KindPrompt, WorkTag: "RUN-1", OccurredAt: at.Add(2 * time.Minute)},
	} {
		e.SchemaVersion, e.Source = 1, event.Source{Provider: "claude", HostID: "synthetic"}
		if _, err := c.Ingest(ctx, &e); err != nil {
			t.Fatal(err)
		}
	}
	readRun := func(session string) (run core.Run) {
		t.Helper()
		err := st.R().QueryRow(`SELECT r.id,r.ended_at,r.outcome FROM runs r JOIN sessions s ON s.id=r.session_id WHERE s.provider_session_id=?`, session).
			Scan(&run.ID, &run.EndedAt, &run.Outcome)
		if err != nil {
			t.Fatal(err)
		}
		return run
	}
	postOutcome := func(id int64, outcome string) *httptest.ResponseRecorder {
		url := fmt.Sprintf("http://127.0.0.1/api/runs/%d/outcome", id)
		req := httptest.NewRequest(http.MethodPost, url, strings.NewReader(fmt.Sprintf(`{"outcome":%q}`, outcome)))
		req.AddCookie(&http.Cookie{Name: cookieName, Value: "pan"})
		req.Header.Set("X-Steward", "1")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	ended, active := readRun("ended"), readRun("active")
	if ended.EndedAt == "" || ended.Outcome != "" || active.EndedAt != "" || active.Outcome != "" {
		t.Fatalf("expected an ended run without an outcome and a running run: ended=%+v active=%+v", ended, active)
	}
	if w := postOutcome(ended.ID, "failed"); w.Code != http.StatusOK {
		t.Fatalf("first outcome: got HTTP %d, want 200: %s", w.Code, w.Body.String())
	}
	if w := postOutcome(ended.ID, "delivered"); w.Code != http.StatusConflict {
		t.Errorf("second outcome: got HTTP %d, want 409: %s", w.Code, w.Body.String())
	}
	if got := readRun("ended"); got.Outcome != "failed" || got.EndedAt != ended.EndedAt {
		t.Errorf("after second outcome: got outcome=%q ended_at=%q, want outcome=failed ended_at=%q", got.Outcome, got.EndedAt, ended.EndedAt)
	}
	if w := postOutcome(active.ID, "failed"); w.Code != http.StatusConflict {
		t.Errorf("outcome for a running run: got HTTP %d, want 409: %s", w.Code, w.Body.String())
	}
	if got := readRun("active"); got.EndedAt != "" || got.Outcome != "" {
		t.Errorf("running run changed: ended_at=%q outcome=%q", got.EndedAt, got.Outcome)
	}
}

func TestExistingSessionGetsOnePromptHint(t *testing.T) {
	ts, _, s := start(t)
	client := &hook.Client{BaseURL: ts.URL, Token: "ing", HostID: "h"}
	var out bytes.Buffer
	raw := []byte(`{"session_id":"already-open","cwd":"/r"}`)
	client.Handle(context.Background(), "codex", "SessionStart", raw, &out)
	if out.Len() != 0 {
		t.Fatal("关闭时不应提醒")
	}
	s.ReportingHints = true
	client.Handle(context.Background(), "codex", "UserPromptSubmit", raw, &out)
	if !strings.Contains(out.String(), "UserPromptSubmit") {
		t.Fatal("已有会话首次输入未收到说明")
	}
	out.Reset()
	client.Handle(context.Background(), "codex", "UserPromptSubmit", raw, &out)
	if out.Len() != 0 {
		t.Fatal("不应每次输入都重复提醒")
	}
	client.Handle(context.Background(), "codex", "SessionStart", raw, &out)
	if !strings.Contains(out.String(), "SessionStart") {
		t.Fatal("恢复时应重新提供上下文")
	}
}
