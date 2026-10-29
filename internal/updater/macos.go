package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/xoqiu09/session-steward/internal/service"
)

func command(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	b, e := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if e != nil {
		return nil, fmt.Errorf("%s: %v %s", filepath.Base(name), e, strings.TrimSpace(string(b)))
	}
	return b, nil
}
func plist(path, key string) (string, error) {
	b, e := command("/usr/libexec/PlistBuddy", "-c", "Print :"+key, path)
	return strings.TrimSpace(string(b)), e
}
func samePath(a, b string) bool { return filepath.Clean(a) == filepath.Clean(b) }
func plainPath(path string) error {
	path = filepath.Clean(path)
	for p := path; p != "/" && p != "."; p = filepath.Dir(p) {
		s, e := os.Lstat(p)
		if errors.Is(e, os.ErrNotExist) {
			continue
		}
		if e != nil {
			return e
		}
		if s.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("升级路径含符号链接，请先确认安装位置：%s", p)
		}
	}
	return nil
}
func copyTree(src, dst string) error {
	if e := plainPath(dst); e != nil {
		return e
	}
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, e := filepath.Rel(src, path)
		if e != nil {
			return e
		}
		to := filepath.Join(dst, rel)
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("不复制符号链接")
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if d.IsDir() {
			return os.MkdirAll(to, info.Mode().Perm()&0755)
		}
		if !info.Mode().IsRegular() {
			return errors.New("不复制特殊文件")
		}
		in, e := os.Open(path)
		if e != nil {
			return e
		}
		defer in.Close()
		out, e := os.OpenFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
		if e != nil {
			return e
		}
		_, e = io.Copy(out, in)
		if e == nil {
			e = out.Sync()
		}
		ce := out.Close()
		if e != nil {
			return e
		}
		return ce
	})
}
func ValidateBundle(app string, m Manifest, arch string) error {
	if _, e := command("/usr/bin/codesign", "--verify", "--deep", "--strict", app); e != nil {
		return fmt.Errorf("App 代码签名校验失败：%w", e)
	}
	info := filepath.Join(app, "Contents/Info.plist")
	for k, want := range map[string]string{"CFBundleIdentifier": "io.github.xoqiu09.session-steward.app", "CFBundleShortVersionString": m.Version, "CFBundleVersion": strconv.FormatInt(m.Build, 10), "StewardSchema": strconv.Itoa(m.Schema)} {
		got, e := plist(info, k)
		if e != nil || got != want {
			return fmt.Errorf("App 元数据 %s 不匹配", k)
		}
	}
	for _, bin := range []string{"steward", "steward-hook"} {
		path := filepath.Join(app, "Contents/MacOS", bin)
		b, e := command(path, "version")
		if e != nil || strings.TrimSpace(string(b)) != m.Commit {
			return fmt.Errorf("%s 与发布提交或芯片不匹配", bin)
		}
	}
	b, e := command(filepath.Join(app, "Contents/MacOS/steward-updater"), "info")
	var infoBuild struct {
		Build              int64
		Version, Arch, Key string
		Schema             int
	}
	if e != nil || json.Unmarshal(b, &infoBuild) != nil || infoBuild.Build != m.Build || infoBuild.Version != m.Version || infoBuild.Arch != arch || infoBuild.Schema != m.Schema || infoBuild.Key != PublicKey {
		return errors.New("升级助手与发布信息不匹配")
	}
	return nil
}

