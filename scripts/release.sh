#!/bin/sh
# 打包 macOS 预编译版本：scripts/release.sh v0.3.0
# 产物在 dist-release/：每个架构一个 tar.gz（steward、steward-hook、通知助手 Session Steward.app），外加 SHA256SUMS。
# web/dist 已提交在仓库里，这里不需要 Node。通知助手需要 Xcode 命令行工具，没有时跳过（通知退回旧方式）。
set -eu
version=${1:?用法: scripts/release.sh <版本号，例如 v0.3.0>}
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out="$repo/dist-release"
rm -rf "$out"
mkdir -p "$out"
cd "$repo"
for arch in arm64 amd64; do
	name="session-steward_${version}_darwin_${arch}"
	dir="$out/$name"
	mkdir -p "$dir"
	CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.BuildCommit=$version" -o "$dir/" ./cmd/...
	if command -v xcrun >/dev/null 2>&1; then
		target=$([ "$arch" = amd64 ] && echo x86_64 || echo arm64)
		NOTIFIER_TARGET=$target sh scripts/build-notifier.sh "$dir/Session Steward.app" >/dev/null
	fi
	cp LICENSE "$dir/"
	cat > "$dir/安装说明.txt" <<TXT
Session Steward $version（macOS $arch，未签名）

1. 把这个文件夹放在一个长期不动的位置（不要放在“文稿”“桌面”“下载”里），例如 ~/.local/share/session-steward。
2. ./steward install          # 给 Claude Code / Codex 加 hooks（只追加自己的条目，先备份）
3. ./steward service install  # 登录后自动启动，后台常驻 127.0.0.1:7788
4. ./steward open             # 打开面板；小镇在 ?view=town，世界地图在 ?kiosk=1&world=1

卸载：./steward service uninstall && ./steward uninstall
更多：https://github.com/xoqiu09/session-steward
TXT
	tar -C "$out" -czf "$out/$name.tar.gz" "$name"
	rm -rf "$dir"
done
(cd "$out" && shasum -a 256 ./*.tar.gz | sed 's#\./##' > SHA256SUMS)
cat "$out/SHA256SUMS"
