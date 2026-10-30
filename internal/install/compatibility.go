package install

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Compatibility 是只读的安装计划。基础十二类保持 main 的安装行为。
type Compatibility struct {
	Target       Target   `json:"-"`
	Version      string   `json:"version"`
	VersionKnown bool     `json:"version_known"`
	Skipped      []string `json:"skipped"`
	Reason       string   `json:"reason,omitempty"`
}

var versionPattern = regexp.MustCompile(`(?:^|\s)([0-9]+)\.([0-9]+)\.([0-9]+)(?:\s|$)`)

func parseVersion(raw string) ([3]int, bool) {
	var version [3]int
	m := versionPattern.FindStringSubmatch(strings.TrimSpace(raw))
	if m == nil {
		return version, false
	}
	for i := range version {
		n, err := strconv.Atoi(m[i+1])
		if err != nil {
			return version, false
		}
		version[i] = n
	}
	return version, true
}

func atLeast(version [3]int, required string) bool {
	floor, ok := parseVersion(required)
	if !ok {
		return false
	}
	for i := range version {
		if version[i] != floor[i] {
			return version[i] > floor[i]
		}
	}
	return true
}

// 只门控本次新增的五类事件；原基础十二类不依赖版本探测。
var claudeVerifiedFloors = map[string]string{
	"PreCompact": "1.0.48", "PostCompact": "2.1.76", "TaskCompleted": "2.1.33",
	"CwdChanged": "2.1.83", "PermissionDenied": "2.1.89",
}

func ForVersion(t Target, raw string) Compatibility {
	version, known := parseVersion(raw)
	plan := Compatibility{Target: t, VersionKnown: known, Skipped: []string{}}
	plan.Target.Async = false
	if known {
		plan.Version = fmt.Sprintf("%d.%d.%d", version[0], version[1], version[2])
	}
	if t.Provider == "claude" {
		plan.Target.Events = nil
		for _, event := range t.Events {
			floor := claudeVerifiedFloors[event]
			if floor == "" || (known && atLeast(version, floor)) {
				plan.Target.Events = append(plan.Target.Events, event)
			} else {
				plan.Skipped = append(plan.Skipped, event)
			}
		}
		// 2.1.23 的官方修复记录已能证实 async 支持；这是已验证下界。
		plan.Target.Async = known && atLeast(version, "2.1.23")
	} else if t.Provider == "codex" {
		// 当前官方文档支持 async；仅在本轮核实的 CLI 0.164.0 及以后启用。
		// 老版本仍按原十类事件同步安装，不猜测未知版本的字段兼容。
		plan.Target.Async = known && atLeast(version, "0.164.0")
		if !plan.Target.Async {
			plan.Reason = "未核实此 Codex 版本的异步支持，新增条目保持同步"
		}
	}
	if len(plan.Skipped) > 0 {
		plan.Reason = "部分新增事件在此版本的支持尚未核实，已跳过；基础 12 种照常安装"
	}
	if t.Provider == "claude" && !known {
		plan.Reason = "版本未核实，已保留基础 12 种；仅跳过新增 5 种，新增条目保持同步"
	}
	return plan
}

// ResolveVersion 优先采用显式参数、已记录的 Claude 会话版本，最后才执行 PATH CLI。
// 不扫描历史文件；记录查询失败或无有效版本时，继续以 CLI 探测降级。
func ResolveVersion(ctx context.Context, provider, explicit string, recorded func(context.Context) (string, error), probe func(context.Context, string) (string, error)) (string, error) {
	canonical := func(raw string) (string, bool) {
		v, ok := parseVersion(raw)
		return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2]), ok
	}
	if provider == "claude" {
		if explicit != "" {
			if version, ok := canonical(explicit); ok {
				return version, nil
			}
			return "", fmt.Errorf("--claude-version 必须是明确的 x.y.z 版本")
		}
		if recorded != nil {
			if raw, err := recorded(ctx); err == nil {
				if version, ok := canonical(raw); ok {
					return version, nil
				}
			}
		}
	}
	if probe == nil {
		probe = DetectVersion
	}
	return probe(ctx, provider)
}

// DetectVersion 只执行版本查询，不读取会话、配置、账号或 transcript。
func DetectVersion(ctx context.Context, provider string) (string, error) {
	if provider != "claude" && provider != "codex" {
		return "", fmt.Errorf("不支持的客户端")
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	bin, err := exec.LookPath(provider)
	if err != nil {
		return "", fmt.Errorf("未找到客户端")
	}
	output, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return "", fmt.Errorf("版本查询未完成")
	}
	version, ok := parseVersion(string(output))
	if !ok {
		return "", fmt.Errorf("无法识别客户端版本")
	}
	return fmt.Sprintf("%d.%d.%d", version[0], version[1], version[2]), nil
}

type Coverage struct {
	Provider  string   `json:"provider"`
	Version   string   `json:"version"`
	Installed []string `json:"installed"`
	Missing   []string `json:"missing"`
	Skipped   []string `json:"skipped"`
	Reason    string   `json:"reason,omitempty"`
	ReadError bool     `json:"read_error,omitempty"`
}

// CheckCoverage 只返回事件名与受控诊断，不公开命令、路径、配置或其他工具条目。
func CheckCoverage(t Target, rawVersion string) Coverage {
	plan := ForVersion(t, rawVersion)
	c := Coverage{Provider: t.Provider, Version: plan.Version, Installed: []string{}, Missing: []string{}, Skipped: plan.Skipped, Reason: plan.Reason}
	installed, err := Status(t)
	if err != nil {
		c.Reason = "hooks 配置无法读取，请在本机检查"
		c.ReadError = true
		return c
	}
	for _, event := range t.Events {
		if contains(installed, event) {
			c.Installed = append(c.Installed, event)
		}
	}
	for _, event := range plan.Target.Events {
		if !contains(installed, event) {
			c.Missing = append(c.Missing, event)
		}
	}
	return c
}

// Monitor 缓存版本查询一分钟；刷新设置只读配置，不反复启动客户端。
// 它的锁不涉及 Core、数据库或快照处理。
type Monitor struct {
	Targets []Target
	Probe   func(context.Context, string) (string, error)
	// 服务注入 Core 的只读查询，不重新打开数据库或扫描 transcript。
	ClaudeVersion         func(context.Context) (string, error)
	ExplicitClaudeVersion string
	Now                   func() time.Time
	mu                    sync.Mutex
	versions              map[string]versionCache
}

type versionCache struct {
	value string
	at    time.Time
}

func (m *Monitor) Snapshot(ctx context.Context) []Coverage {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if m.Now != nil {
		now = m.Now()
	}
	probe := m.Probe
	if probe == nil {
		probe = DetectVersion
	}
	if m.versions == nil {
		m.versions = map[string]versionCache{}
	}
	out := make([]Coverage, 0, len(m.Targets))
	for _, target := range m.Targets {
		cached, ok := m.versions[target.Provider]
		if !ok || now.Sub(cached.at) >= time.Minute {
			version, _ := ResolveVersion(ctx, target.Provider, m.ExplicitClaudeVersion, m.ClaudeVersion, probe)
			cached = versionCache{value: version, at: now}
			m.versions[target.Provider] = cached
		}
		out = append(out, CheckCoverage(target, cached.value))
	}
	return out
}