// Prepare validates the exact service association and stages every component.
// It does not stop anything or edit hook/config/launchd files.
func Prepare(app, home, mode, work string, parent int, m Manifest) (*Plan, error) {
	return prepare(app, home, mode, work, parent, m, filepath.Join(os.Getenv("HOME"), "Library/LaunchAgents", service.Label+".plist"))
}
func prepare(app, home, mode, work string, parent int, m Manifest, servicePlist string) (*Plan, error) {
	if runtime.GOOS != "darwin" {
		return nil, errors.New("App 升级仅支持 macOS")
	}
	for _, p := range []string{app, home, work} {
		if !filepath.IsAbs(p) {
			return nil, errors.New("升级路径必须是绝对路径")
		}
		if e := plainPath(p); e != nil {
			return nil, e
		}
	}
	if strings.Contains(app, "/AppTranslocation/") || filepath.Base(app) != "Session Steward.app" {
		return nil, errors.New("请先把 App 放到可写的长期安装位置，再检查更新")
	}
	p := &Plan{App: app, Home: home, Mode: mode, Work: work, Parent: parent, Commit: m.Commit, State: "prepared", Listen: "127.0.0.1:7788"}
	if b, e := os.ReadFile(filepath.Join(home, "config.json")); e == nil {
		var c struct{ Listen string }
		if e = json.Unmarshal(b, &c); e != nil {
			return nil, e
		}
		if c.Listen != "" {
			p.Listen = c.Listen
		}
	}
	if !strings.HasPrefix(p.Listen, "127.0.0.1:") && !strings.HasPrefix(p.Listen, "[::1]:") {
		return nil, errors.New("升级健康检查需要本机回环监听地址")
	}
	if mode == "shared" {
		p.Plist = servicePlist
		b, e := os.ReadFile(p.Plist)
		if e != nil || !strings.Contains(string(b), service.Marker) {
			return nil, errors.New("共用后台不是可识别的 Steward launchd 服务，请先确认服务归属")
		}
		h, e := plist(p.Plist, "EnvironmentVariables:STEWARD_HOME")
		if e != nil || !samePath(h, home) {
			return nil, errors.New("launchd 服务的数据目录不同，不会修改")
		}
		binary, e := plist(p.Plist, "ProgramArguments:0")
		if e != nil || (!samePath(binary, filepath.Join(home, "bin/steward")) && !samePath(binary, filepath.Join(app, "Contents/MacOS/steward"))) {
			return nil, errors.New("共用后台使用自定义路径，请手动对齐版本后再更新")
		}
		label, e := plist(p.Plist, "Label")
		if e != nil || label != strings.TrimSuffix(filepath.Base(servicePlist), ".plist") {
			return nil, errors.New("服务标签无法识别")
		}
		a, e := plist(p.Plist, "ProgramArguments:1")
		if e != nil || a != "serve" {
			return nil, errors.New("服务启动参数无法识别")
		}
	} else if mode != "own" {
		return nil, errors.New("未知服务模式")
	}
	oldCommit, e := command(filepath.Join(app, "Contents/MacOS/steward"), "version")
	if e != nil {
		return nil, e
	}
	p.OldCommit = strings.TrimSpace(string(oldCommit))
	if v, e := backendVersion(p); e == nil {
		p.OldCommit = v
	} else {
		return nil, fmt.Errorf("无法确认当前后台版本，未准备安装：%w", e)
	}
	p.Guards = map[string]string{}
	for _, path := range []string{filepath.Join(home, "config.json"), p.Plist} {
		if path == "" {
			continue
		}
		if _, e := os.Stat(path); os.IsNotExist(e) {
			continue
		}
		digest, e := DigestTree(path)
		if e != nil {
			return nil, e
		}
		p.Guards[path] = digest
	}
	stage := filepath.Join(work, "unpacked/Session Steward.app")
	if e := ValidateBundle(stage, m, runtime.GOARCH); e != nil {
		return nil, e
	}
	pairs := [][2]string{{stage, app}}
	// Always align existing stable binaries; don't rewrite Claude/Codex hook entries.
	for _, name := range []string{"steward", "steward-hook", "Session Steward.app"} {
		dst := filepath.Join(home, "bin", name)
		if _, e := os.Lstat(dst); e == nil {
			pairs = append(pairs, [2]string{filepath.Join(stage, "Contents/MacOS", name), dst})
		} else if !errors.Is(e, os.ErrNotExist) {
			return nil, e
		}
	}
	stagedDirs := []string{}
	prepared := false
	defer func() {
		if !prepared {
			for _, dir := range stagedDirs {
				_ = os.RemoveAll(dir)
			}
		}
	}()
	for _, pair := range pairs {
		if e := plainPath(pair[1]); e != nil {
			return nil, e
		}
		parentDir := filepath.Dir(pair[1])
		dir, e := os.MkdirTemp(parentDir, ".steward-update-")
		if e != nil {
			return nil, fmt.Errorf("安装目录不可写或空间不足：%w", e)
		}
		stagedDirs = append(stagedDirs, dir)
		r := Replacement{Target: pair[1], Staged: filepath.Join(dir, "new"), Backup: filepath.Join(dir, "old")}
		if _, e = os.Lstat(r.Target); e == nil {
			r.Existed = true
		} else if !errors.Is(e, os.ErrNotExist) {
			return nil, e
		}
		if e = copyTree(pair[0], r.Staged); e != nil {
			return nil, e
		}
		if r.Existed {
			// Retain an existing quarantine attribute; never clear system
			// provenance to make an update launch. Apple may still reject it.
			attrs, e := command("/usr/bin/xattr", r.Target)
			if e != nil {
				return nil, e
			}
			for _, attr := range strings.Fields(string(attrs)) {
				if attr == "com.apple.quarantine" {
					value, e := command("/usr/bin/xattr", "-p", attr, r.Target)
					if e != nil {
						return nil, e
					}
					if _, e = command("/usr/bin/xattr", "-w", attr, strings.TrimSpace(string(value)), r.Staged); e != nil {
						return nil, e
					}
				}
			}
		}
		if r.Existed {
			r.OldDigest, e = DigestTree(r.Target)
			if e != nil {
				return nil, e
			}
		}
		r.NewDigest, e = DigestTree(r.Staged)
		if e != nil {
			return nil, e
		}
		p.Items = append(p.Items, r)
	}
	if e := Save(p); e != nil {
		return nil, e
	}
	prepared = true
	return p, nil
}

