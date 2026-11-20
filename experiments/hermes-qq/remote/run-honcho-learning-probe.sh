#!/usr/bin/env bash
set -euo pipefail
umask 077

workspace=$(realpath "${1:?prepared probe workspace}")
source=$(realpath "${2:?pinned Honcho checkout}")
credentials=$(realpath "${3:?Zhipu environment file}")
embedding_args=()
embedding_port=18081
if [[ -n "${4:-}" ]]; then
  embedding_key=$(realpath "$4")
  test "$(stat -c %a "$embedding_key")" = 600
  embedding_args=(--embedding-credentials "$embedding_key")
  embedding_port=18080
fi
scripts="$(dirname "$(realpath "$0")")"
python="$source/.venv/bin/python"
pod=luke-honcho-probe
database=luke-honcho-probe-pg

test "$(git -C "$source" rev-parse HEAD)" = 894b88321872e01702a1aa638ddfdde6ad60f173
test "$(podman pod inspect "$pod" --format '{{.InfraConfig.HostNetwork}} {{.InfraConfig.PortBindings}}')" = 'false map[]'
test "$(podman inspect "$database" --format '{{.Pod}}')" = "$(podman pod inspect "$pod" --format '{{.Id}}')"
test "$(stat -c %a "$credentials")" = 600
test "$(stat -c %a "$workspace")" = 700
cd "$source"

run=$(mktemp -d "$workspace/learning.XXXXXXXX")
# The socket is the only path out of the loopback-only namespace.
socket=$(mktemp -d /tmp/luke-honcho-egress.XXXXXXXX)/api.sock
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -f "$socket"
  rmdir "$(dirname "$socket")"
  podman pod stop -t 4 "$pod" >/dev/null 2>&1 || true
}
trap cleanup EXIT
echo "Synthetic probe logs: $run"
podman pod start "$pod" >/dev/null
pid=$(podman inspect -f '{{.State.Pid}}' "$database")
runner=(podman unshare nsenter -t "$pid" -n)
test "$("${runner[@]}" ip -j link show | jq -er 'map(.ifname) | join(",")')" = lo
for _ in {1..20}; do
  if podman exec "$database" pg_isready -q -h 127.0.0.1 -U postgres -d honcho_sandbox; then break; fi
  sleep 1
done
podman exec "$database" pg_isready -q -h 127.0.0.1 -U postgres -d honcho_sandbox

runtime=(env -i "PATH=$PATH" "HOME=$run" "PYTHONPATH=$source/sdks/python/src:$source"
  "TIKTOKEN_CACHE_DIR=$workspace/token-cache" PYTHONDONTWRITEBYTECODE=1
  DB_CONNECTION_URI=postgresql+psycopg://postgres@127.0.0.1:5432/honcho_sandbox
  CACHE_ENABLED=false AUTH_USE_AUTH=false PYTHON_DOTENV_DISABLED=1 HONCHO_CONFIG_TOML_DISABLED=1
  LLM_OPENAI_API_KEY=fixture-only LLM_OPENAI_BASE_URL=http://127.0.0.1:18080/v1
  DERIVER_MODEL_CONFIG__TRANSPORT=openai DERIVER_MODEL_CONFIG__MODEL=glm-5.3-flash
  DERIVER_MODEL_CONFIG__STRUCTURED_OUTPUT_MODE=json_object
  EMBEDDING_MODEL_CONFIG__MODEL=text-embedding-v4 EMBEDDING_VECTOR_DIMENSIONS=1536
  EMBEDDING_MODEL_CONFIG__DIMENSIONS_MODE=always EMBEDDING_MODEL_CONFIG__ENCODING_FORMAT_MODE=float
  EMBEDDING_MODEL_CONFIG__MAX_BATCH_SIZE=10
  "EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://127.0.0.1:$embedding_port/v1"
  DREAM_ENABLED=false DERIVER_FLUSH_ENABLED=true DERIVER_POLLING_STARTUP_JITTER_SECONDS=0
  DERIVER_POLLING_BACKOFF_ENABLED=false DERIVER_POLLING_SLEEP_INTERVAL_SECONDS=0.5)

"${runner[@]}" "${runtime[@]}" timeout 35 "$python" scripts/provision_db.py >"$run/migrate.log" 2>&1
env -i "PATH=$PATH" "HOME=$run" timeout 165 "$python" "$scripts/honcho-fixture-egress.py" upstream "$socket" \
  --credentials "$credentials" "${embedding_args[@]}" >"$run/egress.log" 2>&1 &
pids+=("$!")
if [[ "$embedding_port" = 18081 ]]; then
  "${runner[@]}" "${runtime[@]}" timeout 165 "$python" -m uvicorn src.mock_provider.main:app \
    --host 127.0.0.1 --port 18081 >"$run/mock-embedding.log" 2>&1 &
  pids+=("$!")
  echo "Embedding: synthetic only (no Bailian key supplied)"
fi
for _ in {1..30}; do [[ ! -S "$socket" ]] || break; sleep 0.1; done
test -S "$socket"
"${runner[@]}" "${runtime[@]}" timeout 165 "$python" "$scripts/honcho-fixture-egress.py" local "$socket" >"$run/relay.log" 2>&1 &
pids+=("$!")
"${runner[@]}" "${runtime[@]}" timeout 165 "$python" -m uvicorn src.main:app \
  --host 127.0.0.1 --port 8000 >"$run/api.log" 2>&1 &
pids+=("$!")
for _ in {1..20}; do if "${runner[@]}" curl -fs --max-time 2 http://127.0.0.1:8000/health >/dev/null; then break; fi; sleep 1; done
"${runner[@]}" curl -fs --max-time 2 http://127.0.0.1:8000/health >/dev/null
"${runner[@]}" "${runtime[@]}" timeout 160 "$python" -m src.deriver >"$run/deriver.log" 2>&1 &
pids+=("$!")
"${runner[@]}" "${runtime[@]}" timeout 150 "$python" "$scripts/honcho_learning_probe.py" "$(date +%s)-$$"
sort "$run/egress.log" | uniq -c
