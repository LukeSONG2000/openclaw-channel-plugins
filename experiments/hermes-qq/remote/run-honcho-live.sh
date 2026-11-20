#!/usr/bin/env bash
set -euo pipefail
umask 077
root=$(realpath "${1:?private Honcho runtime directory}")
scripts=$(dirname "$(realpath "$0")")
source=$(realpath "$root/source")
python="$source/.venv/bin/python"
pod=luke-honcho-live
database=luke-honcho-live-pg
test "$(git -C "$source" rev-parse HEAD)" = 894b88321872e01702a1aa638ddfdde6ad60f173
test "$(podman pod inspect "$pod" --format '{{.InfraConfig.HostNetwork}} {{.InfraConfig.PortBindings}}')" = 'false map[]'
test "$(podman inspect "$database" --format '{{.Pod}}')" = "$(podman pod inspect "$pod" --format '{{.Id}}')"
test "$(stat -c '%a %u' "$root")" = "700 $(id -u)"
cd "$source"

pids=()
cleanup() {
  trap - EXIT
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -f "$root/upstream.sock" "$root/api.sock"
  podman pod stop -t 5 "$pod" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT
rm -f "$root/upstream.sock" "$root/api.sock"
podman pod start "$pod" >/dev/null
pid=$(podman inspect -f '{{.State.Pid}}' "$database")
runner=(podman unshare nsenter -t "$pid" -n)
test "$("${runner[@]}" ip -j link show | jq -er 'map(.ifname) | join(",")')" = lo
for _ in {1..30}; do
  if podman exec "$database" pg_isready -q -h 127.0.0.1 -U postgres -d luke_memory; then break; fi
  sleep 1
done
podman exec "$database" pg_isready -q -h 127.0.0.1 -U postgres -d luke_memory

runtime=(env -i "PATH=$PATH" "HOME=$root" "TIKTOKEN_CACHE_DIR=$root/token-cache" PYTHONDONTWRITEBYTECODE=1
  DB_CONNECTION_URI=postgresql+psycopg://postgres@127.0.0.1:5432/luke_memory
  CACHE_ENABLED=false AUTH_USE_AUTH=true "AUTH_JWT_SECRET=$(<"$root/jwt-secret")" PYTHON_DOTENV_DISABLED=1 HONCHO_CONFIG_TOML_DISABLED=1
  LLM_OPENAI_API_KEY=local-relay LLM_OPENAI_BASE_URL=http://127.0.0.1:18080/v1
  DERIVER_MODEL_CONFIG__TRANSPORT=openai DERIVER_MODEL_CONFIG__MODEL=glm-5.3-flash
  DERIVER_MODEL_CONFIG__STRUCTURED_OUTPUT_MODE=json_object
  EMBEDDING_MODEL_CONFIG__MODEL=text-embedding-v4 EMBEDDING_VECTOR_DIMENSIONS=1536
  EMBEDDING_MODEL_CONFIG__DIMENSIONS_MODE=always EMBEDDING_MODEL_CONFIG__ENCODING_FORMAT_MODE=float
  EMBEDDING_MODEL_CONFIG__MAX_BATCH_SIZE=10 EMBEDDING_MODEL_CONFIG__OVERRIDES__BASE_URL=http://127.0.0.1:18080/v1
  DREAM_ENABLED=false DERIVER_REPRESENTATION_BATCH_MAX_AGE_SECONDS=30 DERIVER_POLLING_STARTUP_JITTER_SECONDS=0)
"${runner[@]}" "${runtime[@]}" timeout 45 "$python" scripts/provision_db.py
relay="$scripts/honcho-fixture-egress.py"
env -i "PATH=$PATH" "HOME=$root" "$python" "$relay" upstream "$root/upstream.sock" \
  --credentials "$root/zhipu.env" --embedding-credentials "$root/bailian.key" &
pids+=("$!")
for _ in {1..50}; do [[ ! -S "$root/upstream.sock" ]] || break; sleep 0.1; done
test -S "$root/upstream.sock"
"${runner[@]}" "${runtime[@]}" "$python" "$relay" local "$root/upstream.sock" &
pids+=("$!")
"${runner[@]}" "${runtime[@]}" "$python" -m uvicorn src.main:app --host 127.0.0.1 --port 8000 --no-access-log &
pids+=("$!")
"${runner[@]}" "${runtime[@]}" "$python" -m src.deriver &
pids+=("$!")
"${runner[@]}" "${runtime[@]}" "$python" "$relay" api "$root/api.sock" &
pids+=("$!")
wait -n "${pids[@]}"
exit 1
