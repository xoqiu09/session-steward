// Package steward 只负责嵌入前端构建产物。
package steward

import "embed"

// WebDist 是 web/dist 的构建产物；未构建时只包含占位文件。
//
//go:embed all:web/dist
var WebDist embed.FS
