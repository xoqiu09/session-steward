package server

import (
	"bytes"
	"context"
	"encoding/json"
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
	if err := c.Unbind(context.Background(), snap.Sessions[0].ID, ""); err != nil {
		t.Fatal(err)
	}
	previous, err := c.ReportingPreviousItem(context.Background(), "h", "claude", "resume-report")
	if err != nil || previous != "" {
		t.Fatalf("manual unbind must not be revived: %s %v", previous, err)
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
