// steward-hook 是 Agent hooks 调用的轻量适配器。
//
//	steward-hook <claude|codex|other> <HookEvent> [--mark=...]   由 hooks 调用，读取 stdin
//	steward-hook claim QM-014    [--session ID] [--provider P]   Agent 声明当前工作项
//	steward-hook ask "问题"       [--session ID] [--provider P]   Agent 提交需要人决定的问题
//	steward-hook deliver "说明"   [--session ID] [--provider P]   Agent 提交交付，工作项进入待验收
//	steward-hook report [--goal T] [--progress T] [--blocker T] [--next T] [--session ID] [--provider P]
//	                                                             Agent 回报工作简报；空字符串清除该字段
//	steward-hook flush                                           补发暂存事件
//
// hooks 模式下无论发生什么都以退出码 0 结束，不阻塞 Agent。
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/config"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/hook"
)

var BuildCommit = "dev"

func main() {
	defer func() { recover() }() // 任何异常都不能影响 Agent
	if code := run(os.Args[1:], os.Stdin, os.Stdout); code != 0 {
		os.Exit(code)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "用法见源码注释")
		return 0
	}
	if args[0] == "version" {
		fmt.Fprintln(stdout, BuildCommit)
		return 0
	}
	cfg, err := config.Load()
	if err != nil {
		// 配置有误（例如 listen 不是回环地址）时不能带着 token 发请求，也不能阻塞 Agent：直接以 0 退出。
		// hooks 模式保持静默；手动执行的子命令在 stderr 提示原因。
		switch args[0] {
		case "claude", "codex", "other":
			io.Copy(io.Discard, stdin)
		default:
			fmt.Fprintln(os.Stderr, "Steward 配置有误，已跳过：", err)
		}
		return 0
	}
	client := &hook.Client{
		BaseURL:     "http://" + cfg.Listen,
		Token:       config.ReadSecret("ingest.token"),
		HostID:      config.HostID(),
		KeepSummary: cfg.KeepSummary,
		Spool:       &hook.Spool{Dir: config.Path("spool"), Max: cfg.SpoolMax},
		PermWait:    time.Duration(cfg.PermissionWaitSec) * time.Second,
	}
	ctx := context.Background()
	switch args[0] {
	case "claude", "codex", "other":
		if len(args) < 2 || client.Token == "" {
			io.Copy(io.Discard, stdin)
			return 0
		}
		in, _ := io.ReadAll(io.LimitReader(stdin, 8<<20))
		client.Handle(ctx, args[0], args[1], in, stdout)
	case "flush":
		client.Flush(ctx)
		fmt.Fprintf(stdout, "暂存剩余 %d 条，累计丢弃 %d 条\n", client.Spool.Len(), client.Spool.Dropped())
	case "claim", "ask", "deliver":
		return agentAction(ctx, client, args)
	case "report", "begin":
		return report(ctx, client, args, cfg.ReportingHints)
	case "features":
		return features(ctx, client, args)
	default:
		fmt.Fprintln(os.Stderr, "未知命令:", args[0])
	}
	return 0
}

func features(ctx context.Context, c *hook.Client, args []string) int {
	path, provider, session := "", "", ""
	list := false
	for i := 1; i < len(args); i++ {
		if args[i] == "--list" {
			list = true
			continue
		}
		if i+1 >= len(args) {
			fmt.Fprintln(os.Stderr, "参数缺少取值")
			return 2
		}
		v := args[i+1]
		switch args[i] {
		case "--file":
			path = v
		case "--provider":
			provider = v
		case "--session":
			session = v
		default:
			fmt.Fprintln(os.Stderr, "未知功能参数", args[i])
			return 2
		}
		i++
	}
	session, provider = defaultSession(session, provider)
	cwd, _ := os.Getwd()
	if list {
		out, err := c.ListFeatures(ctx, provider, session, cwd)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
		fmt.Println(string(out))
		return 0
	}
	var input io.Reader = os.Stdin
	if path != "-" {
		if path == "" {
			fmt.Fprintln(os.Stderr, "用法: features --file 文件.json 或 --list [--provider P --session ID]")
			return 2
		}
		f, err := os.Open(path)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		defer f.Close()
		input = f
	}
	dec := json.NewDecoder(io.LimitReader(input, 128<<10))
	dec.DisallowUnknownFields()
	var batch event.FeatureBatch
	if err := dec.Decode(&batch); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if err := batch.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	if err := c.Features(ctx, &batch, provider, session, cwd); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("已回报 %d 项核心功能（Agent自述；不自动验收）\n", len(batch.Features))
	return 0
}

