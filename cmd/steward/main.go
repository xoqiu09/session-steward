// steward 是 Session Steward 服务与管理命令。
//
//	steward serve                 启动本地服务（只监听 127.0.0.1）
//	steward open                  打印面板登录链接并在浏览器打开
//	steward install [claude|codex|all]    追加 hooks 条目
//	steward uninstall [claude|codex|all]  移除 hooks 条目
//	steward status                查看 hooks 安装与 Codex 信任状态
//	steward service install|uninstall|restart|status  后台常驻（macOS launchd）
//	steward hub                   多设备：查看设置，中心机打印给其他设备用的配置
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	steward "github.com/xoqiu09/session-steward"
	"github.com/xoqiu09/session-steward/internal/config"
	"github.com/xoqiu09/session-steward/internal/core"
	"github.com/xoqiu09/session-steward/internal/event"
	"github.com/xoqiu09/session-steward/internal/gitx"
	"github.com/xoqiu09/session-steward/internal/install"
	"github.com/xoqiu09/session-steward/internal/notify"
	"github.com/xoqiu09/session-steward/internal/scan"
	"github.com/xoqiu09/session-steward/internal/server"
	"github.com/xoqiu09/session-steward/internal/store"
	"github.com/xoqiu09/session-steward/internal/tmux"
	tokenusage "github.com/xoqiu09/session-steward/internal/usage"
)

var BuildCommit = "dev"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "version":
		fmt.Println(BuildCommit)
	case "serve":
		err = serve()
	case "open":
		err = open()
	case "remote":
		err = remote(len(os.Args) > 2 && os.Args[2] == "--rotate")
	case "install":
		err = doInstall(arg(2, "all"), false)
	case "uninstall":
		err = doInstall(arg(2, "all"), true)
	case "m0":
		err = m0()
	case "status":
		err = status()
	case "service":
		err = doService(arg(2, ""))
	case "hub":
		err = hubInfo()
	default:
		usage()
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "错误:", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "用法: steward serve [--claude-version x.y.z] | open | remote [--rotate] | install [claude|codex|all] [--project DIR] [--claude-version x.y.z] | uninstall [claude|codex|all] [--project DIR] | status | service install|uninstall|restart|status | hub | m0")
}

func arg(i int, d string) string {
	if len(os.Args) > i && !strings.HasPrefix(os.Args[i], "--") {
		return os.Args[i]
	}
	return d
}

