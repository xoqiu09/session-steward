// Package install 在 Claude Code 与 Codex 的 hooks 配置中追加或移除 Steward 条目。
//
// 规则：
//   - 只追加自己的条目，不改动、不重排他人的条目；每个 Steward 条目的命令里带标识 --mark=steward-v1。
//   - 首次安装保存原始文件备份；写入用“临时文件 + rename”，并在 rename 前确认文件未被他人改动。
//   - 卸载：文件仍是我们写入时的样子且安装期间从未发现外部修改 → 逐字恢复原始备份；否则只移除带标识的条目，保留他人的修改。
//   - 重装时若文件已不是我们上次写入的样子，原始备份即失效：此后卸载一律只移除自己的条目。
//   - 目标是符号链接时写入链接指向的真实文件，链接本身保持不变。
package install

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/xoqiu09/session-steward/internal/ojson"
)

const Mark = "--mark=steward-v1"

// Target 描述一个 hooks 配置文件。
type Target struct {
	Name     string // claude | codex
	Path     string // settings.json 或 hooks.json
	Provider string
	Events   []string
}

func ClaudeTarget(home string) Target {
	return Target{Name: "claude", Provider: "claude", Path: filepath.Join(home, ".claude", "settings.json"), Events: []string{
		"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
		"Notification", "Stop", "StopFailure", "SubagentStart", "SubagentStop", "SessionEnd",
	}}
}

// ClaudeProjectTarget 只写入某个目录的 .claude/settings.local.json，用于不影响全局配置的实测。
func ClaudeProjectTarget(dir string) Target {
	t := ClaudeTarget("")
	abs, _ := filepath.Abs(dir)
	t.Path = filepath.Join(abs, ".claude", "settings.local.json")
	t.Name = "claude-project-" + sum([]byte(abs))[:12]
	return t
}

// CodexTarget 使用 home 下的 .codex；codexHome 非空时（CODEX_HOME）优先使用它。
func CodexTarget(home string, codexHome ...string) Target {
	dir := filepath.Join(home, ".codex")
	if len(codexHome) > 0 && codexHome[0] != "" {
		dir = codexHome[0]
	}
	return Target{Name: "codex", Provider: "codex", Path: filepath.Join(dir, "hooks.json"), Events: []string{
		"SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest",
		"Stop", "Interrupt", "SubagentStart", "SubagentStop", "SessionEnd",
	}}
}

// State 记录安装信息，存放在 ~/.steward/install/<name>.json。
type State struct {
	Path          string   `json:"path"`
	OrigExisted   bool     `json:"orig_existed"`
	OrigHash      string   `json:"orig_hash"`
	WrittenHash   string   `json:"written_hash"`
	CreatedKeys   []string `json:"created_keys"` // 安装时新建的事件键（卸载后若为空则删除）
	CreatedHooks  bool     `json:"created_hooks_obj"`
	HookBinary    string   `json:"hook_binary"`
	PermissionSec int      `json:"permission_sec"`
	// ExternalEdits 表示某次重装时发现文件在我们写入后被他人改过。原始备份不再代表“去掉 Steward 后的文件”，
	// 卸载不能再逐字恢复，只能移除自己的条目。
	ExternalEdits bool `json:"external_edits,omitempty"`
}

type Installer struct {
	StateDir   string // ~/.steward/install
	HookBinary string // steward-hook 的绝对路径
	PermWait   int    // 权限等待秒数
}

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func (in *Installer) statePath(t Target) string { return filepath.Join(in.StateDir, t.Name+".json") }
func (in *Installer) backupPath(t Target) string {
	return filepath.Join(in.StateDir, t.Name+".orig")
}

func (in *Installer) loadState(t Target) (*State, error) {
	b, err := os.ReadFile(in.statePath(t))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var s State
	return &s, json.Unmarshal(b, &s)
}

func (in *Installer) saveState(t Target, s *State) error {
	b, _ := json.MarshalIndent(s, "", "  ")
	return atomicWrite(in.statePath(t), b, 0o600, "")
}

