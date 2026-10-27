// Package config 管理 ~/.steward 下的配置、凭据和目录。
package config

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	ReportingHints    bool   `json:"reporting_hints"`
	Listen            string `json:"listen"`
	PermissionWaitSec int    `json:"permission_wait_sec"`
	KeepSummary       bool   `json:"keep_summary"` // 保留 prompt/最后回复的截断摘要（默认关闭）
	StaleAfterMin     int    `json:"stale_after_min"`
	HistoryDays       int    `json:"history_days"`
	SpoolMax          int    `json:"spool_max"`
	// 托管会话：面板可启动的 Agent 名 → 命令 argv。面板只能选名字，不能提交命令。
	Agents       map[string]AgentSpec `json:"agents"`
	Tmux         string               `json:"tmux"`          // tmux 路径，缺省自动查找
	WorktreeRoot string               `json:"worktree_root"` // 托管 worktree 根目录，缺省放在仓库旁
	// “需要你”推送：macOS 通知默认开启；ntfy 默认关闭，填写主题 URL 才发送。
	NotifyMacOS  bool   `json:"notify_macos"`
	NotifyDialog bool   `json:"notify_dialog"` // 额外弹出带“打开面板”按钮的提示框
	NtfyURL      string `json:"ntfy_url"`
	// 检查门合并：仓库名或 git common dir → 检查命令列表（每条为 argv）。未配置的仓库不会自动合并。
	Checks          map[string][][]string `json:"checks"`
	AutoMerge       bool                  `json:"auto_merge"` // 批准合并后自动运行检查门
	CheckTimeoutSec int                   `json:"check_timeout_sec"`
	// 用量：从本机 transcript 只读取 token 数字字段，默认关闭。
	UsageFromTranscripts bool `json:"usage_from_transcripts"`
	// 远程访问：服务仍只监听回环；由 Tailscale Serve 等反向代理转发。只接受这里列出的 HTTPS 主机名，
	// 并且只接受远程设备 token（与本机面板 token 分开，可单独吊销）。默认空，即关闭。
	RemoteHosts []string `json:"remote_hosts"`
	// AI 摘要：本机命令 argv（例如 ["claude","-p"]），只对 summary_repos 中的仓库可用。默认关闭。
	SummaryCommand []string `json:"summary_command"`
	SummaryRepos   []string `json:"summary_repos"`
	// Explicitly approved repositories: successful memory-maintenance deliveries go to history.
	AutomaticMemoryProjects []string `json:"automatic_memory_projects"`
	// 多设备：一台当中心（hub），其余（agent）每 15 秒把摘要推给它，任何一台都能看“全部设备”。默认关闭。
	Hub HubConfig `json:"hub"`
}

// HubConfig 多设备合并。只走 Tailscale（中心机需配置 remote_hosts 并用 tailscale serve 转发）。
// 摘要只含项目名、工作项编号/标题/状态、会话的 Agent/状态/标题/时间和计数，不含对话、命令、路径。
type HubConfig struct {
	Role   string `json:"role"`   // "" 关闭；"hub" 中心机；"agent" 把摘要推给中心
	URL    string `json:"url"`    // agent：中心机的 Tailscale HTTPS 地址，例如 https://mac-a.tail1234.ts.net
	Secret string `json:"secret"` // agent：中心机运行 steward hub 打印的密钥
	Device string `json:"device"` // 这台电脑在合并视图里的名字，缺省为主机名
}

// AgentSpec 描述面板可启动的 Agent。配置可写成命令数组（简写）或对象。
type AgentSpec struct {
	Argv      []string `json:"argv"`
	Provider  string   `json:"provider"`   // 用于显示与 hooks 关联；缺省为配置名
	Hooks     bool     `json:"hooks"`      // 是否会发 Steward hooks 事件
	PromptArg bool     `json:"prompt_arg"` // 交接时把提示作为最后一个参数传入
}

func (a *AgentSpec) UnmarshalJSON(b []byte) error {
	var argv []string
	if json.Unmarshal(b, &argv) == nil {
		*a = AgentSpec{Argv: argv}
		return nil
	}
	type plain AgentSpec
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*a = AgentSpec(p)
	return nil
}

