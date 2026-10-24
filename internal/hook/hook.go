// Package hook 实现 steward-hook 适配器：读取 Agent hook 的 stdin，转换成统一事件发给 Steward。
//
// 约定：
//   - 任何失败都不能影响 Agent：退出码始终为 0；除启用的 SessionStart / 首次 UserPromptSubmit 回报说明外，普通事件不向 stdout 输出。
//   - 权限请求：只有拿到面板的明确决定时才输出决定；否则什么都不输出，Agent 继续原生审批流程。
package hook

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/event"
)

type Client struct {
	BaseURL     string
	Token       string
	HostID      string
	KeepSummary bool
	Spool       *Spool
	HTTP        *http.Client
	PermWait    time.Duration
	Env         func(string) string
}

func NewID() string {
	b := make([]byte, 16)
	rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// Handle 处理一次 hook 调用。provider 为 claude/codex/other；argEvent 是命令行给出的事件名（stdin 缺失时使用）。
func (c *Client) Handle(ctx context.Context, provider, argEvent string, stdin []byte, stdout io.Writer) {
	if c.Env == nil {
		c.Env = os.Getenv
	}
	raw := stdin
	if argEvent != "" {
		raw = injectEventName(stdin, argEvent)
	}
	e, in, err := event.Normalize(raw, event.Options{
		Provider: provider, HostID: c.HostID, KeepSummary: c.KeepSummary, NewID: NewID, Env: c.Env,
	})
	if err != nil || e.SessionID == "" {
		return
	}
	if e.Kind == event.KindPermission {
		c.permission(ctx, provider, e, in, stdout)
		return
	}
	response := c.send(ctx, e)
	if (e.Kind == event.KindSessionStart || e.Kind == event.KindPrompt) && response != nil && response.ReportingHints {
		command, _ := os.Executable()
		stdout.Write(SessionGuidance(e, response.WorkItemID, command, response.PreviousWorkItemID))
	}
}

// injectEventName 在 stdin JSON 缺少 hook_event_name 时补上。
func injectEventName(stdin []byte, name string) []byte {
	var m map[string]json.RawMessage
	if json.Unmarshal(stdin, &m) != nil {
		return stdin
	}
	if _, ok := m["hook_event_name"]; ok {
		return stdin
	}
	m["hook_event_name"], _ = json.Marshal(name)
	b, _ := json.Marshal(m)
	return b
}

type responseError struct {
	status int
	detail string
}

func (e *responseError) Error() string {
	if e.detail != "" {
		return fmt.Sprintf("status %d: %s", e.status, e.detail)
	}
	return fmt.Sprintf("status %d", e.status)
}

// A rejected action is different from an unavailable service: callers may still report.
func actionError(err error) error {
	var response *responseError
	if errors.As(err, &response) {
		return fmt.Errorf("Steward 请求未接受：%w", err)
	}
	return fmt.Errorf("Steward 服务不可用：%w", err)
}

func (c *Client) post(ctx context.Context, path string, body any, timeout time.Duration, out any) error {
	b, _ := json.Marshal(body)
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	hc := c.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		var detail struct {
			Error string `json:"error"`
		}
		if json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&detail) == nil && detail.Error != "" {
			return &responseError{status: resp.StatusCode, detail: detail.Error}
		}
		return &responseError{status: resp.StatusCode}
	}
	if out != nil {
		return json.NewDecoder(resp.Body).Decode(out)
	}
	io.Copy(io.Discard, resp.Body)
	return nil
}

type ackResp struct {
	ReportingHints     bool                `json:"reporting_hints"`
	WorkItemID         string              `json:"work_item_id"`
	PreviousWorkItemID string              `json:"previous_work_item_id"`
	Acked              []string            `json:"acked"`
	Rejected           []map[string]string `json:"rejected"` // 永久性拒绝（格式错误），不再重试
}

// confirmActionACK only confirms ingestion of this event, never execution or acceptance.
func confirmActionACK(eventID string, r ackResp) error {
	if len(r.Rejected) > 0 {
		return fmt.Errorf("%s", r.Rejected[0]["error"])
	}
	for _, id := range r.Acked {
		if id == eventID {
			return nil
		}
	}
	return fmt.Errorf("Steward 未确认本次事件 %s：响应 ACK 未包含该事件", eventID)
}

