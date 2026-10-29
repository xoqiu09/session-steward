#!/bin/sh
# Pure navigation/state/geometry checks. No service, real data, notification or App is opened.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out=$(mktemp -d "${TMPDIR:-/tmp}/steward-native-check.XXXXXX")
trap 'rm -rf "$out"' EXIT HUP INT TERM
xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macos13.0" "$repo"/native/shared/*.swift "$repo/native/tests/PanelLinkTests.swift" -o "$out/links"
"$out/links"
xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macos13.0" "$repo/native/shared/PanelLink.swift" "$repo/native/app/AttentionData.swift" "$repo/native/tests/AttentionTests.swift" -o "$out/attention"
"$out/attention"
