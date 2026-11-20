#!/usr/bin/env bash
set -euo pipefail

root="$HOME/.local/share/luke-qq-pilot"
lane="${1:?profile lane required}"
case "$lane" in
  chat) config=shadow-config.yaml ;;
  work) config=worker-config.yaml ;;
  *) exit 2 ;;
esac
source="$root/code/experiments"
image=docker.io/nousresearch/hermes-agent:v0.23.2@sha256:d6746a084e9341baada483e3d6210444d3c1aeb7c130f0915150065fb2851459
plugin="$source/hermes-qq/extensions/luke-readonly"
test -f "$plugin/plugin.yaml" && test -f "$plugin/data/goh.jsonl" && test -f "$plugin/data/dongwuyuan-skill.jsonl"

for asset in "$source/hermes-qq/$config" "$source/hermes-qq/shadow.mjs" "$source/hermes-qq/pilot.mjs" "$source/aoa-async/window-reply.mjs"; do
  if [[ ! -f "$asset" || -L "$asset" || $(stat -c %a "$asset") != 644 ]]; then
    printf 'Luke container asset must be a regular file with mode 0644: %s\n' "${asset##*/}" >&2
    exit 1
  fi
done

exec /usr/bin/podman run --pull=never --replace --rm \
  --name "luke-hermes-qq-$lane" --label io.lukesong.scope=luke-qq-pilot \
  --sdnotify=conmon --memory=2g --pids-limit=160 --security-opt=no-new-privileges \
  --env-file "$root/secrets/$lane.env" \
  -e "HERMES_QQ_LANE=$lane" -e API_SERVER_ENABLED=true -e API_SERVER_HOST=127.0.0.1 \
  -e GLM_BASE_URL=https://open.bigmodel.cn/api/coding/paas/v4 \
  -v "luke-hermes-qq-$lane-state:/opt/data" \
  -v "$source/hermes-qq/$config:/opt/data/config.yaml:ro,z" \
  -v "$source/hermes-qq/shadow.mjs:/pilot/hermes-qq/shadow.mjs:ro,z" \
  -v "$source/hermes-qq/pilot.mjs:/pilot/hermes-qq/pilot.mjs:ro,z" \
  -v "$source/aoa-async/window-reply.mjs:/pilot/aoa-async/window-reply.mjs:ro,z" \
  -v "$plugin:/opt/data/plugins/luke-readonly:ro,z" \
  "$image" gateway run