// send 发送普通事件；失败时写入暂存。成功后顺带补发暂存中的事件。
func (c *Client) send(ctx context.Context, e *event.Event) *ackResp {
	var r ackResp
	if err := c.post(ctx, "/hook/event", e, 1500*time.Millisecond, &r); err != nil {
		if c.Spool != nil {
			c.Spool.Append(e)
		}
		return nil
	}
	c.Flush(ctx)
	return &r
}

// Flush 把暂存事件批量补发；只删除服务确认的事件。
func (c *Client) Flush(ctx context.Context) {
	if c.Spool == nil {
		return
	}
	c.Spool.Drain(func(batch []event.Event) map[string]bool {
		var r ackResp
		if err := c.post(ctx, "/hook/event", batch, 3*time.Second, &r); err != nil {
			return nil
		}
		ok := map[string]bool{}
		for _, id := range r.Acked {
			ok[id] = true
		}
		for _, rj := range r.Rejected {
			ok[rj["event_id"]] = true
		}
		return ok
	})
}

type permResp struct {
	ApprovalID string `json:"approval_id"`
	Decision   *struct {
		Behavior string `json:"behavior"`
		Message  string `json:"message"`
	} `json:"decision"`
}

func (c *Client) permission(ctx context.Context, provider string, e *event.Event, in *event.HookInput, stdout io.Writer) {
	wait := c.PermWait
	if wait <= 0 {
		wait = 10 * time.Minute
	}
	var r permResp
	path := fmt.Sprintf("/hook/permission?wait=%d", int(wait.Seconds()))
	// HTTP 超时比服务端等待略长，留出返回时间
	if err := c.post(ctx, path, e, wait+5*time.Second, &r); err != nil || r.Decision == nil {
		return // 不作决定，回到原生审批
	}
	out := DecisionOutput(provider, r.Decision.Behavior, r.Decision.Message, in.ToolInput)
	if out == nil {
		return
	}
	if _, err := stdout.Write(out); err != nil {
		return
	}
	if f, ok := stdout.(*os.File); ok {
		f.Sync()
	}
	// 送达确认：决定已写回 Agent
	c.post(ctx, "/hook/permission/"+r.ApprovalID+"/delivered", map[string]string{}, 1500*time.Millisecond, nil)
}

// DecisionOutput 按各 Agent 的 PermissionRequest 协议生成 stdout。
func DecisionOutput(provider, behavior, message string, toolInput json.RawMessage) []byte {
	var dec map[string]any
	switch behavior {
	case "allow":
		dec = map[string]any{"behavior": "allow"}
		// Claude 的 allow 需要带回 updatedInput，否则会忽略决定
		if provider == "claude" {
			var ti any = map[string]any{}
			if len(toolInput) > 0 {
				json.Unmarshal(toolInput, &ti)
			}
			dec["updatedInput"] = ti
		}
	case "deny":
		if message == "" {
			message = "已在 Session Steward 面板拒绝"
		}
		dec = map[string]any{"behavior": "deny", "message": message}
	default:
		return nil
	}
	out := map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": "PermissionRequest", "decision": dec}}
	if provider == "codex" {
		out["continue"] = true
	}
	b, _ := json.Marshal(out)
	return append(b, '\n')
}

// AgentAction 处理 Agent 主动调用的 claim/ask/deliver。会话由环境变量或 cwd 解析。
func (c *Client) AgentAction(ctx context.Context, kind event.Kind, arg, provider, sessionID, cwd string) error {
	return c.AgentActionBrief(ctx, kind, arg, nil, provider, sessionID, cwd)
}

