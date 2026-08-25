#!/usr/bin/env bash
set -euo pipefail

readonly STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/openclaw-resource-guard"
readonly LOG_TAG="openclaw-resource-guard"
readonly ALERT_COOLDOWN_SECONDS=1800
readonly BROWSER_COUNT_LIMIT=16
readonly BROWSER_RSS_LIMIT_KB=$((4 * 1024 * 1024))
readonly AVAILABLE_MEMORY_LIMIT_KB=$((2 * 1024 * 1024))
readonly AUTOMATION_PATTERN='chrome-headless-shell|chromium.*--headless|chrome.*--headless|--remote-debugging-port|puppeteer|playwright|camoufox'

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/guard.lock"
flock -n 9 || exit 0

available_kb=$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo)
mapfile -t browser_rows < <(ps -eo pid=,rss=,args= | awk -v pattern="$AUTOMATION_PATTERN" '
  BEGIN { IGNORECASE=1 }
  $0 ~ pattern { pid=$1; rss=$2; $1=""; $2=""; sub(/^ +/, ""); print pid "\t" rss "\t" $0 }
')

browser_count=${#browser_rows[@]}
browser_rss_kb=0
browser_pids=()
for row in "${browser_rows[@]}"; do
  IFS=$'\t' read -r pid rss _ <<<"$row"
  browser_pids+=("$pid")
  browser_rss_kb=$((browser_rss_kb + rss))
done

if (( browser_count < BROWSER_COUNT_LIMIT \
  && browser_rss_kb < BROWSER_RSS_LIMIT_KB \
  && available_kb >= AVAILABLE_MEMORY_LIMIT_KB )); then
  exit 0
fi

message="OpenClaw 资源预警：自动化浏览器 ${browser_count} 个，占用 $((browser_rss_kb / 1024)) MiB，可用内存 $((available_kb / 1024)) MiB。正在清理自动化浏览器，普通浏览器不受影响。"
logger -t "$LOG_TAG" -- "$message"

now=$(date +%s)
last_alert=$(cat "$STATE_DIR/last-alert-at" 2>/dev/null || printf '0')
if (( now - last_alert >= ALERT_COOLDOWN_SECONDS )); then
  printf '%s\n' "$now" > "$STATE_DIR/last-alert-at"
  config="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
  if [[ -r "$config" ]]; then
    mapfile -t targets < <(python3 - "$config" <<'PY'
import json, sys
q = ((json.load(open(sys.argv[1])).get("channels") or {}).get("qqbot") or {}).get("customRuntime") or {}
for admin in q.get("admins") or []:
    if admin:
        print(str(admin))
group = q.get("adminGroup")
if group:
    print("group:" + str(group))
PY
)
    for target in "${targets[@]}"; do
      timeout 20s openclaw message send --channel qqbot --target "$target" --message "$message" >/dev/null 2>&1 || true
    done
  fi
fi

if (( browser_count > 0 )); then
  kill -TERM "${browser_pids[@]}" 2>/dev/null || true
  sleep 5
  remaining=()
  for pid in "${browser_pids[@]}"; do
    kill -0 "$pid" 2>/dev/null && remaining+=("$pid")
  done
  if (( ${#remaining[@]} > 0 )); then
    kill -KILL "${remaining[@]}" 2>/dev/null || true
  fi
fi
