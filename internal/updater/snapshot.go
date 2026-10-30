package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// DigestTree includes names, modes and bytes, but excludes timestamps. It detects
// a second updater or a manually changed installation while the UI was waiting.
func DigestTree(root string) (string, error) {
	h := sha256.New()
	e := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("升级文件含符号链接：%s", path)
		}
		rel, e := filepath.Rel(root, path)
		if e != nil {
			return e
		}
		fmt.Fprintf(h, "%q %d %d\n", rel, info.Mode(), info.Size())
		if info.Mode().IsRegular() {
			f, e := os.Open(path)
			if e != nil {
				return e
			}
			_, e = io.Copy(h, f)
			f.Close()
			return e
		}
		return nil
	})
	return hex.EncodeToString(h.Sum(nil)), e
}
func unchanged(p *Plan) error {
	for _, item := range p.Items {
		for path, want := range map[string]string{item.Target: item.OldDigest, item.Staged: item.NewDigest} {
			if want == "" {
				continue
			}
			got, e := DigestTree(path)
			if e != nil || got != want {
				return fmt.Errorf("准备后安装文件发生变化，请重新检查和下载：%s", path)
			}
		}
	}
	for path, want := range p.Guards {
		got, e := DigestTree(path)
		if e != nil || got != want {
			return fmt.Errorf("准备后配置发生变化，未安装：%s", path)
		}
	}
	return nil
}