// AgentActionBrief supports structured delivery without treating CLI options as prose.
func (c *Client) AgentActionBrief(ctx context.Context, kind event.Kind, arg string, fields map[string]string, provider, sessionID, cwd string) error {
	e := &event.Event{
		EventID: NewID(), SchemaVersion: event.SchemaVersion, OccurredAt: time.Now().UTC(),
		Source: event.Source{Provider: provider, HostID: c.HostID, Client: "unknown"},
		Kind:   kind, RawName: "steward-hook " + string(kind), SessionID: sessionID, Cwd: cwd,
	}
	switch kind {
	case event.KindReport:
		return fmt.Errorf("report 请使用 Report")
	case event.KindClaim:
		e.WorkTag = event.ExtractWorkTag("#" + arg)
		if e.WorkTag == "" {
			return fmt.Errorf("工作项编号格式应为 ABC-123")
		}
	default:
		e.Text = event.Redact(event.Truncate(arg, 500))
	}
	if len(fields) > 0 {
		e.Brief = map[string]string{}
		for k, v := range fields {
			e.Brief[k] = event.Redact(event.Truncate(v, 280))
		}
	}
	var r ackResp
	if err := c.post(ctx, "/hook/agent-action", e, 3*time.Second, &r); err != nil {
		return actionError(err)
	}
	return confirmActionACK(e.EventID, r)
}

// Report 提交工作简报。fields 的键为 goal/progress/blocker/next；空值表示清除该字段。
func (c *Client) Report(ctx context.Context, fields map[string]string, provider, sessionID, cwd string) error {
	if len(fields) == 0 {
		return fmt.Errorf("至少提供一个字段：--goal --summary --progress --blocker --next --stage --next-owner")
	}
	b := map[string]string{}
	for k, v := range fields {
		b[k] = event.Redact(event.Truncate(v, 280))
	}
	e := &event.Event{
		EventID: NewID(), SchemaVersion: event.SchemaVersion, OccurredAt: time.Now().UTC(),
		Source: event.Source{Provider: provider, HostID: c.HostID, Client: "unknown"},
		Kind:   event.KindReport, RawName: "steward-hook report", SessionID: sessionID, Cwd: cwd, Brief: b,
	}
	var r ackResp
	if err := c.post(ctx, "/hook/agent-action", e, 3*time.Second, &r); err != nil {
		return actionError(err)
	}
	return confirmActionACK(e.EventID, r)
}

// Begin 创建或复用明确的工作项并绑定当前会话，不覆盖已有的不同任务归属。
func (c *Client) Features(ctx context.Context, b *event.FeatureBatch, provider, sessionID, cwd string) error {
	if err := b.Validate(); err != nil {
		return err
	}
	e := &event.Event{EventID: NewID(), SchemaVersion: event.SchemaVersion, OccurredAt: time.Now().UTC(), Source: event.Source{Provider: provider, HostID: c.HostID, Client: "unknown"}, Kind: event.KindFeatures, RawName: "steward-hook features", SessionID: sessionID, Cwd: cwd, Features: b}
	var r ackResp
	if err := c.post(ctx, "/hook/agent-action", e, 3*time.Second, &r); err != nil {
		return actionError(err)
	}
	return confirmActionACK(e.EventID, r)
}
func (c *Client) ListFeatures(ctx context.Context, provider, sessionID, cwd string) (json.RawMessage, error) {
	var out json.RawMessage
	err := c.post(ctx, "/hook/features/list", map[string]string{"provider": provider, "session": sessionID, "host": c.HostID, "cwd": cwd}, 3*time.Second, &out)
	if err != nil {
		return nil, actionError(err)
	}
	return out, nil
}

func (c *Client) Begin(ctx context.Context, title, project string, fields map[string]string, provider, sessionID, cwd string) (string, error) {
	b := map[string]string{}
	for k, v := range fields {
		b[k] = event.Redact(event.Truncate(v, 280))
	}
	e := &event.Event{EventID: NewID(), SchemaVersion: event.SchemaVersion, OccurredAt: time.Now().UTC(), Source: event.Source{Provider: provider, HostID: c.HostID, Client: "unknown"}, Kind: event.KindBegin, RawName: "steward-hook begin", SessionID: sessionID, Cwd: cwd, WorkTitle: event.Redact(title), ProjectPath: project, Brief: b}
	var r ackResp
	if err := c.post(ctx, "/hook/agent-action", e, 3*time.Second, &r); err != nil {
		return "", actionError(err)
	}
	if err := confirmActionACK(e.EventID, r); err != nil {
		return "", err
	}
	return r.WorkItemID, nil
}

