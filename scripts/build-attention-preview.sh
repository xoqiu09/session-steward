#!/bin/sh
# Build an isolated native UI fixture; never starts steward or reads its configuration.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
: "${1:?provide an output directory}"
app="$1/SS Attention Preview.app"
mkdir -p "$app/Contents/MacOS"
xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macos13.0" -O -framework AppKit -framework SwiftUI -framework QuartzCore \
  "$repo/native/shared/PanelLink.swift" "$repo/native/app/AttentionData.swift" "$repo/native/app/AttentionSurface.swift" \
  "$repo/native/tests/AttentionPreview.swift" -o "$app/Contents/MacOS/AttentionPreview"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.github.xoqiu09.session-steward.attention-preview</string>
<key>CFBundleName</key><string>SS 提醒预览</string>
<key>CFBundleExecutable</key><string>AttentionPreview</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
PLIST
codesign --force --sign - "$app"
printf '%s\n' "$app"
