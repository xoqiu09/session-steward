//go:build !(darwin || linux || freebsd || openbsd || netbsd || dragonfly)

package core

import (
	"os/exec"
	"time"
)

// 非 Unix 平台保留 CommandContext 的直接进程取消语义，不声称回收任意子进程。
func configureChildProcess(cmd *exec.Cmd) { cmd.WaitDelay = time.Second }