func agentAction(ctx context.Context, c *hook.Client, args []string) int {
	kind := map[string]event.Kind{"claim": event.KindClaim, "ask": event.KindAsk, "deliver": event.KindDeliver}[args[0]]
	var text []string
	fields := map[string]string{}
	sessionID, provider := "", ""
	literal := false
	for i := 1; i < len(args); i++ {
		if !literal && args[i] == "--" {
			literal = true
			continue
		}
		if literal || !strings.HasPrefix(args[i], "--") {
			text = append(text, args[i])
			continue
		}
		name, value, eq := strings.Cut(args[i], "=")
		if !eq {
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				fmt.Fprintln(os.Stderr, "参数缺少取值:", name)
				return 2
			}
			value = args[i+1]
			i++
		}
		switch name {
		case "--session":
			sessionID = value
		case "--provider":
			provider = value
		case "--goal", "--summary", "--progress", "--blocker", "--next", "--stage", "--next-owner":
			if kind != event.KindDeliver {
				fmt.Fprintln(os.Stderr, "简报字段请使用 report 或 deliver")
				return 2
			}
			fields[strings.ReplaceAll(strings.TrimPrefix(name, "--"), "-", "_")] = value
		default:
			fmt.Fprintln(os.Stderr, "未知参数:", name)
			return 2
		}
	}
	sessionID, provider = defaultSession(sessionID, provider)
	arg := strings.Join(text, " ")
	if arg == "" && kind == event.KindDeliver {
		arg = fields["summary"]
		if arg == "" {
			arg = fields["progress"]
		}
	}
	if strings.TrimSpace(arg) == "" {
		fmt.Fprintln(os.Stderr, "缺少参数")
		return 2
	}
	cwd, _ := os.Getwd()
	if err := c.AgentActionBrief(ctx, kind, arg, fields, provider, sessionID, cwd); err != nil {
		fmt.Fprintln(os.Stderr, "steward-hook:", err)
		return 1
	}
	fmt.Println("已提交到 Session Steward")
	return 0
}

func defaultSession(sessionID, provider string) (string, string) {
	if sessionID != "" {
		return sessionID, provider
	}
	// Claude Code 在 Bash 工具中暴露 CLAUDE_SESSION_ID；Codex 暴露 CODEX_THREAD_ID（如有）
	if v := os.Getenv("CLAUDE_SESSION_ID"); v != "" {
		return v, "claude"
	}
	if v := os.Getenv("CODEX_THREAD_ID"); v != "" {
		return v, "codex"
	}
	return "", provider
}

func report(ctx context.Context, c *hook.Client, args []string, hints bool) int {
	fields := map[string]string{}
	sessionID, provider, title, project := "", "", "", ""
	for i := 1; i < len(args); i++ {
		name, val, hasEq := strings.Cut(args[i], "=")
		if !hasEq {
			if i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				fmt.Fprintln(os.Stderr, "参数缺少取值:", args[i])
				return 2
			}
			val = args[i+1]
			i++
		}
		switch name {
		case "--goal", "--summary", "--progress", "--blocker", "--next", "--stage", "--next-owner":
			fields[strings.ReplaceAll(strings.TrimPrefix(name, "--"), "-", "_")] = val
		case "--title":
			title = val
		case "--project":
			project = val
		case "--session":
			sessionID = val
		case "--provider":
			provider = val
		default:
			fmt.Fprintln(os.Stderr, "未知参数:", name)
			return 2
		}
	}
	sessionID, provider = defaultSession(sessionID, provider)
	cwd, _ := os.Getwd()
	if args[0] == "begin" {
		item, err := c.Begin(ctx, title, project, fields, provider, sessionID, cwd)
		if err != nil {
			fmt.Fprintln(os.Stderr, "steward-hook:", err)
			return 1
		}
		fmt.Println("已登记并关联工作项", item)
		reportFormatHint(fields, hints)
		return 0
	}
	if err := c.Report(ctx, fields, provider, sessionID, cwd); err != nil {
		fmt.Fprintln(os.Stderr, "steward-hook:", err)
		return 1
	}
	fmt.Println("简报已提交到 Session Steward")
	reportFormatHint(fields, hints)
	return 0
}

// 已在运行的旧会话不一定马上收到新的启动说明；在它自然回报时升级格式。
func reportFormatHint(fields map[string]string, enabled bool) {
	if enabled {
		fmt.Println(`核心功能提示：若本次进展改变了已有功能的实现、验证、卡点或下一步，请同步 features --file 更新变化项（features --list 查已有ID）。普通 report 不会猜测功能状态，接入通知也不是用户批准；没有变化无需补报。`)
	}
	if enabled && (fields["stage"] == "" || fields["summary"] == "" || fields["next_owner"] == "") {
		fmt.Println(`自动简报提示（可选，不改变原任务）：下次自然回报时请补 --stage "unknown" --summary "一句普通中文结论" --next-owner "agent"。stage 按事实选 planning/implementing/validating/unknown；负责人选 agent/claude/codex/user/external/unknown。无法判断就用 unknown，不估百分比。实际交付请用 deliver 进入待验收，已验收由用户确认；无需为补简报重跑测试。`)
	}
}