type MacHost struct {
	// Test injection keeps integration tests on an isolated launchd label and App.
	run func(string, ...string) ([]byte, error)
}

const launchServicesRegister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

func (h MacHost) command(name string, args ...string) ([]byte, error) {
	if h.run != nil {
		return h.run(name, args...)
	}
	return command(name, args...)
}

func target() string { return fmt.Sprintf("gui/%d/%s", os.Getuid(), service.Label) }
func (h MacHost) Stop(p *Plan) error {
	// App termination stops its owned backend gracefully. During recovery, stop only
	// processes at the exact installed App path (never broad process-name matching).
	if _, e := h.command("/usr/bin/pkill", "-TERM", "-f", "^"+regexpQuote(filepath.Join(p.App, "Contents/MacOS/SessionSteward"))+"( |$)"); e != nil { /* absent is normal */
	}
	if p.Mode == "shared" {
		if _, e := h.command("/bin/launchctl", "print", target()); e == nil {
			if _, e = h.command("/bin/launchctl", "bootout", target()); e != nil {
				return e
			}
			for i := 0; i < 100; i++ {
				if _, e = h.command("/bin/launchctl", "print", target()); e != nil {
					break
				}
				time.Sleep(100 * time.Millisecond)
				if i == 99 {
					return errors.New("后台服务没有停止，安装保持原样")
				}
			}
		}
	}
	for _, base := range []string{filepath.Join(p.App, "Contents/MacOS"), filepath.Join(p.Home, "bin")} {
		path := filepath.Join(base, "Session Steward.app/Contents/MacOS/StewardNotifications")
		pattern := "^" + regexpQuote(path) + "( |$)"
		_, _ = h.command("/usr/bin/pkill", "-TERM", "-f", pattern)
		for i := 0; ; i++ {
			if _, e := h.command("/usr/bin/pgrep", "-f", pattern); e != nil {
				break
			}
			if i == 99 {
				return errors.New("通知助手没有停止，安装保持原样")
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	// Do not mutate files while any backend still holds the listening port.
	for i := 0; i < 100; i++ {
		if !backendResponds(p) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return errors.New("后台仍在响应，未替换文件；请先退出手动启动的后台")
}
func regexpQuote(s string) string {
	r := strings.NewReplacer("\\", "\\\\", ".", "\\.", "+", "\\+", "*", "\\*", "?", "\\?", "(", "\\(", ")", "\\)", "[", "\\[", "]", "\\]", "{", "\\{", "}", "\\}", "^", "\\^", "$", "\\$", "|", "\\|")
	return r.Replace(s)
}
func (h MacHost) Start(p *Plan, rollback bool) error {
	// Re-register the exact installed path after both replacement and recovery.
	// This refreshes URL/document handlers without choosing a default handler.
	if _, e := h.command(launchServicesRegister, "-f", p.App); e != nil {
		return fmt.Errorf("无法重新登记 App 链接：%w", e)
	}
	if p.Mode == "shared" {
		if _, e := h.command("/bin/launchctl", "bootstrap", fmt.Sprintf("gui/%d", os.Getuid()), p.Plist); e != nil {
			return e
		}
	}
	// LaunchServices carries STEWARD_HOME explicitly for isolated App tests too.
	_, e := h.command("/usr/bin/open", "-n", "-a", p.App, "--args", "--steward-home", p.Home, "--update-transaction", p.Work)
	return e
}
func backendResponds(p *Plan) bool {
	c := &http.Client{Timeout: 500 * time.Millisecond}
	r, e := c.Get("http://" + p.Listen + "/api/version")
	if e != nil {
		return false
	}
	r.Body.Close()
	return true
}
func backendVersion(p *Plan) (string, error) {
	token, e := os.ReadFile(filepath.Join(p.Home, "panel.token"))
	if e != nil {
		return "", e
	}
	c := &http.Client{Timeout: time.Second}
	req, e := http.NewRequest("GET", "http://"+p.Listen+"/api/version", nil)
	if e != nil {
		return "", e
	}
	req.Header.Set("Cookie", "steward_panel="+strings.TrimSpace(string(token)))
	r, e := c.Do(req)
	if e != nil {
		return "", e
	}
	defer r.Body.Close()
	var v struct{ Commit string }
	if e = json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&v); e != nil {
		return "", e
	}
	if r.StatusCode != 200 || v.Commit == "" {
		return "", errors.New("后台版本接口未通过鉴权")
	}
	return v.Commit, nil
}
func (MacHost) Healthy(p *Plan) error {
	for i := 0; i < 60; i++ {
		if v, e := backendVersion(p); e == nil && v == p.Commit {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return errors.New("后台未通过版本健康检查（30 秒）")
}
