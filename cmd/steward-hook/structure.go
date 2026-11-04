package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/xoqiu09/session-steward/internal/hook"
	"github.com/xoqiu09/session-steward/internal/projectstructure"
)

func structure(ctx context.Context, c *hook.Client, args []string) int {
	file, provider, session, base := "", "", "", ""
	list := false
	for i := 1; i < len(args); i++ {
		if args[i] == "--list" {
			list = true
			continue
		}
		if i+1 >= len(args) {
			fmt.Fprintln(os.Stderr, "参数缺少取值")
			return 2
		}
		switch args[i] {
		case "--file":
			file = args[i+1]
		case "--provider":
			provider = args[i+1]
		case "--session":
			session = args[i+1]
		case "--base-revision":
			base = args[i+1]
		default:
			fmt.Fprintln(os.Stderr, "未知结构参数", args[i])
			return 2
		}
		i++
	}
	if list && file != "" || !list && file == "" {
		fmt.Fprintln(os.Stderr, "用法: structure --list 或 --file 文件.json [--base-revision 当前修订] [--provider P --session ID]")
		return 2
	}
	session, provider = defaultSession(session, provider)
	cwd, _ := os.Getwd()
	var raw json.RawMessage
	action := "read"
	if !list {
		action = "write"
		var input io.Reader = os.Stdin
		if file != "-" {
			f, err := os.Open(file)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				return 2
			}
			defer f.Close()
			input = f
		}
		b, err := io.ReadAll(io.LimitReader(input, projectstructure.MaxBytes+1))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		d, err := projectstructure.Decode(b)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		raw, _ = json.Marshal(d)
	}
	out, err := c.ProjectStructure(ctx, action, provider, session, cwd, base, raw)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(string(out))
	return 0
}
