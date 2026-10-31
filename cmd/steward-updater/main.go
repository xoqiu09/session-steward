// steward-updater is copied outside the App before installation, so replacing
// the bundle never replaces the running installer. JSON lines drive native UI.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"github.com/xoqiu09/session-steward/internal/store"
	"github.com/xoqiu09/session-steward/internal/updater"
)

func emit(v any) { _ = json.NewEncoder(os.Stdout).Encode(v) }
func main() {
	if e := run(); e != nil {
		emit(map[string]any{"event": "error", "message": e.Error()})
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) < 2 {
		return errors.New("用法：steward-updater info|check|prepare|apply|recover")
	}
	build, _ := strconv.ParseInt(updater.Build, 10, 64)
	client := updater.NewClient()
	switch os.Args[1] {
	case "info":
		emit(map[string]any{"Version": updater.Version, "Build": build, "Arch": runtime.GOARCH, "Schema": store.SchemaVersion(), "Key": updater.PublicKey})
		return nil
	case "check":
		// 没有固定公钥的构建（源码打包、未签名的 Release）不做 App 内升级，直接说去哪里下载新版。
		if updater.PublicKey == "" {
			return errors.New(updater.ManualUpdateHint)
		}
		raw, e := client.Fetch(context.Background())
		if e != nil {
			return e
		}
		m, e := client.Verify(raw)
		if e != nil {
			return e
		}
		major := osMajor()
		if e = m.Eligible(build, store.SchemaVersion(), runtime.GOARCH, major); e != nil {
			return e
		}
		emit(map[string]any{"event": "available", "manifest": json.RawMessage(raw), "version": m.Version, "notes": m.Notes, "build": m.Build})
		return nil
	case "prepare":
		// app, data home, service mode, parent PID, signed envelope path
		if len(os.Args) != 7 {
			return errors.New("prepare 参数不完整")
		}
		raw, e := os.ReadFile(os.Args[6])
		if e != nil {
			return e
		}
		m, e := client.Verify(raw)
		if e != nil {
			return e
		}
		if e = m.Eligible(build, store.SchemaVersion(), runtime.GOARCH, osMajor()); e != nil {
			return e
		}
		parent, e := strconv.Atoi(os.Args[5])
		if e != nil || parent < 2 {
			return errors.New("App 进程编号无效")
		}
		root := filepath.Join(os.Args[3], "updates")
		if e = os.MkdirAll(root, 0700); e != nil {
			return e
		}
		work, e := os.MkdirTemp(root, "install-")
		if e != nil {
			return e
		}
		ready := false
		defer func() {
			if !ready {
				_ = os.RemoveAll(work)
			}
		}()
		archive := filepath.Join(work, "download.zip")
		last := time.Time{}
		e = client.Download(context.Background(), m.Assets[runtime.GOARCH], archive, func(n, total int64) {
			if time.Since(last) > 100*time.Millisecond || n == total {
				emit(map[string]any{"event": "progress", "received": n, "total": total})
				last = time.Now()
			}
		})
		if e != nil {
			return e
		}
		if e = updater.Extract(archive, filepath.Join(work, "unpacked")); e != nil {
			return e
		}
		p, e := updater.Prepare(os.Args[2], os.Args[3], os.Args[4], work, parent, m)
		if e != nil {
			return e
		}
		// Put a stable signed copy of this trusted helper alongside the journal.
		exe, e := os.Executable()
		if e != nil {
			return e
		}
		b, e := os.ReadFile(exe)
		if e != nil {
			return e
		}
		helper := filepath.Join(work, "steward-updater")
		if e = os.WriteFile(helper, b, 0700); e != nil {
			return e
		}
		ready = true
		emit(map[string]any{"event": "ready", "plan": filepath.Join(p.Work, "transaction.json"), "helper": helper})
		return nil
	case "apply", "recover":
		if len(os.Args) != 3 {
			return errors.New("需要本次事务记录路径")
		}
		b, e := os.ReadFile(os.Args[2])
		if e != nil {
			return e
		}
		var p updater.Plan
		if e = json.Unmarshal(b, &p); e != nil {
			return e
		}
		if filepath.Join(p.Work, "transaction.json") != os.Args[2] {
			return errors.New("事务记录位置不匹配")
		}
		unlock, e := updater.Lock(p.Home)
		if e != nil {
			return e
		}
		defer unlock()
		log, e := os.OpenFile(filepath.Join(p.Work, "install.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		defer log.Close()
		// Wait for the initiating App to exit before stopping services or replacing files.
		// kill(0) is implemented in per-platform files for cross-build compatibility.
		if os.Args[1] == "apply" {
			for i := 0; i < 300 && processAlive(p.Parent); i++ {
				time.Sleep(100 * time.Millisecond)
			}
			if processAlive(p.Parent) {
				return errors.New("App 尚未退出，未开始安装")
			}
			e = updater.Apply(&p, updater.MacHost{})
		} else {
			e = updater.Recover(&p, updater.MacHost{})
		}
		if e != nil {
			fmt.Fprintln(log, e)
			return e
		}
		fmt.Fprintln(log, p.State)
		return nil
	}
	return errors.New("未知升级命令")
}
func osMajor() int { // Go's current runtime doesn't expose ProductVersion.
	b, e := systemVersion()
	if e != nil {
		return 0
	}
	var major int
	_, _ = fmt.Sscanf(string(b), "%d", &major)
	return major
}
