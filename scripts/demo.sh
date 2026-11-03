#!/bin/sh
# One process, one new data directory. No hooks, Python, curl or Git required at runtime.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=${STEWARD_BIN:-"$root/bin/steward"}
if [ ! -x "$binary" ]; then
  echo "先在源码目录运行：go build -o bin/steward ./cmd/steward" >&2
  echo "也可以用 STEWARD_BIN 指定包含 demo 命令的 steward 程序。" >&2
  exit 1
fi
exec "$binary" demo "$@"
