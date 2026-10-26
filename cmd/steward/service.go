package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"time"

	"github.com/xoqiu09/session-steward/internal/config"
	"github.com/xoqiu09/session-steward/internal/service"
)

// doService 管理后台服务：steward service install [--force] | uninstall | restart | status。
// 目前只支持 macOS launchd（当前用户的 LaunchAgent）。
func doService(sub string) error {
	if runtime.GOOS != "darwin" {
		return errors.New("steward service 目前只支持 macOS（launchd）。Linux 可自行用 systemd --user 运行 steward serve，示例见使用手册“后台常驻”一节")
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	a, err := launchAgent(cfg.Listen)
	if err != nil {
		return err
	}
	out, errLog := a.LogPaths()
	switch sub {
	case "install":
		res, err := a.Install(slices.Contains(os.Args, "--force"))
		if err != nil {
			return err
		}
		fmt.Printf("%s（%s）\n", map[string]string{
			"installed": "已写入并加载 LaunchAgent",
			"updated":   "plist 有变化，已更新并重新加载",
			"loaded":    "plist 未变，已重新加载",
			"unchanged": "已安装且已加载，未改动",
		}[res], a.PlistPath)
		fmt.Printf("  命令：%s serve\n  数据目录：%s\n  监听：%s\n  日志：%s\n        %s\n", a.Binary, a.Home, cfg.Listen, out, errLog)
		fmt.Println("  登录后自动启动，进程退出后由 launchd 重新拉起。重新构建 steward 后运行 steward service restart。")
	case "uninstall":
		res, err := a.Uninstall()
		if err != nil {
			return err
		}
		if res == "absent" {
			fmt.Println("未安装后台服务，没有改动")
			return nil
		}
		fmt.Printf("已停止并移除 LaunchAgent（%s）；日志保留在 %s\n", a.PlistPath, filepath.Dir(out))
	case "restart":
		if err := a.Restart(); err != nil {
			return err
		}
		fmt.Println("已让 launchd 重启服务：", a.Label)
	case "status":
		s := a.Status()
		fmt.Printf("plist：%s（%s）\n", map[string]string{"absent": "不存在", "ours": "由 steward 写入", "foreign": "不是 steward 写入的，steward 不会改动"}[s.Plist], a.PlistPath)
		if !s.Loaded {
			fmt.Println("launchd：未加载")
		} else {
			fmt.Println("launchd：已加载", a.Label)
			for _, d := range s.Detail {
				fmt.Println("  " + d)
			}
		}
		fmt.Printf("日志：%s\n      %s\n", out, errLog)
	default:
		return errors.New("用法: steward service install [--force] | uninstall | restart | status")
	}
	return nil
}

func launchAgent(listen string) (*service.Agent, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	self, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if self, err = filepath.EvalSymlinks(self); err != nil {
		return nil, err
	}
	data, err := filepath.Abs(config.Home())
	if err != nil {
		return nil, err
	}
	a := service.New(home, self, data, service.Env(os.Getenv, data), os.Getuid())
	a.PortInUse = func() bool {
		c, err := net.DialTimeout("tcp", listen, time.Second)
		if err != nil {
			return false
		}
		c.Close()
		return true
	}
	return a, nil
}
