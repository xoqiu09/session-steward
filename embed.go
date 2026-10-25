// Package steward 只负责嵌入前端构建产物。
package steward

import "embed"

// WebDist 是 web/dist 的构建产物（已提交到仓库，CI 检查与源码一致）。
//
//go:embed all:web/dist
var WebDist embed.FS
