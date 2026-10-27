#!/bin/sh
# 用隔离数据目录启动演示服务（不影响 ~/.steward）：端口 7799，不扫描本机的历史会话。
export STEWARD_HOME=/tmp/steward-demo
mkdir -p "$STEWARD_HOME"
[ -f "$STEWARD_HOME/config.json" ] || echo '{"listen":"127.0.0.1:7799","history_days":0}' > "$STEWARD_HOME/config.json"
exec "$(dirname "$0")/../bin/steward" serve </dev/null