func shellQuote(s string) string {
	if regexp.MustCompile(`^[A-Za-z0-9_./-]+$`).MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func (in *Installer) command(t Target, ev string) string {
	return fmt.Sprintf("%s %s %s %s", shellQuote(in.HookBinary), t.Provider, ev, Mark)
}

func isOurs(v ojson.Value) bool {
	o, ok := v.(*ojson.Object)
	if !ok {
		return false
	}
	c, _ := o.Get("command")
	s, _ := ojson.Str(c)
	return strings.Contains(s, Mark)
}

// readCurrent 读取配置文件；不存在时返回空对象。
func readCurrent(path string) (raw []byte, root *ojson.Object, existed bool, err error) {
	raw, err = os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, &ojson.Object{}, false, nil
	}
	if err != nil {
		return nil, nil, false, err
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return raw, &ojson.Object{}, true, nil
	}
	v, err := ojson.Parse(raw)
	if err != nil {
		return nil, nil, true, fmt.Errorf("%s 不是合法 JSON：%w", path, err)
	}
	o, ok := v.(*ojson.Object)
	if !ok {
		return nil, nil, true, fmt.Errorf("%s 顶层不是对象", path)
	}
	return raw, o, true, nil
}

// stripOurs 从 hooks 对象中移除所有 Steward 条目；返回是否有改动。
func stripOurs(hooks *ojson.Object) bool {
	changed := false
	for i := range hooks.Members {
		arr, ok := hooks.Members[i].Value.([]ojson.Value)
		if !ok {
			continue
		}
		var keep []ojson.Value
		for _, g := range arr {
			go_, ok := g.(*ojson.Object)
			if !ok {
				keep = append(keep, g)
				continue
			}
			hv, _ := go_.Get("hooks")
			hs, ok := hv.([]ojson.Value)
			if !ok {
				keep = append(keep, g)
				continue
			}
			var hk []ojson.Value
			for _, h := range hs {
				if isOurs(h) {
					changed = true
					continue
				}
				hk = append(hk, h)
			}
			if len(hk) == 0 && len(hs) > 0 {
				continue // 整组都是我们的，移除这一组
			}
			if len(hk) != len(hs) {
				go_.Set("hooks", hk)
			}
			keep = append(keep, g)
		}
		if keep == nil {
			keep = []ojson.Value{}
		}
		hooks.Members[i].Value = keep
	}
	return changed
}

