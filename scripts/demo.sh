#!/usr/bin/env bash
# 在隔离的 STEWARD_HOME 中灌入演示数据：真实 Git 仓库 + 通过 steward-hook 发送的模拟 hook 事件。
# 用法：STEWARD_HOME=/tmp/steward-demo scripts/demo.sh   （服务需已用同一个 STEWARD_HOME 启动）
set -euo pipefail
: "${STEWARD_HOME:?请设置 STEWARD_HOME，避免写入真实数据目录}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$ROOT/bin/steward-hook"
DEMO="$STEWARD_HOME/repos"
PORT="$(python3 -c 'import json,os;print(json.load(open(os.environ["STEWARD_HOME"]+"/config.json"))["listen"])' 2>/dev/null || echo 127.0.0.1:7788)"
PANEL="$(cat "$STEWARD_HOME/panel.token")"
api() { curl -sf -X "$1" "http://$PORT$2" -H 'X-Steward: 1' -H 'Content-Type: application/json' -b "steward_panel=$PANEL" ${3:+-d "$3"} >/dev/null || echo "  (api $1 $2 失败)"; }

mkrepo() {
  local d="$DEMO/$1"; rm -rf "$d"; mkdir -p "$d"
  git -C "$d" init -q -b main
  echo "# $1" > "$d/README.md"; git -C "$d" add . ; git -C "$d" -c user.name=demo -c user.email=d@d commit -qm init
}
branch_commit() { # repo branch file
  local d="$DEMO/$1"
  git -C "$d" checkout -q -B "$2" main
  echo "$3 $(date +%s%N)" > "$d/$3"; git -C "$d" add .; git -C "$d" -c user.name=demo -c user.email=d@d commit -qm "$3"
  git -C "$d" checkout -q main
}
hook() { # provider event session cwd [extra-json]
  local extra="${5:-}"
  printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s"%s}' "$3" "$4" "$2" "${extra:+,$extra}" | "$HOOK" "$1" "$2"
}

mkrepo quant; mkrepo docs-site; mkrepo market-feed
for b in feat/QUA-215-hdd feat/QUA-217-aapl-overlay feat/QUA-228-pullback; do branch_commit quant "$b" "${b//\//_}"; done
for b in fix/DOC-036-testflight feat/DOC-045-redesign; do branch_commit docs-site "$b" "${b//\//_}"; done
branch_commit market-feed feat/MKT-014-offline offline.go

sleep 0.3
Q=$DEMO/quant; A=$DEMO/docs-site; M=$DEMO/market-feed
# 先让会话出现，仓库被登记
hook claude SessionStart cq1 "$Q"; hook codex SessionStart cx1 "$Q"; hook claude SessionStart ca1 "$A"
hook codex SessionStart cm1 "$M"; hook claude SessionStart cm2 "$M"; hook codex SessionStart cfree "$A"
sleep 0.3
ids=$(curl -sf "http://$PORT/api/snapshot" -b "steward_panel=$PANEL" | python3 -c 'import json,sys;print(" ".join(f"{r["name"]}={r["id"]}" for r in json.load(sys.stdin)["repos"]))')
rid() { for kv in $ids; do if [[ ${kv%%=*} == "$1" ]]; then echo "${kv#*=}"; fi; done; }
RQ=$(rid quant); RA=$(rid docs-site); RM=$(rid market-feed)

item() { api POST /api/work-items "{\"id\":\"$1\",\"title\":\"$2\",\"repo_id\":$3,\"branch\":\"$4\",\"acceptance\":\"$5\"}"; }
item QUA-210 "Tick 数据存储改为分片" "$RQ" "" "回放 1 天数据 < 3s"
item QUA-215 "Sorted tick layout: fragment HDD reads" "$RQ" feat/QUA-215-hdd "顺序读吞吐提升 2 倍"
item QUA-217 "AAPL 持股叠加回测" "$RQ" feat/QUA-217-aapl-overlay "回测报告含基准对比"
item QUA-228 "strategy-13 强势股回调买入" "$RQ" feat/QUA-228-pullback "胜率与回撤写入报告"
item QUA-230 "回测报告统一模板" "$RQ" "" ""
item QUA-231 "实盘信号推送 Telegram" "$RQ" "" ""
item DOC-036 "Say that TestFlight builds look up a flight" "$RA" fix/DOC-036-testflight ""
item DOC-045 "Redesign the site in black and white" "$RA" feat/DOC-045-redesign "首页、定价页、文档页"
item DOC-050 "Pricing 页 A/B 测试" "$RA" "" ""
item MKT-014 "行情页断网后显示明确状态并能恢复" "$RM" feat/MKT-014-offline "断网 5 秒内显示离线；恢复后自动重连并补齐"
item MKT-015 "行情 WebSocket 重连退避" "$RM" "" ""
item MKT-016 "下单前风控二次确认" "$RM" "" ""
api POST /api/work-items '{"id":"MKT-017","title":"调研：券商行情源对比","repo_id":'"$RM"',"needs_merge":false}'

