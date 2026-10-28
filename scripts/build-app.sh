#!/bin/sh
# 打包 macOS App：scripts/build-app.sh [arm64|amd64] [版本号]
# 产物：dist-app/Session Steward.app（App 外壳 + steward + steward-hook + 通知助手），ad-hoc 签名、未公证。
# 只用 Go 和 Xcode 命令行工具里的 swiftc；web/dist 已提交在仓库里。
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
arch=${1:-$( [ "$(uname -m)" = x86_64 ] && echo amd64 || echo arm64 )}
version=${2:-$(git -C "$repo" describe --always --dirty 2>/dev/null || echo dev)}
target=$([ "$arch" = amd64 ] && echo x86_64 || echo arm64)
out=${APP_OUT:-"$repo/dist-app"}
app="$out/Session Steward.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cd "$repo"
# 后台程序
CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.BuildCommit=$version" -o "$app/Contents/MacOS/" ./cmd/...
# 通知助手：steward 在自己旁边找 “Session Steward.app”
NOTIFIER_TARGET=$target sh scripts/build-notifier.sh "$app/Contents/MacOS/Session Steward.app" >/dev/null
# App 外壳
xcrun swiftc -swift-version 5 -target "$target-apple-macos13.0" -O -framework AppKit -framework WebKit -framework ServiceManagement \
	native/app/*.swift -o "$app/Contents/MacOS/SessionSteward"
sed "s#<string>0.0.0</string>#<string>${version#v}</string>#" native/app/Info.plist > "$app/Contents/Info.plist"
cp native/macos/Resources/Steward.icns "$app/Contents/Resources/Steward.icns"
# 由内到外 ad-hoc 签名（未公证；首次打开需要“右键 → 打开”）
codesign --force --sign - "$app/Contents/MacOS/steward" "$app/Contents/MacOS/steward-hook"
codesign --force --sign - --identifier io.github.xoqiu09.session-steward.app "$app"
printf '%s\n' "$app"