// Install 幂等安装：先移除旧的 Steward 条目，再在每个事件数组末尾追加一组。
func (in *Installer) Install(t Target) (changed bool, err error) {
	if err := os.MkdirAll(in.StateDir, 0o700); err != nil {
		return false, err
	}
	raw, root, existed, err := readCurrent(t.Path)
	if err != nil {
		return false, err
	}
	st, err := in.loadState(t)
	if err != nil {
		return false, err
	}
	if st == nil {
		// 首次安装：保存原始备份
		st = &State{Path: t.Path, OrigExisted: existed, OrigHash: sum(raw)}
		if existed {
			if err := atomicWrite(in.backupPath(t), raw, 0o600, ""); err != nil {
				return false, err
			}
		}
	} else if !st.ExternalEdits && sum(raw) != st.WrittenHash {
		// 上次写入后文件被他人改过（含删除）：逐字恢复备份会丢掉这些修改，改为卸载时只移除自己的条目。
		st.ExternalEdits = true
		if err := os.Remove(in.backupPath(t)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
	}
	hv, ok := root.Get("hooks")
	hooks, isObj := hv.(*ojson.Object)
	if !ok || !isObj {
		if ok && !isObj {
			return false, fmt.Errorf("%s 中 hooks 不是对象，拒绝修改", t.Path)
		}
		hooks = &ojson.Object{}
		root.Set("hooks", hooks)
		st.CreatedHooks = true
	}
	stripOurs(hooks)
	for _, ev := range t.Events {
		cur, ok := hooks.Get(ev)
		arr, isArr := cur.([]ojson.Value)
		if ok && !isArr {
			return false, fmt.Errorf("%s 中 hooks.%s 不是数组，拒绝修改", t.Path, ev)
		}
		if !ok && !contains(st.CreatedKeys, ev) {
			st.CreatedKeys = append(st.CreatedKeys, ev)
		}
		h := &ojson.Object{}
		h.Set("type", "command")
		h.Set("command", in.command(t, ev))
		timeout := 10
		if ev == "PermissionRequest" {
			timeout = in.PermWait + 30
		}
		if t.Provider == "codex" && (ev == "Interrupt" || ev == "SessionEnd") {
			timeout = 3
		}
		h.Set("timeout", json.RawMessage(fmt.Sprint(timeout)))
		g := &ojson.Object{}
		if t.Name == "codex" || ev == "PermissionRequest" || strings.Contains(ev, "Tool") {
			g.Set("matcher", "*")
		}
		g.Set("hooks", []ojson.Value{h})
		hooks.Set(ev, append(arr, g))
	}
	out := ojson.Marshal(root)
	if bytes.Equal(out, raw) {
		return false, in.saveState(t, st)
	}
	mode := os.FileMode(0o600)
	if fi, err := os.Stat(t.Path); err == nil {
		mode = fi.Mode().Perm()
	}
	if err := os.MkdirAll(filepath.Dir(t.Path), 0o700); err != nil {
		return false, err
	}
	if err := atomicWrite(t.Path, out, mode, sum(raw)); err != nil {
		return false, err
	}
	st.WrittenHash = sum(out)
	st.HookBinary = in.HookBinary
	st.PermissionSec = in.PermWait
	return true, in.saveState(t, st)
}

// Uninstall 移除 Steward 条目。
func (in *Installer) Uninstall(t Target) (mode string, err error) {
	st, err := in.loadState(t)
	if err != nil {
		return "", err
	}
	raw, root, existed, err := readCurrent(t.Path)
	if err != nil {
		return "", err
	}
	if st != nil && !st.ExternalEdits && existed && sum(raw) == st.WrittenHash {
		// 安装后无外部修改：逐字恢复原始文件
		if st.OrigExisted {
			orig, err := os.ReadFile(in.backupPath(t))
			if err != nil {
				return "", fmt.Errorf("读取备份失败：%w", err)
			}
			fi, _ := os.Stat(t.Path)
			if err := atomicWrite(t.Path, orig, fi.Mode().Perm(), sum(raw)); err != nil {
				return "", err
			}
		} else if err := os.Remove(t.Path); err != nil {
			return "", err
		}
		in.clear(t)
		return "restored", nil
	}
	if !existed {
		in.clear(t)
		return "absent", nil
	}
	// 有外部修改：只移除我们的条目
	hv, _ := root.Get("hooks")
	hooks, ok := hv.(*ojson.Object)
	if !ok {
		in.clear(t)
		return "none", nil
	}
	if !stripOurs(hooks) {
		in.clear(t)
		return "none", nil
	}
	if st != nil {
		for _, k := range st.CreatedKeys {
			if v, ok := hooks.Get(k); ok {
				if a, ok := v.([]ojson.Value); ok && len(a) == 0 {
					hooks.Delete(k)
				}
			}
		}
		if st.CreatedHooks && len(hooks.Members) == 0 {
			root.Delete("hooks")
		}
	}
	fi, _ := os.Stat(t.Path)
	if err := atomicWrite(t.Path, ojson.Marshal(root), fi.Mode().Perm(), sum(raw)); err != nil {
		return "", err
	}
	in.clear(t)
	return "surgical", nil
}

func (in *Installer) clear(t Target) {
	os.Remove(in.statePath(t))
	os.Remove(in.backupPath(t))
}

// Status 返回该配置中 Steward 条目覆盖的事件。
func Status(t Target) (events []string, err error) {
	_, root, existed, err := readCurrent(t.Path)
	if err != nil || !existed {
		return nil, err
	}
	hv, _ := root.Get("hooks")
	hooks, ok := hv.(*ojson.Object)
	if !ok {
		return nil, nil
	}
	for _, m := range hooks.Members {
		arr, _ := m.Value.([]ojson.Value)
		for _, g := range arr {
			o, _ := g.(*ojson.Object)
			if o == nil {
				continue
			}
			hv, _ := o.Get("hooks")
			hs, _ := hv.([]ojson.Value)
			for _, h := range hs {
				if isOurs(h) {
					events = append(events, m.Key)
				}
			}
		}
	}
	return events, nil
}

// CodexTrust 检查 ~/.codex/config.toml 中 Steward 条目是否已有信任记录。
// Codex 以 "<文件>:<事件 snake_case>:<组序号>:<条目序号>" 记录信任；内容变化后需重新确认。
// 这里只能检测“是否存在信任记录”，无法验证哈希，最终以 Codex 内的提示为准。
func CodexTrust(t Target, configToml string) (trusted, untrusted []string, err error) {
	_, root, existed, err := readCurrent(t.Path)
	if err != nil || !existed {
		return nil, nil, err
	}
	toml, _ := os.ReadFile(configToml)
	text := string(toml)
	hv, _ := root.Get("hooks")
	hooks, _ := hv.(*ojson.Object)
	if hooks == nil {
		return nil, nil, nil
	}
	for _, m := range hooks.Members {
		arr, _ := m.Value.([]ojson.Value)
		for gi, g := range arr {
			o, _ := g.(*ojson.Object)
			if o == nil {
				continue
			}
			hv, _ := o.Get("hooks")
			hs, _ := hv.([]ojson.Value)
			for hi, h := range hs {
				if !isOurs(h) {
					continue
				}
				key := fmt.Sprintf(`[hooks.state."%s:%s:%d:%d"]`, t.Path, snake(m.Key), gi, hi)
				idx := strings.Index(text, key)
				if idx >= 0 && strings.Contains(firstLines(text[idx+len(key):], 3), "trusted_hash") {
					trusted = append(trusted, m.Key)
				} else {
					untrusted = append(untrusted, m.Key)
				}
			}
		}
	}
	return
}

func firstLines(s string, n int) string {
	parts := strings.SplitN(s, "\n", n+1)
	if len(parts) > n {
		parts = parts[:n]
	}
	return strings.Join(parts, "\n")
}

func snake(s string) string {
	var b strings.Builder
	for i, r := range s {
		if r >= 'A' && r <= 'Z' {
			if i > 0 {
				b.WriteByte('_')
			}
			b.WriteRune(r + 32)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// resolveSymlinks 沿符号链接找到真实目标，使 rename 替换的是目标文件而不是链接本身。
// 链接指向的文件尚不存在时 EvalSymlinks 会失败，此时逐层 Readlink 得到将要创建的目标路径。
func resolveSymlinks(path string) (string, error) {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		return real, nil
	}
	for i := 0; i < 40; i++ {
		fi, err := os.Lstat(path)
		if errors.Is(err, os.ErrNotExist) {
			return path, nil
		}
		if err != nil {
			return "", err
		}
		if fi.Mode()&os.ModeSymlink == 0 {
			return path, nil
		}
		link, err := os.Readlink(path)
		if err != nil {
			return "", err
		}
		if !filepath.IsAbs(link) {
			link = filepath.Join(filepath.Dir(path), link)
		}
		path = link
	}
	return "", fmt.Errorf("%s 的符号链接层数过多", path)
}

// atomicWrite 写临时文件后 rename。expectHash 非空时，rename 前确认目标文件内容仍是预期的（防止覆盖他人刚写入的修改）。
// path 是符号链接时写入其真实目标。
func atomicWrite(path string, data []byte, mode os.FileMode, expectHash string) error {
	path, err := resolveSymlinks(path)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".steward-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	if err := os.Chmod(tmp.Name(), mode); err != nil {
		return err
	}
	if expectHash != "" {
		cur, err := os.ReadFile(path)
		if err == nil && sum(cur) != expectHash {
			return fmt.Errorf("%s 在处理期间被其他程序修改，请重试", path)
		}
	}
	return os.Rename(tmp.Name(), path)
}
