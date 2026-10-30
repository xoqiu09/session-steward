#!/bin/sh
# 打包 macOS 预编译版本：scripts/release.sh v0.3.0
# 产物在 dist-release/：每个架构一个命令行 tar.gz（steward、steward-hook、通知助手）和一个 App zip，外加 SHA256SUMS。
# web/dist 已提交在仓库里，这里不需要 Node。通知助手需要 Xcode 命令行工具，没有时跳过（通知退回旧方式）。
set -eu
version=${1:?用法: scripts/release.sh <版本号，例如 v0.3.0>}
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out=${RELEASE_OUT:-"$repo/dist-release"}
rm -rf "$out"
mkdir -p "$out"
cd "$repo"
# Releases must explicitly advance this ordinal; semantic versions and commits are separate.
: "${UPDATE_BUILD:?Set UPDATE_BUILD to a new monotonically increasing release ordinal}"
for arch in arm64 amd64; do
	name="session-steward_${version}_darwin_${arch}"
	dir="$out/$name"
	mkdir -p "$dir"
	CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.BuildCommit=$(git -C "$repo" rev-parse HEAD)" -o "$dir/" ./cmd/steward ./cmd/steward-hook
	if command -v xcrun >/dev/null 2>&1; then
		target=$([ "$arch" = amd64 ] && echo x86_64 || echo arm64)
		NOTIFIER_TARGET=$target sh scripts/build-notifier.sh "$dir/Session Steward.app" >/dev/null
	fi
	cp LICENSE "$dir/"
	# 变量后紧跟全角字符时要加花括号：macOS 自带的 bash 3.2 在 en_US.UTF-8 下会把它当成变量名的一部分
	cat > "$dir/安装说明.txt" <<TXT
Session Steward ${version}（macOS ${arch}，未签名）

1. 把这个文件夹放在一个长期不动的位置（不要放在“文稿”“桌面”“下载”里），例如 ~/.local/share/session-steward。
2. ./steward install          # 给 Claude Code / Codex 加 hooks（只追加自己的条目，先备份）
3. ./steward service install  # 登录后自动启动，后台常驻 127.0.0.1:7788
4. ./steward open             # 打开面板；小镇在 ?view=town，世界地图在 ?kiosk=1&world=1

卸载：./steward service uninstall && ./steward uninstall
更多：https://github.com/xoqiu09/session-steward
TXT
	tar -C "$out" -czf "$out/$name.tar.gz" "$name"
	rm -rf "$dir"
	# App 版：拖进“应用程序”就能用（需要 Xcode 命令行工具）
	if command -v xcrun >/dev/null 2>&1; then
		APP_OUT="$out/app-$arch" sh scripts/build-app.sh "$arch" "$version" >/dev/null
		ditto -c -k --keepParent "$out/app-$arch/Session Steward.app" "$out/Session-Steward_${version}_macOS_${arch}.app.zip"
		rm -rf "$out/app-$arch"
	fi
done
(cd "$out" && shasum -a 256 ./*.tar.gz ./*.zip 2>/dev/null | sed 's#\./##' > SHA256SUMS)
cat "$out/SHA256SUMS"

# Without a configured signing identity, packages are still manual downloads.
# No private key or secret is generated or uploaded by this script.
if [ -n "${UPDATE_SIGNING_KEY_FILE:-}" ]; then
 : "${UPDATE_PUBLIC_KEY:?Set the public key pinned in the distributed App}"
 : "${UPDATE_NOTES_FILE:?Set a UTF-8 release notes file}"
 go run ./cmd/steward-update-manifest -version "$version" -build "$UPDATE_BUILD" -commit "$(git -C "$repo" rev-parse HEAD)" -dir "$out" -notes "$UPDATE_NOTES_FILE"
else
 echo "No update signing key supplied: no in-app update manifest was produced." >&2
fi