// NormalizeAgents 补全缺省字段：claude/codex 默认有 hooks 并接受提示参数。
func NormalizeAgents(m map[string]AgentSpec) map[string]AgentSpec {
	out := map[string]AgentSpec{}
	for name, a := range m {
		if len(a.Argv) == 0 {
			continue
		}
		if a.Provider == "" {
			a.Provider = name
			if name == "claude" || name == "codex" {
				a.Hooks, a.PromptArg = true, true
			}
		}
		out[name] = a
	}
	return out
}

func Default() Config {
	return Config{ReportingHints: true, Listen: "127.0.0.1:7788", PermissionWaitSec: 600, StaleAfterMin: 10, HistoryDays: 14, SpoolMax: 2000,
		Agents: map[string]AgentSpec{"claude": {Argv: []string{"claude"}}, "codex": {Argv: []string{"codex"}}}, NotifyMacOS: true, NotifyDialog: false,
		AutoMerge: true, CheckTimeoutSec: 900}
}

// Home 返回 Steward 数据目录，可用 STEWARD_HOME 覆盖。
func Home() string {
	if h := os.Getenv("STEWARD_HOME"); h != "" {
		return h
	}
	u, _ := os.UserHomeDir()
	return filepath.Join(u, ".steward")
}

func Path(name string) string { return filepath.Join(Home(), name) }

// 数值配置的下限。低于下限（包括 0 和负数）视为未正确配置，回落到默认值，避免例如权限等待为 0 时请求立即过期。
// hook 与服务都经由 Load 读取，因此两端得到的值一致。
const (
	MinPermissionWaitSec = 10
	MinSpoolMax          = 10
	MinCheckTimeoutSec   = 10
	MinStaleAfterMin     = 1
	MinHistoryDays       = 0 // 0 表示不扫描历史会话（演示环境使用）
)

// normalize 把低于下限的数值字段回落为默认值。
func (c *Config) normalize() {
	d := Default()
	clamp := func(v *int, min, def int) {
		if *v < min {
			*v = def
		}
	}
	clamp(&c.PermissionWaitSec, MinPermissionWaitSec, d.PermissionWaitSec)
	clamp(&c.SpoolMax, MinSpoolMax, d.SpoolMax)
	clamp(&c.CheckTimeoutSec, MinCheckTimeoutSec, d.CheckTimeoutSec)
	clamp(&c.StaleAfterMin, MinStaleAfterMin, d.StaleAfterMin)
	clamp(&c.HistoryDays, MinHistoryDays, d.HistoryDays)
}

func validListen(l string) bool {
	return strings.HasPrefix(l, "127.0.0.1:") || strings.HasPrefix(l, "localhost:") || strings.HasPrefix(l, "[::1]:")
}

// Load 读取 config.json。出错时返回默认配置和错误，绝不返回半解析或含非法值（如非回环 listen）的配置；
// 调用方应处理错误，而不是继续使用返回值联网。
func Load() (Config, error) {
	b, err := os.ReadFile(Path("config.json"))
	if errors.Is(err, os.ErrNotExist) {
		return Default(), nil
	}
	if err != nil {
		return Default(), err
	}
	c := Default()
	if err := json.Unmarshal(b, &c); err != nil {
		return Default(), fmt.Errorf("config.json 解析失败：%w", err)
	}
	if !validListen(c.Listen) {
		return Default(), errors.New("listen 只允许回环地址")
	}
	c.normalize()
	return c, nil
}

// Secret 读取或生成一个随机凭据文件（权限 0600）。
func Secret(name string) (string, error) {
	p := Path(name)
	if b, err := os.ReadFile(p); err == nil {
		if s := strings.TrimSpace(string(b)); s != "" {
			return s, nil
		}
	}
	if err := os.MkdirAll(Home(), 0o700); err != nil {
		return "", err
	}
	buf := make([]byte, 24)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	s := hex.EncodeToString(buf)
	return s, os.WriteFile(p, []byte(s+"\n"), 0o600)
}

// ReadSecret 只读取，不生成（适配器使用）。
func ReadSecret(name string) string {
	b, err := os.ReadFile(Path(name))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

// HostID 返回本机稳定标识。
func HostID() string {
	if s := ReadSecret("host_id"); s != "" {
		return s
	}
	s, err := Secret("host_id")
	if err != nil {
		h, _ := os.Hostname()
		return h
	}
	return s
}