// SessionGuidance 只返回当前会话的命令，不携带其他会话内容，也不阻止用户工作。
func SessionGuidance(e *event.Event, item, command string, previous ...string) []byte {
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
	base := quote(command)
	identity := " --provider " + quote(e.Source.Provider) + " --session " + quote(e.SessionID)
	action := base + " begin --title \"这次实际任务的简短标题\" --project \"实际项目绝对路径\" --stage \"unknown\" --summary \"一句话结论\" --next-owner \"agent\" --goal \"目标\" --progress \"当前进展\"" + identity
	if item != "" {
		action = base + " report --stage \"unknown\" --summary \"一句话结论\" --next-owner \"agent\" --progress \"当前进展\" --blocker \"卡点或空字符串\" --next \"下一步\"" + identity
	} else if len(previous) > 0 && previous[0] != "" {
		action = "本会话上次关联 " + previous[0] + "，执行记录随会话结束而关闭。若本次仍继续同一任务，允许直接运行 " + base + " claim " + quote(previous[0]) + identity + " 恢复原归属，再 report；无需用户另行登记或再次确认。若用户已切换到新任务，使用 begin 创建或复用新任务，不恢复旧归属"
	}
	text := "Session Steward 本地工作简报（可选，不扩大用户任务范围）：仅在用户允许工具调用且正在做实际项目工作时，在明确目标后登记一次，并在实质进展、阻塞或交付时更新简报。命令：" + action + "。后续使用 " + base + " report --stage \"unknown\" --summary \"一句话结论\" --next-owner \"agent\" --progress \"…\" --blocker \"…\" --next \"…\"" + identity + "。begin 会创建或复用同项目任务并关联；若提示已经关联，尊重原归属，继续当前工作直接用 report，不重复 begin 或擅自 claim。简报给项目Owner阅读，每字段一两句普通中文，不只列命令、缩写、函数名或文件名。目标说明本轮解决什么问题；进展说明真正做完/确认了什么、哪些验证还没有过；卡点解释失败意味着什么、是否需要人决定，无则空字符串；下一步说明由谁做什么以及完成判断。阶段按事实选 planning/implementing/validating/unknown，分别是准备/实施/验证/未知；不要按时间或工具次数估百分比。next-owner 按事实选 agent（执行Agent自己）/claude/codex（明确交接给另一个Agent）/user（用户）/external（外部依赖）/unknown。summary 用一句普通中文说明做到哪，尽量60字内。交付时调用 deliver 自动进入待验收和用户接手，已验收只能由用户确认。区分 Agent 自述、测试和用户验收，不复制对话正文或密钥。服务不可用时忽略，不重试、不阻塞主任务；用户禁止的工具或额外操作仍然禁止。"
	name := "SessionStart"
	text += " 核心功能进度：先用 " + base + " features --list" + identity + " 查看本项目已有功能ID。按已授权目标/规格登记或复用少量稳定功能，不按会话或工具数估进度。实质变化时用 " + base + " features --file \"功能回报JSON文件\"" + identity + " 更新变化项。JSON形状：{\"scope_status\":\"documented\",\"scope_basis\":\"已有规格的路径/章节；有歧义用proposed\",\"features\":[{\"id\":\"stable-feature-id\",\"title\":\"功能名\",\"candidate\":\"当前仓库提交/候选版本\",\"implementation\":\"implementing\",\"validation\":\"not_verified\",\"evidence\":\"已做验证的范围与证据\",\"blocker\":\"\",\"next\":\"下一步\",\"next_owner\":\"agent\"}]}。implementation取unknown/not_started/implementing/implemented；validation取unknown/not_verified/validating/passed/failed。已实现及验证结果要有candidate，通过要有evidence。仅验证角色可以省略implementation，不代替其他会话改状态。同一ID跨会话只计一次，候选不同或回报冲突照实保留。全部是Agent自述，用户验收只能由用户确认。没有变化无需刷报，也无需为补进度重跑测试。"
	if e.Kind == event.KindPrompt {
		name = "UserPromptSubmit"
	}
	out := map[string]any{"hookSpecificOutput": map[string]any{"hookEventName": name, "additionalContext": text}}
	b, _ := json.Marshal(out)
	return append(b, '\n')
}
