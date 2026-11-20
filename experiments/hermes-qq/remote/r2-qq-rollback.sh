#!/usr/bin/env bash
set -euo pipefail
exec 9>"$HOME/.local/share/r2-qq-hermes/cutover.lock"
flock -x 9

# Shut down new receivers before allowing OpenClaw to use the account again.
systemctl --user disable --now r2-qq-bridge r2-qq-receive 'r2-hermes-qq@chat' 'r2-hermes-qq@work'
for unit in r2-qq-bridge r2-qq-receive; do
  [[ "$(systemctl --user show "$unit" -p MainPID --value)" == 0 ]]
done
openclaw config set channels.qqbot.enabled true --strict-json
echo 'OpenClaw QQ re-enabled. Check: openclaw channels status --json'
