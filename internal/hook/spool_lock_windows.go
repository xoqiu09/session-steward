//go:build windows

package hook

import (
	"os"

	"golang.org/x/sys/windows"
)

// 锁住文件首字节即可，所有 hook 进程使用同一个锁文件。
func lockFile(f *os.File) error {
	return windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, new(windows.Overlapped))
}

func unlockFile(f *os.File) {
	windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, new(windows.Overlapped))
}
