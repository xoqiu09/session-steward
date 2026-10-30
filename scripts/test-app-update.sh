#!/bin/sh
# Explicit isolated macOS integration run; never targets /Applications or ~/.steward.
# Usage: sh scripts/test-app-update.sh /absolute/external-scratch-directory
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out=${1:?Pass an absolute directory for synthetic fixtures and build output}
case "$out" in /*) ;; *) echo 'Output must be absolute' >&2; exit 1;; esac
mkdir -p "$out/logs" "$out/tmp"
cd "$repo"
# No production signing identity participates in this fixture.
UPDATE_PUBLIC_KEY='' APP_OUT="$out/app" sh scripts/build-app.sh arm64 >"$out/logs/build.log" 2>&1
TMPDIR="$out/tmp" SS_UPDATE_TEST_NATIVE=1 SS_UPDATE_TEST_INTERNAL_HOME=1 SS_UPDATE_TEST_LAUNCHSERVICES=1 SS_UPDATE_TEST_BUNDLE="$out/app/Session Steward.app" \
 go test -timeout 180s ./internal/updater -run TestMacIsolatedInstall -v -count=1 >"$out/logs/integration.log" 2>&1
xcrun swiftc -swift-version 5 native/app/Paths.swift native/tests/paths/main.swift -o "$out/paths-test"
fixture=$(mktemp -d "$out/paths.XXXXXX")
"$out/paths-test" "$fixture" >"$out/logs/paths.log" 2>&1
cat "$out/logs/integration.log" "$out/logs/paths.log"
