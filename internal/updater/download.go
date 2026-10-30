package updater

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type progressWriter struct {
	w        io.Writer
	n, total int64
	progress func(int64, int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, e := p.w.Write(b)
	p.n += int64(n)
	if p.progress != nil {
		p.progress(p.n, p.total)
	}
	return n, e
}

// Download starts afresh on retry. Partial data is never reused or extracted.
func (c *Client) Download(ctx context.Context, a Asset, dst string, progress func(int64, int64)) error {
	r, e := c.get(ctx, a.URL)
	if e != nil {
		return e
	}
	defer r.Body.Close()
	f, e := os.OpenFile(dst, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	ok := false
	defer func() {
		f.Close()
		if !ok {
			os.Remove(dst)
		}
	}()
	h := sha256.New()
	p := &progressWriter{w: io.MultiWriter(f, h), total: a.Size, progress: progress}
	n, e := io.Copy(p, io.LimitReader(r.Body, a.Size+1))
	if e != nil {
		return e
	}
	if n != a.Size || hex.EncodeToString(h.Sum(nil)) != a.SHA256 {
		return errors.New("安装包大小或 SHA-256 不匹配，已删除下载；请重试")
	}
	if e = f.Sync(); e != nil {
		return e
	}
	ok = true
	return nil
}

// Extract only ordinary files/directories in one known bundle. No zip traversal,
// symlinks, duplicate entries, devices, oversized payloads, or executable extras.
func Extract(archive, dest string) error {
	z, e := zip.OpenReader(archive)
	if e != nil {
		return e
	}
	defer z.Close()
	var total uint64
	seen := map[string]bool{}
	if len(z.File) > 10000 {
		return errors.New("安装包文件过多")
	}
	for _, f := range z.File {
		name := f.Name
		if strings.HasPrefix(name, "__MACOSX/") {
			continue
		} // ditto resource metadata, never installed
		clean := filepath.Clean(name)
		if strings.Contains(name, "\\") || strings.HasPrefix(name, "/") || (clean != "Session Steward.app" && !strings.HasPrefix(clean, "Session Steward.app/")) || clean != strings.TrimSuffix(name, "/") || seen[clean] {
			return fmt.Errorf("不安全的安装包路径：%q", name)
		}
		seen[clean] = true
		if f.Mode()&os.ModeSymlink != 0 || (!f.FileInfo().IsDir() && !f.Mode().IsRegular()) {
			return errors.New("安装包含不支持的特殊文件")
		}
		total += f.UncompressedSize64
		if total > 1<<30 {
			return errors.New("解压大小超过限制")
		}
		path := filepath.Join(dest, clean)
		if f.FileInfo().IsDir() {
			if e = os.MkdirAll(path, 0755); e != nil {
				return e
			}
			continue
		}
		if e = os.MkdirAll(filepath.Dir(path), 0755); e != nil {
			return e
		}
		if e = extractFile(f, path); e != nil {
			return e
		}
	}
	return nil
}
func extractFile(z *zip.File, path string) error {
	r, e := z.Open()
	if e != nil {
		return e
	}
	defer r.Close()
	f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, z.Mode().Perm()&0755)
	if e != nil {
		return e
	}
	_, e = io.Copy(f, io.LimitReader(r, 1<<30))
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	return ce
}
