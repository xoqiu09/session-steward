// Package service 把 steward serve 注册为当前用户的后台服务（macOS launchd LaunchAgent）。
//
// 规则：
//   - 只操作自己的 plist（~/Library/LaunchAgents/<Label>.plist）。文件里带标识 Marker；同名文件不带标识时拒绝覆盖或删除。
//   - 用 launchctl bootstrap / bootout gui/<uid> 加载与卸载；命令经 Runner 注入，测试不调用真实 launchctl。
//   - 数据目录里只创建 logs/，不读写 token 与数据库。
//   - 端口已被占用（例如手动启动的 steward serve）且服务未加载时拒绝安装：两个 serve 不能共用同一数据目录与端口。
package service

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Label 是 LaunchAgent 的标签，也是 plist 文件名。
const Label = "io.github.xoqiu09.session-steward"

// Marker 写在 plist 的注释里，用来识别由 steward 写入的文件。
const Marker = "steward-service-v1"

// Runner 执行一条外部命令并返回合并后的输出。
type Runner func(name string, args ...string) ([]byte, error)

// ExecRunner 直接执行命令。
func ExecRunner(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

var ErrNotOurs = errors.New("该文件不是 steward service install 写入的（缺少标识 " + Marker + "），不覆盖也不删除")

// Agent 描述一个 LaunchAgent。
type Agent struct {
	Label     string
	PlistPath string            // ~/Library/LaunchAgents/<Label>.plist
	Binary    string            // steward 的绝对路径
	Home      string            // STEWARD_HOME（绝对路径），日志写到其中的 logs/
	Env       map[string]string // 写入 EnvironmentVariables
	UID       int
	Run       Runner
	PortInUse func() bool // 服务未加载时，监听地址是否已被占用；nil 表示不检查
	Sleep     func(time.Duration)
}

// New 返回使用真实 launchctl 的 Agent。
func New(home, binary, homeDir string, env map[string]string, uid int) *Agent {
	return &Agent{Label: Label, PlistPath: filepath.Join(home, "Library", "LaunchAgents", Label+".plist"),
		Binary: binary, Home: homeDir, Env: env, UID: uid, Run: ExecRunner, Sleep: time.Sleep}
}

// Env 生成服务的环境变量：launchd 不继承登录 shell 的环境。
// LANG 必须是 UTF-8；PATH 沿用安装时的值，托管会话才能找到 claude、codex、git 等命令。
func Env(getenv func(string) string, home string) map[string]string {
	env := map[string]string{"STEWARD_HOME": home, "LANG": "en_US.UTF-8"}
	if l := getenv("LANG"); strings.Contains(strings.ToUpper(strings.ReplaceAll(l, "-", "")), "UTF8") {
		env["LANG"] = l
	}
	for _, k := range []string{"PATH", "CODEX_HOME"} {
		if v := getenv(k); v != "" {
			env[k] = v
		}
	}
	return env
}

func (a *Agent) LogPaths() (stdout, stderr string) {
	dir := filepath.Join(a.Home, "logs")
	return filepath.Join(dir, "serve.out.log"), filepath.Join(dir, "serve.err.log")
}

func (a *Agent) domain() string { return fmt.Sprintf("gui/%d", a.UID) }
func (a *Agent) target() string { return a.domain() + "/" + a.Label }

// Plist 返回要写入的 plist 内容。
func (a *Agent) Plist() []byte {
	var b bytes.Buffer
	str := func(indent, s string) { fmt.Fprintf(&b, "%s<string>%s</string>\n", indent, esc(s)) }
	key := func(indent, k string) { fmt.Fprintf(&b, "%s<key>%s</key>\n", indent, esc(k)) }
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- ` + Marker + `: written by "steward service install", removed by "steward service uninstall". Do not edit. -->
<plist version="1.0">
<dict>
`)
	key("\t", "Label")
	str("\t", a.Label)
	key("\t", "ProgramArguments")
	b.WriteString("\t<array>\n")
	str("\t\t", a.Binary)
	str("\t\t", "serve")
	b.WriteString("\t</array>\n")
	key("\t", "EnvironmentVariables")
	b.WriteString("\t<dict>\n")
	keys := make([]string, 0, len(a.Env))
	for k := range a.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		key("\t\t", k)
		str("\t\t", a.Env[k])
	}
	b.WriteString("\t</dict>\n")
	key("\t", "WorkingDirectory")
	str("\t", a.Home)
	key("\t", "RunAtLoad")
	b.WriteString("\t<true/>\n")
	key("\t", "KeepAlive")
	b.WriteString("\t<true/>\n")
	out, errp := a.LogPaths()
	key("\t", "StandardOutPath")
	str("\t", out)
	key("\t", "StandardErrorPath")
	str("\t", errp)
	b.WriteString("</dict>\n</plist>\n")
	return b.Bytes()
}

func esc(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&apos;").Replace(s)
}

// Loaded 报告服务是否已在 launchd 中加载。
func (a *Agent) Loaded() bool {
	_, err := a.Run("launchctl", "print", a.target())
	return err == nil
}

// readOurs 读取现有 plist：不存在返回 nil；存在但不是我们写的返回 ErrNotOurs。
func (a *Agent) readOurs() ([]byte, error) {
	b, err := os.ReadFile(a.PlistPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !bytes.Contains(b, []byte(Marker)) {
		return nil, fmt.Errorf("%s: %w", a.PlistPath, ErrNotOurs)
	}
	return b, nil
}

// Install 写入 plist 并加载。返回 "installed"（新装）、"updated"（plist 有变化，已重新加载）、
// "loaded"（plist 未变，原先未加载）或 "unchanged"。force 跳过端口占用检查。
func (a *Agent) Install(force bool) (string, error) {
	if !filepath.IsAbs(a.Binary) {
		return "", fmt.Errorf("steward 路径必须是绝对路径：%s", a.Binary)
	}
	if strings.Contains(a.Binary, string(filepath.Separator)+"go-build") {
		return "", fmt.Errorf("%s 是 go run 的临时文件，退出后会被删除；请先 go build 再从构建产物运行", a.Binary)
	}
	old, err := a.readOurs()
	if err != nil {
		return "", err
	}
	loaded := a.Loaded()
	if !loaded && !force && a.PortInUse != nil && a.PortInUse() {
		return "", errors.New("监听地址已被占用，可能已有手动启动的 steward serve。两个 serve 不能共用同一数据目录和端口：先停止它再安装（确认不是 steward 时可加 --force）")
	}
	want := a.Plist()
	if old != nil && bytes.Equal(old, want) && loaded {
		return "unchanged", nil
	}
	out, _ := a.LogPaths()
	if err := os.MkdirAll(filepath.Dir(out), 0o700); err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(a.PlistPath), 0o755); err != nil {
		return "", err
	}
	if loaded {
		if err := a.bootout(); err != nil {
			return "", err
		}
	}
	tmp := a.PlistPath + ".tmp"
	if err := os.WriteFile(tmp, want, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, a.PlistPath); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if b, err := a.Run("launchctl", "bootstrap", a.domain(), a.PlistPath); err != nil {
		return "", fmt.Errorf("launchctl bootstrap 失败：%v %s", err, strings.TrimSpace(string(b)))
	}
	switch {
	case old == nil:
		return "installed", nil
	case bytes.Equal(old, want):
		return "loaded", nil
	}
	return "updated", nil
}

// bootout 卸载服务并等待 launchd 真正移除，避免紧接着的 bootstrap 失败。
func (a *Agent) bootout() error {
	if b, err := a.Run("launchctl", "bootout", a.target()); err != nil {
		return fmt.Errorf("launchctl bootout 失败：%v %s", err, strings.TrimSpace(string(b)))
	}
	for i := 0; i < 50 && a.Loaded(); i++ {
		a.Sleep(100 * time.Millisecond)
	}
	return nil
}

// Uninstall 卸载服务并删除 plist。返回 "removed" 或 "absent"（本来就没有）。日志保留。
func (a *Agent) Uninstall() (string, error) {
	old, err := a.readOurs()
	if err != nil {
		return "", err
	}
	loaded := a.Loaded()
	if old == nil && !loaded {
		return "absent", nil
	}
	if loaded {
		if err := a.bootout(); err != nil {
			return "", err
		}
	}
	if old != nil {
		if err := os.Remove(a.PlistPath); err != nil {
			return "", err
		}
	}
	return "removed", nil
}

// Restart 让 launchd 重启服务进程（kickstart -k），会重新执行 plist 里的 steward 路径。
func (a *Agent) Restart() error {
	if !a.Loaded() {
		return errors.New("服务未加载：先运行 steward service install")
	}
	if b, err := a.Run("launchctl", "kickstart", "-k", a.target()); err != nil {
		return fmt.Errorf("launchctl kickstart 失败：%v %s", err, strings.TrimSpace(string(b)))
	}
	return nil
}

// Status 描述服务现状。
type Status struct {
	Plist  string // "absent" | "ours" | "foreign"
	Loaded bool
	Detail []string // launchctl print 中的 state / pid / last exit code 行
}

func (a *Agent) Status() Status {
	s := Status{Plist: "absent"}
	if _, err := a.readOurs(); errors.Is(err, ErrNotOurs) {
		s.Plist = "foreign"
	} else if _, err := os.Stat(a.PlistPath); err == nil {
		s.Plist = "ours"
	}
	b, err := a.Run("launchctl", "print", a.target())
	if err != nil {
		return s
	}
	s.Loaded = true
	seen := map[string]bool{} // 嵌套段落（如 endpoints）里也有 state = ，只取顶层第一次出现的
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		for _, p := range []string{"state = ", "runs = ", "pid = ", "last exit code = "} {
			if strings.HasPrefix(line, p) && !seen[p] {
				seen[p] = true
				s.Detail = append(s.Detail, line)
			}
		}
	}
	return s
}
