#!/usr/bin/env bash
set -euo pipefail

root="${LUKE_RUNTIME_ROOT:-$HOME/.local/share/luke-qq-pilot}"
instance="${LUKE_RUNTIME_INSTANCE:-luke}"
[[ "$instance" =~ ^[a-z][a-z0-9-]{1,24}$ ]]
lane="${1:?profile lane required}"
case "$lane" in
  chat) config=shadow-config.yaml ;;
  work) config=worker-config.yaml ;;
  *) exit 2 ;;
esac
source="$root/code/experiments"
image=docker.io/nousresearch/hermes-agent:v0.23.2@sha256:d6746a084e9341baada483e3d6210444d3c1aeb7c130f0915150065fb2851459
plugin="$source/hermes-qq/extensions/luke-readonly"
web_plugin="$source/hermes-qq/extensions/qq-web-search"
test -f "$plugin/plugin.yaml" && test -f "$plugin/data/goh.jsonl" && test -f "$plugin/data/dongwuyuan-skill.jsonl"
test -f "$web_plugin/plugin.yaml"

for asset in "$source/hermes-qq/$config" "$source/hermes-qq/shadow.mjs" "$source/hermes-qq/pilot.mjs" "$source/aoa-async/window-reply.mjs"; do
  if [[ ! -f "$asset" || -L "$asset" || $(stat -c %a "$asset") != 644 ]]; then
    printf 'Luke container asset must be a regular file with mode 0644: %s\n' "${asset##*/}" >&2
    exit 1
  fi
done

work_mounts=()
if [[ "$lane" == work ]]; then
  work_mounts=(-v "$source/hermes-qq/extensions/luke-imagen:/opt/data/plugins/luke-imagen:ro,z"
    -v "$root/imagen-ipc/requests:/run/luke-imagen/requests:rw,z"
    -v "$root/imagen-ipc/responses:/run/luke-imagen/responses:ro,z")
fi
persona_mount=()
if [[ -f "$root/SOUL.md" ]]; then
  persona_mount=(-v "$root/SOUL.md:/opt/data/SOUL.md:ro,z")
fi

exec /usr/bin/podman run --pull=never --replace --rm \
  --name "$instance-hermes-qq-$lane" --label "io.lukesong.scope=$instance-qq-pilot" \
  --sdnotify=conmon --memory=2g --pids-limit=160 --security-opt=no-new-privileges \
  --env-file "$root/secrets/$lane.env" \
  -e "HERMES_QQ_LANE=$lane" -e HERMES_QQ_WEB=1 -e API_SERVER_ENABLED=true -e API_SERVER_HOST=127.0.0.1 \
  -e GLM_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4 \
  -v "$instance-hermes-qq-$lane-state:/opt/data" \
  -v "$source/hermes-qq/$config:/opt/data/config.yaml:ro,z" \
  -v "$source/hermes-qq/shadow.mjs:/pilot/hermes-qq/shadow.mjs:ro,z" \
  -v "$source/hermes-qq/pilot.mjs:/pilot/hermes-qq/pilot.mjs:ro,z" \
  -v "$source/aoa-async/window-reply.mjs:/pilot/aoa-async/window-reply.mjs:ro,z" \
  -v "$plugin:/opt/data/plugins/luke-readonly:ro,z" \
  -v "$web_plugin:/opt/data/plugins/qq-web-search:ro,z" \
  "${work_mounts[@]}" \
  "${persona_mount[@]}" \
  "$image" gateway run
