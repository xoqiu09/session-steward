//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func processAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }
func systemVersion() ([]byte, error) {
	return exec.Command("/usr/bin/sw_vers", "-productVersion").Output()
}
