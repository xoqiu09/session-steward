#!/bin/sh
# 打包 macOS App：scripts/build-app.sh [arm64|amd64] [版本号]
# 产物：dist-app/Session Steward.app（App 外壳 + steward + steward-hook + 通知助手），ad-hoc 签名、未公证。
# 只用 Go 和 Xcode 命令行工具里的 swiftc；web/dist 已提交在仓库里。
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
arch=${1:-$( [ "$(uname -m)" = x86_64 ] && echo amd64 || echo arm64 )}
version=${2:-$(/usr/bin/plutil -extract version raw -o - "$repo/native/app/update-version.json")}
build=${UPDATE_BUILD:-$(/usr/bin/plutil -extract build raw -o - "$repo/native/app/update-version.json")}
commit=$(git -C "$repo" rev-parse HEAD)
key=${UPDATE_PUBLIC_KEY:-}
case "$build" in *[!0-9]*|'') echo "UPDATE_BUILD must be a positive integer" >&2; exit 1;; esac
target=$([ "$arch" = amd64 ] && echo x86_64 || echo arm64)
out=${APP_OUT:-"$repo/dist-app"}
app="$out/Session Steward.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cd "$repo"
# 后台程序
CGO_ENABLED=0 GOOS=darwin GOARCH=$arch go build -trimpath -ldflags "-s -w -X main.BuildCommit=$commit -X github.com/xoqiu09/session-steward/internal/updater.Version=${version#v} -X github.com/xoqiu09/session-steward/internal/updater.Build=$build -X github.com/xoqiu09/session-steward/internal/updater.PublicKey=$key" -o "$app/Contents/MacOS/" ./cmd/steward ./cmd/steward-hook ./cmd/steward-updater
# 通知助手：steward 在自己旁边找 “Session Steward.app”
NOTIFIER_TARGET=$target sh scripts/build-notifier.sh "$app/Contents/MacOS/Session Steward.app" >/dev/null
# App 外壳
xcrun swiftc -swift-version 5 -target "$target-apple-macos13.0" -O -framework AppKit -framework WebKit -framework ServiceManagement -framework SwiftUI -framework QuartzCore \
	native/shared/*.swift native/app/*.swift -o "$app/Contents/MacOS/SessionSteward"
cp native/app/Info.plist "$app/Contents/Info.plist"
schema=$(go run ./cmd/steward-updater info | /usr/bin/plutil -extract Schema raw -o - -)
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString ${version#v}" -c "Set :CFBundleVersion $build" -c "Add :StewardSchema integer $schema" "$app/Contents/Info.plist"
cp native/macos/Resources/Steward.icns "$app/Contents/Resources/Steward.icns"
# 由内到外 ad-hoc 签名（未公证；首次打开需要“右键 → 打开”）
codesign --force --sign - "$app/Contents/MacOS/steward" "$app/Contents/MacOS/steward-hook" "$app/Contents/MacOS/steward-updater"
codesign --force --sign - --identifier io.github.xoqiu09.session-steward.app "$app"
printf '%s\n' "$app"