api POST /api/deps '{"upstream":"QUA-210","downstream":"QUA-215","cond":"merged"}'
api POST /api/deps '{"upstream":"QUA-217","downstream":"QUA-230"}'
api POST /api/deps '{"upstream":"QUA-228","downstream":"QUA-230"}'
api POST /api/deps '{"upstream":"QUA-230","downstream":"QUA-231"}'
api POST /api/deps '{"upstream":"MKT-015","downstream":"MKT-014"}'
api POST /api/deps '{"upstream":"MKT-017","downstream":"MKT-015"}'
api POST /api/deps '{"upstream":"DOC-045","downstream":"DOC-050","cond":"merged"}'

# 会话活动：显式标识 → 归属；工具调用；权限请求（后台等待面板）；求助；交付
hook claude UserPromptSubmit cq1 "$Q" '"prompt":"继续 #QUA-215，先跑基准"'
hook claude PreToolUse cq1 "$Q" '"tool_name":"Bash","tool_input":{"command":"go test -bench . ./storage"}'
hook codex UserPromptSubmit cx1 "$Q" '"prompt":"做 #QUA-217"'
hook codex PostToolUse cx1 "$Q" '"tool_name":"apply_patch","tool_input":{"path":"backtest/overlay.py"}'
hook claude UserPromptSubmit ca1 "$A" '"prompt":"#DOC-045 改首页"'
hook codex UserPromptSubmit cm1 "$M" '"prompt":"#MKT-014 断网状态"'
hook claude UserPromptSubmit cm2 "$M" '"prompt":"#MKT-016 风控确认"'
hook codex UserPromptSubmit cfree "$A" '"prompt":"看下 CI 为什么挂了"'

(cd "$Q" && "$HOOK" deliver --session cx1 --provider codex "回测完成，报告在 reports/aapl.html" >/dev/null)
(cd "$Q" && "$HOOK" claim QUA-228 --session cq1 --provider claude >/dev/null) || true
(cd "$A" && "$HOOK" deliver --session ca1 --provider claude "首页和定价页已改成黑白" >/dev/null)
(cd "$M" && "$HOOK" ask --session cm1 --provider codex "断网提示放顶部横幅还是行情表内？" >/dev/null)
hook claude Stop cm2 "$M" '"last_assistant_message":"风控确认弹窗已加好，要不要同时加二次密码？"'

# QUA-215 与 DOC-036 进入待验收
api PATCH /api/work-items/QUA-215 '{"status":"review"}'
api PATCH /api/work-items/DOC-036 '{"status":"review"}'
api PATCH /api/work-items/QUA-228 '{"status":"review"}'
api PATCH /api/work-items/MKT-017 '{"status":"done"}'
api PATCH /api/work-items/QUA-231 '{"status":"blocked"}'

# 权限请求：后台挂起，等待在面板上处理
( hook claude PermissionRequest cq1 "$Q" '"tool_name":"Bash","tool_input":{"command":"rm -rf data/cache && make bench"}' > "$STEWARD_HOME/perm1.out" 2>&1 ) &
( hook codex PermissionRequest cm1 "$M" '"tool_name":"Bash","tool_input":{"command":"curl -s https://api.example.com/quotes"}' > "$STEWARD_HOME/perm2.out" 2>&1 ) &
sleep 0.5
api POST /api/scan/merges
echo "演示数据已写入。两个权限请求在后台等待面板决定（输出写到 \$STEWARD_HOME/perm*.out）。"