func serve() error {
	claudeVersion, err := claudeVersionArg(os.Args[2:])
	if err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(config.Home(), 0o700); err != nil {
		return err
	}
	ingest, err := config.Secret("ingest.token")
	if err != nil {
		return err
	}
	panel, err := config.Secret("panel.token")
	if err != nil {
		return err
	}
	st, err := store.Open(config.Path("steward.sqlite"))
	if err != nil {
		return err
	}
	defer st.Close()
	c := core.New(st, gitx.NewLocator())
	c.StaleAfter = time.Duration(cfg.StaleAfterMin) * time.Minute
	c.Agents, c.StewardHome, c.WorktreeRoot = map[string]core.AgentSpec{}, config.Home(), cfg.WorktreeRoot
	for name, a := range config.NormalizeAgents(cfg.Agents) {
		c.Agents[name] = core.AgentSpec{Argv: a.Argv, Provider: a.Provider, Hooks: a.Hooks, PromptArg: a.PromptArg}
	}
	c.SummaryCmd, c.SummaryRepos = cfg.SummaryCommand, cfg.SummaryRepos
	c.AutomaticMemoryProjects = cfg.AutomaticMemoryProjects
	c.Checks, c.AutoMerge, c.CheckTimeout = cfg.Checks, cfg.AutoMerge, time.Duration(cfg.CheckTimeoutSec)*time.Second
	if err := c.RecoverMergeJobs(context.Background()); err != nil {
		log.Printf("恢复合并任务失败: %v", err)
	}
	if bin := tmux.Find(cfg.Tmux); bin != "" {
		c.Term = &tmux.Tmux{Bin: bin, Socket: "steward"}
	} else {
		log.Printf("未找到 tmux：面板中不能启动托管会话，其他功能不受影响")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	c.JobContext = ctx
	defer func() { stop(); c.CloseJobs() }() // 先取消并收回检查，再关闭数据库。
	if err := c.Startup(ctx); err != nil {
		return err
	}

	home, _ := os.UserHomeDir()
	refreshTitles := func() {
		titles := append(scan.CodexTitles(filepath.Join(filepath.Dir(codexHome(home)), "session_index.jsonl")),
			scan.ClaudeTitles(filepath.Join(home, ".claude", "projects"))...)
		if err := c.RefreshTitles(ctx, config.HostID(), titles); err != nil && ctx.Err() == nil {
			log.Printf("会话标题扫描失败: %v", err)
		}
		if _, err := c.ReconcileAttributions(ctx); err != nil && ctx.Err() == nil {
			log.Printf("会话归属整理失败: %v", err)
		}
	}
	// 冷启动：只读扫描历史会话元数据
	go func() {
		since := time.Now().AddDate(0, 0, -cfg.HistoryDays)
		found := append(scan.Claude(filepath.Join(home, ".claude", "projects"), since),
			scan.Codex(codexHome(home), since)...)
		n, err := c.ImportHistory(ctx, config.HostID(), found)
		log.Printf("历史扫描：发现 %d 个会话，新登记 %d 个 (err=%v)", len(found), n, err)
		refreshTitles()
	}()
	// 周期任务：合并扫描、清理变更日志
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			refreshTitles()
			c.ScanMerges(ctx)
			st.PruneChanges(ctx, 50000)
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()

	// 外部合并：每分钟只取待合并项目的远端证据，不更新工作分支。
	go func() {
		t := time.NewTicker(time.Minute)
		defer t.Stop()
		for {
			if err := c.SyncMerges(ctx, false); err != nil && ctx.Err() == nil {
				log.Printf("外部合并核对失败: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()

	// 托管会话：按 tmux 实际状态同步（服务重启后重新接上仍在运行的会话）
	go func() {
		t := time.NewTicker(2 * time.Second)
		defer t.Stop()
		for {
			if err := c.ReconcileManaged(ctx); err != nil && ctx.Err() == nil {
				log.Printf("托管会话同步失败: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	// 用量统计：只读 transcript 中的 token 计数（默认关闭）
	if cfg.UsageFromTranscripts {
		c.UsageDetail = tokenusage.DefaultFinder()
		go func() {
			f := tokenusage.DefaultFinder()
			t := time.NewTicker(60 * time.Second)
			defer t.Stop()
			// 第一次把近一年的会话都归档一遍（只补还没有按天归档的），之后每分钟只看近 7 天。
			since := 370 * 24 * time.Hour
			for {
				_, err := c.RefreshUsage(ctx, f, since)
				since = 7 * 24 * time.Hour
				if err != nil && ctx.Err() == nil {
					log.Printf("用量统计失败: %v", err)
				}
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				}
			}
		}()
	}
	// “需要你”推送
	var senders []core.Sender
	if cfg.NotifyMacOS && runtime.GOOS == "darwin" {
		mac := &notify.MacOS{Dialog: cfg.NotifyDialog}
		if exe, err := os.Executable(); err == nil {
			home, _ := os.UserHomeDir()
			if app := notify.NativeApp(exe, []string{"/Applications", filepath.Join(home, "Applications")}); app != "" {
				mac.AppPath, mac.SpoolDir = app, config.Path("notifications")
			}
		}
		senders = append(senders, mac)
	}
	if cfg.NtfyURL != "" {
		senders = append(senders, &notify.Ntfy{URL: cfg.NtfyURL})
	}
	if len(senders) > 0 {
		n := &core.Notifier{C: c, Senders: senders, BaseURL: "http://" + cfg.Listen}
		if len(cfg.RemoteHosts) > 0 {
			n.RemoteBaseURL = "https://" + cfg.RemoteHosts[0] // ntfy 推送在手机上点开远程面板
		}
		go n.Run(ctx)
	}

	var static fs.FS
	if sub, err := fs.Sub(steward.WebDist, "web/dist"); err == nil {
		if _, err := fs.Stat(sub, "index.html"); err == nil {
			static = sub
		}
	}
	s := &server.Server{BuildCommit: BuildCommit, ReportingHints: cfg.ReportingHints, Core: c, IngestToken: ingest, PanelToken: panel, PermWait: time.Duration(cfg.PermissionWaitSec) * time.Second, Static: static}
	hookMonitor := &install.Monitor{Targets: []install.Target{install.ClaudeTarget(home), install.CodexTarget(home, os.Getenv("CODEX_HOME"))}, ClaudeVersion: c.LatestClaudeVersion, ExplicitClaudeVersion: claudeVersion}
	s.HookCoverage = hookMonitor.Snapshot
	if len(cfg.RemoteHosts) > 0 {
		// 远程设备 token 与本机面板 token 分开；steward remote --rotate 可吊销
		if s.RemoteToken, err = config.Secret("remote.token"); err != nil {
			return err
		}
		s.RemoteHosts = cfg.RemoteHosts
		log.Printf("远程访问已开启，仅接受主机名 %v（需由 Tailscale Serve 等 HTTPS 代理转发到 %s）", cfg.RemoteHosts, cfg.Listen)
	}
	if s.Hub, err = hubFromConfig(cfg); err != nil {
		return err
	}
	if s.Hub != nil && s.Hub.Role == "agent" {
		go func() {
			t := time.NewTicker(15 * time.Second)
			defer t.Stop()
			failing := false
			for {
				if err := s.Hub.Push(ctx, c); err != nil && ctx.Err() == nil {
					if !failing {
						log.Printf("多设备：推送到中心机失败（之后恢复前不再重复提示）：%v", err)
					}
					failing = true
				} else if failing {
					log.Printf("多设备：已恢复推送到中心机")
					failing = false
				}
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				}
			}
		}()
	}
	srv := &http.Server{Addr: cfg.Listen, Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sh, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		srv.Shutdown(sh)
	}()
	log.Printf("Session Steward 已启动：http://%s （用 steward open 登录面板）", cfg.Listen)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func codexHome(home string) string {
	if h := os.Getenv("CODEX_HOME"); h != "" {
		return filepath.Join(h, "sessions")
	}
	return filepath.Join(home, ".codex", "sessions")
}

func open() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	panel, err := config.Secret("panel.token")
	if err != nil {
		return err
	}
	url := fmt.Sprintf("http://%s/login?t=%s", cfg.Listen, panel)
	fmt.Println(url)
	name, args := browserCommand(runtime.GOOS)
	if _, err := exec.LookPath(name); err != nil {
		return nil // 没有可用的打开命令时，打印的链接即可手动打开
	}
	return exec.Command(name, append(args, url)...).Run()
}

// browserCommand 返回各平台用默认浏览器打开链接的命令。
func browserCommand(goos string) (string, []string) {
	switch goos {
	case "darwin":
		return "open", nil
	case "windows":
		return "rundll32", []string{"url.dll,FileProtocolHandler"}
	default:
		return "xdg-open", nil
	}
}

// remote 打印远程设备登录链接。--rotate 生成新 token，旧链接与已登录的远程设备立即失效（需重启服务生效）。
func remote(rotate bool) error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	if len(cfg.RemoteHosts) == 0 {
		return errors.New("远程访问未开启：在 config.json 设置 remote_hosts（例如 Tailscale 的 mac.tailnet.ts.net），并用 tailscale serve 把 HTTPS 转发到 " + cfg.Listen)
	}
	if rotate {
		if err := os.Remove(config.Path("remote.token")); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	t, err := config.Secret("remote.token")
	if err != nil {
		return err
	}
	if rotate {
		fmt.Println("已生成新的远程 token；重启服务后旧设备需重新登录。")
	}
	base := remoteBase(cfg)
	warnRemoteBase(cfg, base)
	fmt.Printf("在手机上打开（仅限你的 tailnet 内设备；链接含凭据，不要分享）：\n%s/login?t=%s\n", base.URL, t)
	return nil
}

// warnRemoteBase 提示 remoteBase 没找到 tailscale serve 转发，或地址开了 Funnel。
func warnRemoteBase(cfg config.Config, base remoteURL) {
	switch {
	case !base.Found:
		fmt.Printf("注意：没在 tailscale serve 里找到转发到 %s 的地址，下面按 443 端口拼出地址。面板挂在其他端口时（例如 443 已给别的服务用），请在主机名后补上端口，否则链接和密钥会发到别的服务。\n\n", cfg.Listen)
	case base.Funnel:
		fmt.Printf("警告：%s 开了 Tailscale Funnel，公网也能访问。面板只应在 tailnet 内转发，请改用 tailscale serve。\n\n", base.URL)
	}
}

// projectFlag 读取 --project DIR（只对 claude 生效）。
func projectFlag() string {
	for i, a := range os.Args {
		if a == "--project" && i+1 < len(os.Args) {
			return os.Args[i+1]
		}
	}
	return ""
}

func targets(which string) []install.Target { return targetsFor(which, projectFlag()) }

func targetsFor(which, project string) []install.Target {
	home, _ := os.UserHomeDir()
	if dir := project; dir != "" {
		if which == "all" {
			which = "claude"
		}
		if which != "claude" {
			fmt.Fprintln(os.Stderr, "--project 只支持 claude；Codex 没有项目级 hooks 文件")
			return nil
		}
		return []install.Target{install.ClaudeProjectTarget(dir)}
	}
	switch which {
	case "claude":
		return []install.Target{install.ClaudeTarget(home)}
	case "codex":
		return []install.Target{install.CodexTarget(home, os.Getenv("CODEX_HOME"))}
	}
	return []install.Target{install.ClaudeTarget(home), install.CodexTarget(home, os.Getenv("CODEX_HOME"))}
}

// hookBinary 把 steward-hook 复制到 ~/.steward/bin 并返回该路径。
// hooks 指向稳定位置：开发目录重新构建或位于外置卷时，不影响 Agent 调用。
func hookBinary() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	self, _ = filepath.EvalSymlinks(self)
	src := filepath.Join(filepath.Dir(self), "steward-hook")
	b, err := os.ReadFile(src)
	if err != nil {
		return "", fmt.Errorf("找不到 %s，请先构建 steward-hook", src)
	}
	dir := config.Path("bin")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	dst := filepath.Join(dir, "steward-hook")
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, b, 0o755); err != nil {
		return "", err
	}
	return dst, os.Rename(tmp, dst)
}

func doInstall(which string, remove bool) error {
	claudeVersion, err := claudeVersionArg(os.Args[2:])
	if err != nil {
		return err
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	bin := ""
	if !remove {
		if bin, err = hookBinary(); err != nil {
			return err
		}
		if _, err := config.Secret("ingest.token"); err != nil {
			return err
		}
	}
	in := &install.Installer{StateDir: config.Path("install"), HookBinary: bin, PermWait: cfg.PermissionWaitSec}
	ts := targets(which)
	if len(ts) == 0 {
		return fmt.Errorf("没有可操作的目标")
	}
	for _, t := range ts {
		if remove {
			mode, err := in.Uninstall(t)
			if err != nil {
				return fmt.Errorf("%s: %w", t.Name, err)
			}
			msg := map[string]string{"restored": "已逐字恢复安装前的文件", "surgical": "文件在安装后被修改过，只移除了 Steward 条目", "none": "没有 Steward 条目", "absent": "文件不存在"}[mode]
			fmt.Printf("%s: %s\n", t.Name, msg)
			continue
		}
		version, probeErr := install.ResolveVersion(context.Background(), t.Provider, claudeVersion, func(ctx context.Context) (string, error) {
			return store.ReadLatestSessionVersion(ctx, config.Path("steward.sqlite"), "claude")
		}, nil)
		plan := install.ForVersion(t, version)
		if probeErr != nil || len(plan.Skipped) > 0 || plan.Reason != "" {
			fmt.Printf("%s: %s；跳过 %v\n", t.Name, plan.Reason, plan.Skipped)
		}
		if len(plan.Target.Events) == 0 {
			continue
		}
		t = plan.Target
		changed, err := in.Install(t)
		if err != nil {
			return fmt.Errorf("%s: %w", t.Name, err)
		}
		fmt.Printf("%s: %s（%s）\n", t.Name, map[bool]string{true: "已补齐或更新 Steward hooks", false: "已是最新"}[changed], t.Path)
		if t.Name == "codex" {
			if changed {
				fmt.Println("  Steward 条目内容已改变，Codex 信任指纹可能变化，请在 Codex 内重新确认。")
			}
			fmt.Println("  注意：Codex 需要在应用内确认新的 hooks 才会启用。运行 steward status 查看信任状态。")
		}
	}
	return nil
}

func claudeVersionArg(args []string) (string, error) {
	version := ""
	for i := 0; i < len(args); i++ {
		value := ""
		if args[i] == "--claude-version" {
			if i+1 >= len(args) {
				return "", fmt.Errorf("--claude-version 缺少 x.y.z 版本")
			}
			i++
			value = args[i]
		} else if strings.HasPrefix(args[i], "--claude-version=") {
			value = strings.TrimPrefix(args[i], "--claude-version=")
		} else {
			continue
		}
		if version != "" || !install.ForVersion(install.Target{Provider: "claude"}, value).VersionKnown {
			return "", fmt.Errorf("--claude-version 需要唯一且明确的 x.y.z 版本")
		}
		version = value
	}
	return version, nil
}

func status() error {
	ts := targetsFor("all", "")
	if dir := projectFlag(); dir != "" {
		ts = append(ts, install.ClaudeProjectTarget(dir))
	}
	for _, t := range ts {
		evs, err := install.Status(t)
		if err != nil {
			fmt.Printf("%s: 读取失败 %v\n", t.Name, err)
			continue
		}
		fmt.Printf("%s: %d 个事件已接入 %v\n", t.Name, len(evs), evs)
		if t.Name == "codex" && len(evs) > 0 {
			tr, un, _ := install.CodexTrust(t, filepath.Join(filepath.Dir(t.Path), "config.toml"))
			fmt.Printf("  已有信任记录 %d 个；待确认 %d 个 %v\n", len(tr), len(un), un)
		}
	}
	cfg, err := config.Load()
	if err != nil {
		fmt.Println("配置有误：", err)
		return err
	}
	resp, err := http.Get("http://" + cfg.Listen + "/hook/ping")
	if err != nil {
		fmt.Println("服务：未运行")
	} else {
		resp.Body.Close()
		fmt.Println("服务：运行中", cfg.Listen)
	}
	return nil
}

// m0 从已采集的事件生成能力表：每种 Agent × 客户端 × 版本实际出现过哪些事件，以及权限请求的处理结果。
func m0() error {
	st, err := store.Open(config.Path("steward.sqlite"))
	if err != nil {
		return err
	}
	defer st.Close()
	db := st.R()
	rows, err := db.Query(`SELECT s.provider, s.client, s.version, e.kind, COUNT(1), MIN(e.occurred_at), MAX(e.occurred_at)
		FROM events e JOIN sessions s ON s.id=e.session_id GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`)
	if err != nil {
		return err
	}
	type key struct{ p, c, v string }
	kinds := map[key]map[string]int{}
	var order []key
	for rows.Next() {
		var k key
		var kind, first, last string
		var n int
		rows.Scan(&k.p, &k.c, &k.v, &kind, &n, &first, &last)
		if k.p == "codex" {
			k.c = event.CodexClient(k.c)
		}
		if _, ok := kinds[k]; !ok {
			order = append(order, k)
			kinds[k] = map[string]int{}
		}
		kinds[k][kind] += n
	}
	rows.Close()
	fmt.Println("## 可观测事件")
	fmt.Println()
	fmt.Println("| Agent | 客户端 | 版本 | 事件（次数） |")
	fmt.Println("|---|---|---|---|")
	for _, k := range order {
		var names, counts []string
		for kind := range kinds[k] {
			names = append(names, kind)
		}
		sort.Strings(names)
		for _, name := range names {
			counts = append(counts, fmt.Sprintf("%s×%d", name, kinds[k][name]))
		}
		fmt.Printf("| %s | %s | %s | %s |\n", k.p, k.c, k.v, strings.Join(counts, ", "))
	}
	rows, err = db.Query(`SELECT s.provider, s.client, a.handleable, a.status, a.close_reason, COUNT(1)
		FROM approvals a JOIN sessions s ON s.id=a.session_id WHERE a.kind='permission' GROUP BY 1,2,3,4,5 ORDER BY 1,2,3,4`)
	if err != nil {
		return err
	}
	fmt.Println()
	fmt.Println("## 权限请求")
	fmt.Println()
	fmt.Println("| Agent | 客户端 | 可在面板处理 | 状态 | 关闭原因 | 次数 |")
	fmt.Println("|---|---|---|---|---|---|")
	type permissionKey struct {
		provider, client, status, reason string
		handleable                       bool
	}
	permissionCounts := map[permissionKey]int{}
	var permissionOrder []permissionKey
	for rows.Next() {
		var p, c, status, reason string
		var h bool
		var n int
		rows.Scan(&p, &c, &h, &status, &reason, &n)
		if p == "codex" {
			c = event.CodexClient(c)
		}
		k := permissionKey{p, c, status, reason, h}
		if _, ok := permissionCounts[k]; !ok {
			permissionOrder = append(permissionOrder, k)
		}
		permissionCounts[k] += n
	}
	rows.Close()
	for _, k := range permissionOrder {
		fmt.Printf("| %s | %s | %v | %s | %s | %d |\n", k.provider, k.client, k.handleable, k.status, k.reason, permissionCounts[k])
	}
	return nil
}

// hubFromConfig 读多设备设置。中心机的密钥自动生成在 STEWARD_HOME/hub.secret；设备编号在 device.id。
func hubFromConfig(cfg config.Config) (*server.Hub, error) {
	h := cfg.Hub
	if h.Role == "" {
		return nil, nil
	}
	id, err := config.Secret("device.id")
	if err != nil {
		return nil, err
	}
	name := h.Device
	if name == "" {
		name, _ = os.Hostname()
		name = strings.TrimSuffix(name, ".local")
	}
	hub := &server.Hub{Role: h.Role, SelfID: id, SelfName: name}
	switch h.Role {
	case "hub":
		if hub.Secret, err = config.Secret("hub.secret"); err != nil {
			return nil, err
		}
		if len(cfg.RemoteHosts) == 0 {
			log.Printf("多设备：本机是中心机，但没有配置 remote_hosts，其他电脑连不进来；见 steward hub")
		}
		log.Printf("多设备：本机是中心机（%s）", name)
	case "agent":
		if h.URL == "" || len(h.Secret) < 16 {
			return nil, fmt.Errorf("多设备：hub.role 为 agent 时需要填写 hub.url 和中心机给的 hub.secret（运行中心机上的 steward hub 查看）")
		}
		if !strings.HasPrefix(h.URL, "https://") {
			return nil, fmt.Errorf("多设备：hub.url 应为中心机的 Tailscale HTTPS 地址（https://…）")
		}
		hub.URL, hub.Secret = h.URL, h.Secret
		log.Printf("多设备：每 15 秒把摘要推给中心机 %s（本机名 %s）", h.URL, name)
	default:
		return nil, fmt.Errorf("多设备：hub.role 只能是 hub 或 agent")
	}
	return hub, nil
}

// hubInfo 打印多设备设置；中心机额外打印给其他设备用的配置片段（含密钥，只在本机终端显示）。
func hubInfo() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	switch cfg.Hub.Role {
	case "":
		fmt.Println(`多设备没有开启。
1. 选一台常开的电脑当中心机，在它的 config.json 里加：
   "remote_hosts": ["<这台的 Tailscale 主机名>.<tailnet>.ts.net"],
   "hub": {"role": "hub"}
   然后运行 steward service restart，并用 tailscale serve 把 HTTPS 转发到本机 7788（见使用手册“在其他设备上查看”）。
2. 在中心机上再运行 steward hub，按打印的内容配置其他电脑。`)
	case "hub":
		secret, err := config.Secret("hub.secret")
		if err != nil {
			return err
		}
		url := "https://<中心机的 Tailscale 主机名>"
		if len(cfg.RemoteHosts) > 0 {
			base := remoteBase(cfg)
			warnRemoteBase(cfg, base)
			url = base.URL
		} else {
			fmt.Println("注意：还没有配置 remote_hosts，其他电脑连不进来。")
		}
		fmt.Printf("本机是中心机。在其他电脑的 ~/.steward/config.json 里加上（密钥只给自己的设备）：\n\n  \"hub\": {\"role\": \"agent\", \"url\": %q, \"secret\": %q, \"device\": \"给那台电脑起个名字\"}\n\n然后在那台电脑上运行 steward service restart。\n", url, secret)
	case "agent":
		fmt.Printf("本机把摘要推给中心机 %s（设备名 %s）。最近一次推送结果在面板小镇顶部切到“全部设备”后看。\n", cfg.Hub.URL, cfg.Hub.Device)
	default:
		fmt.Println("hub.role 只能是 hub 或 agent")
	}
	return nil
}
