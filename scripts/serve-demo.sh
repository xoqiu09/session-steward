#!/bin/sh
# Compatibility entry point: one isolated demo, never the normal user service.
set -eu
exec "$(dirname "$0")/demo.sh" "$@"
