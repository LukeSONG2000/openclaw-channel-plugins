#!/usr/bin/env bash
set -euo pipefail
umask 077

workspace=$(realpath "${1:?path to prepared probe workspace}")
source=$(realpath "${2:?path to pinned upstream Honcho checkout}")
probe="$(dirname "$(realpath "$0")")/honcho_persistence_probe.py"
python="$source/.venv/bin/python"
pod=luke-honcho-probe
database=luke-honcho-probe-pg

test "$(git -C "$source" rev-parse HEAD)" = 894b88321872e01702a1aa638ddfdde6ad60f173
test "$(podman pod inspect "$pod" --format '{{.InfraConfig.HostNetwork}} {{.InfraConfig.PortBindings}}')" = 'false map[]'
test "$(podman inspect "$database" --format '{{.Pod}}')" = "$(podman pod inspect "$pod" --format '{{.Id}}')"
cd "$source"

# Run without inherited model or service credentials and without any external interfaces.
runtime=(env -i "PATH=$PATH" "HOME=$workspace" "PYTHONPATH=$source/sdks/python/src:$source"
  "TIKTOKEN_CACHE_DIR=$workspace/token-cache" PYTHONDONTWRITEBYTECODE=1
  DB_CONNECTION_URI=postgresql+psycopg://postgres@127.0.0.1:5432/honcho_sandbox
  CACHE_ENABLED=false AUTH_USE_AUTH=false PYTHON_DOTENV_DISABLED=1 HONCHO_CONFIG_TOML_DISABLED=1
  LLM_OPENAI_API_KEY=fixture-only LLM_OPENAI_BASE_URL=http://127.0.0.1:18080/v1
  EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://127.0.0.1:18080/v1)

use_namespace() {
  local pid links
  pid=$(podman inspect -f '{{.State.Pid}}' "$database")
  runner=(podman unshare nsenter -t "$pid" -n)
  links=$("${runner[@]}" ip -j link show | jq -er 'map(.ifname) | join(",")')
  test "$links" = lo
  for _ in {1..20}; do
    if podman exec "$database" pg_isready -q -h 127.0.0.1 -U postgres -d honcho_sandbox; then return; fi
    sleep 1
  done
  return 1
}

stop_services() {
  local pid
  for pid in "${api:-}" "${mock:-}"; do
    if [[ -n "$pid" ]]; then kill "$pid" 2>/dev/null || true; fi
  done
  wait "${api:-0}" "${mock:-0}" 2>/dev/null || true
  api=''
  mock=''
}
trap stop_services EXIT

start_services() {
  "${runner[@]}" "${runtime[@]}" timeout 90 "$python" -m uvicorn src.mock_provider.main:app \
    --host 127.0.0.1 --port 18080 >"$workspace/mock.log" 2>&1 &
  mock=$!
  "${runner[@]}" "${runtime[@]}" timeout 90 "$python" -m uvicorn src.main:app \
    --host 127.0.0.1 --port 8000 >"$workspace/api.log" 2>&1 &
  api=$!
  for _ in {1..25}; do
    if "${runner[@]}" curl -fs --max-time 2 http://127.0.0.1:18080/health >/dev/null &&
      "${runner[@]}" curl -fs --max-time 2 http://127.0.0.1:8000/health >/dev/null; then return; fi
    sleep 1
  done
  tail -30 "$workspace/api.log"
  return 1
}

podman pod start "$pod" >/dev/null
use_namespace
"${runner[@]}" "${runtime[@]}" timeout 45 "$python" scripts/provision_db.py >"$workspace/migrate.log" 2>&1 ||
  { tail -30 "$workspace/migrate.log"; exit 1; }
start_services
run_id="$(date +%s)-$$"
"${runner[@]}" "${runtime[@]}" timeout 30 "$python" "$probe" seed "$run_id"
stop_services
podman pod restart "$pod" >/dev/null
use_namespace
start_services
"${runner[@]}" "${runtime[@]}" timeout 30 "$python" "$probe" verify "$run_id"

if [[ -n "${LUKE_HONCHO_FIXTURE_NODE:-}" ]]; then
  adapter_test="$(dirname "$probe")/../member-memory.test.mjs"
  "${runner[@]}" "${runtime[@]}" LUKE_HONCHO_FIXTURE=1 timeout 30 \
    "$LUKE_HONCHO_FIXTURE_NODE" --test --test-name-pattern='self-hosted Honcho' "$adapter_test"
fi
