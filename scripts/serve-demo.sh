#!/bin/sh
# 用隔离数据目录启动演示服务（不影响 ~/.steward）
export STEWARD_HOME=/tmp/steward-demo
exec "$(dirname "$0")/../bin/steward" serve </dev/null
