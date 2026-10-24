//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package core

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
	"time"
)

// 检查/摘要命令常由 shell 启动；超时或服务退出时须同时回收其子进程。
func configureChildProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = time.Second
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}
