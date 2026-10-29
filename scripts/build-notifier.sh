#!/bin/sh
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
app=${1:-"$repo/bin/Session Steward.app"}
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$repo/native/macos/Info.plist" "$app/Contents/Info.plist"
cp "$repo/native/macos/Resources/Steward.icns" "$app/Contents/Resources/Steward.icns"
# Built-in macOS SDK only; no third-party package or network dependency.
xcrun swiftc -swift-version 5 -target "${NOTIFIER_TARGET:-$(uname -m)}-apple-macos12.0" -O -framework AppKit -framework UserNotifications \
  "$repo"/native/shared/*.swift "$repo/native/macos/main.swift" -o "$app/Contents/MacOS/StewardNotifications"
codesign --force --sign - --identifier io.github.xoqiu09.session-steward.notifications "$app"
# 只有本机架构的助手能在这里自检；交叉编译的跳过
if [ "${NOTIFIER_TARGET:-$(uname -m)}" = "$(uname -m)" ]; then "$app/Contents/MacOS/StewardNotifications" --check-links; fi
printf '%s\n' "$app"
