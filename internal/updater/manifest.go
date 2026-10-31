// Package updater implements the signed, user-triggered macOS update protocol.
// Network metadata never supplies commands, local paths, or signing keys.
package updater

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const Repository = "https://github.com/xoqiu09/session-steward"
const Latest = Repository + "/releases/latest/download/update-manifest.json"

var PublicKey string // pinned base64 Ed25519 public key, set at build time; empty fails closed

// ManualUpdateHint 是没有固定公钥（不支持 App 内升级）时给用户的说明。
const ManualUpdateHint = "这个版本不支持在 App 里升级。有新版本时，到 https://github.com/xoqiu09/session-steward/releases 下载新的 App，替换“应用程序”里的旧版即可；数据在 ~/.steward，不受影响。"

var Version = "0.2.0-dev.1"
var Build = "2026102901" // independent, monotonically increasing release ordinal; never a commit hash

var semver = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$`)

type Asset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}
type Manifest struct {
	Format  int              `json:"format"`
	Version string           `json:"version"`
	Build   int64            `json:"build"`
	Commit  string           `json:"commit"`
	Schema  int              `json:"schema"`
	MinOS   int              `json:"min_macos"`
	Notes   string           `json:"notes"`
	Assets  map[string]Asset `json:"assets"`
}
type Envelope struct {
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

type Client struct {
	HTTP       *http.Client
	Key        string
	allowLocal bool
}

func NewClient() *Client {
	return &Client{Key: PublicKey, HTTP: &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if len(via) > 5 || r.URL.Scheme != "https" || !downloadHost(r.URL.Hostname()) {
			return errors.New("更新下载重定向到了不受信任的来源")
		}
		return nil
	}}}
}
func downloadHost(h string) bool {
	return h == "github.com" || h == "api.github.com" || h == "release-assets.githubusercontent.com" || h == "objects.githubusercontent.com"
}
func (c *Client) get(ctx context.Context, address string) (*http.Response, error) {
	u, e := url.Parse(address)
	if e != nil {
		return nil, e
	}
	if !(c.allowLocal && u.Scheme == "http" && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost")) && (u.Scheme != "https" || !downloadHost(u.Hostname()) || u.User != nil) {
		return nil, errors.New("更新仅允许官方 GitHub HTTPS 来源")
	}
	req, e := http.NewRequestWithContext(ctx, "GET", address, nil)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", "Session-Steward-Updater")
	r, e := c.HTTP.Do(req)
	if e != nil {
		return nil, e
	}
	if r.StatusCode != 200 {
		r.Body.Close()
		if r.StatusCode == 404 && address == Latest {
			return nil, errors.New("最新版本没有提供 App 内升级。当前安装保持原样；新版本请到 https://github.com/xoqiu09/session-steward/releases 下载")
		}
		return nil, fmt.Errorf("更新服务器返回 HTTP %d，请稍后重试", r.StatusCode)
	}
	return r, nil
}
func (c *Client) Fetch(ctx context.Context) ([]byte, error) {
	r, e := c.get(ctx, Latest)
	if e != nil {
		return nil, e
	}
	defer r.Body.Close()
	b, e := io.ReadAll(io.LimitReader(r.Body, (1<<20)+1))
	if len(b) > 1<<20 {
		return nil, errors.New("更新清单过大")
	}
	return b, e
}

func (c *Client) Verify(raw []byte) (Manifest, error) {
	var m Manifest
	key, e := base64.StdEncoding.DecodeString(c.Key)
	if e != nil || len(key) != ed25519.PublicKeySize {
		return m, errors.New(ManualUpdateHint)
	}
	var env Envelope
	if e = json.Unmarshal(raw, &env); e != nil {
		return m, e
	}
	payload, e := base64.StdEncoding.DecodeString(env.Payload)
	if e != nil {
		return m, e
	}
	sig, e := base64.StdEncoding.DecodeString(env.Signature)
	if e != nil || !ed25519.Verify(key, payload, sig) {
		return m, errors.New("更新签名不正确，已拒绝下载和安装")
	}
	if e = json.Unmarshal(payload, &m); e != nil {
		return m, e
	}
	if m.Format != 1 || !semver.MatchString(m.Version) || m.Build <= 0 || m.Schema <= 0 || m.MinOS < 13 || m.MinOS > 99 || len(m.Notes) > 64000 || !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(m.Commit) {
		return m, errors.New("签名清单的版本或兼容性字段无效")
	}
	for arch, a := range m.Assets {
		hash, e := hex.DecodeString(a.SHA256)
		if (arch != "arm64" && arch != "amd64") || e != nil || len(hash) != sha256.Size || a.Size <= 0 || a.Size > 512<<20 || !strings.HasPrefix(a.URL, Repository+"/releases/download/v"+m.Version+"/") {
			return m, errors.New("签名清单的下载资产无效")
		}
	}
	return m, nil
}
func (m Manifest) Eligible(current int64, schema int, arch string, osMajor int) error {
	if current <= 0 {
		return errors.New("无法确定当前构建序号；请先安装带升级元数据的新 App，避免降级")
	}
	if m.Build <= current {
		return errors.New("当前已是此发布序列的最新构建，无需重复安装或降级")
	}
	if !semver.MatchString(Version) {
		return errors.New("当前 App 缺少有效语义版本，未安装")
	}
	currentParts := strings.Split(strings.SplitN(Version, "-", 2)[0], ".")
	newParts := strings.Split(strings.SplitN(m.Version, "-", 2)[0], ".")
	for i := 0; i < 3; i++ {
		a, _ := new(big.Int).SetString(newParts[i], 10)
		b, _ := new(big.Int).SetString(currentParts[i], 10)
		if a.Cmp(b) < 0 {
			return errors.New("发布版本早于当前 App，已阻止降级")
		}
		if a.Cmp(b) > 0 {
			break
		}
	}
	if strings.Contains(m.Version, "-") {
		return errors.New("这是预发布版本，本通道仅安装正式版")
	}
	if m.Schema != schema {
		return fmt.Errorf("此更新的数据库版本为 %d，当前为 %d。请按发行说明备份并手动迁移，本次未改动数据", m.Schema, schema)
	}
	if osMajor < m.MinOS {
		return fmt.Errorf("此版本需要 macOS %d 或更高", m.MinOS)
	}
	if _, ok := m.Assets[arch]; !ok {
		return errors.New("此发布没有当前芯片的安装包")
	}
	return nil
}
