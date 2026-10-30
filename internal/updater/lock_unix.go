//go:build !windows

package updater

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// Lock serializes installers and releases automatically if a helper crashes.
func Lock(home string) (func(), error) {
	f, e := os.OpenFile(filepath.Join(home, "updates", "install.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if e != nil {
		return nil, e
	}
	if e = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); e != nil {
		f.Close()
		return nil, fmt.Errorf("另一个升级或恢复仍在运行，请稍后重试：%w", e)
	}
	return func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN); _ = f.Close() }, nil
}
