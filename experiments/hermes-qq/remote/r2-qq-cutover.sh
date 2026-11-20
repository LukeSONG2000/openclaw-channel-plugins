#!/usr/bin/env bash
set -euo pipefail
umask 077
root="$HOME/.local/share/r2-qq-hermes"
exec 9>"$root/cutover.lock"
flock -x 9

old_qq_off() {
  openclaw channels status --json | node -e '
    let input = "";
    process.stdin.on("data", chunk => input += chunk);
    process.stdin.on("end", () => {
      const data = JSON.parse(input.slice(input.indexOf("{")));
      const accounts = data.channelAccounts?.qqbot ?? [];
      if (!data.channels || data.channels.qqbot?.running || data.channels.qqbot?.connected ||
          accounts.some(a => a.running || a.connected)) process.exit(1);
    });'
}

legacy="$HOME/.openclaw/qqbot/data/custom-unread/unread-default.json"
units=(r2-qq-bridge r2-qq-receive r2-hermes-qq@chat r2-hermes-qq@work)
trap 'systemctl --user disable --now "${units[@]}" && openclaw config set channels.qqbot.enabled true --strict-json' ERR
openclaw config set channels.qqbot.enabled false --strict-json
for ((i=0; i<15; i++)); do
  if old_qq_off; then break; fi
  sleep 1
done
old_qq_off

systemctl --user disable --now luke-qq-bridge luke-qq-receive luke-hermes-qq@chat luke-hermes-qq@work
set -a
source "$root/deploy.env"
set +a
[[ ! -e "$root/inbox/hermes-trial/receipts.sqlite" ]]
if [[ -f "$legacy" ]]; then
  "$LUKE_NODE" "$root/code/experiments/hermes-qq/remote/import-qq-history.mjs" "$legacy" "$root/group-policy.json" "$root/inbox/inbox.sqlite"
fi
systemctl --user start r2-qq-receive
systemctl --user start r2-qq-bridge
for ((i=0; i<20; i++)); do
  if [[ -d "$root/inbox/hermes-trial" ]] && systemctl --user is-active --quiet r2-qq-bridge &&
     journalctl --user-unit=r2-qq-receive.service -n 30 --no-pager -o cat | grep -q '^qq_receive_ready' &&
     journalctl --user-unit=r2-qq-bridge.service -n 30 --no-pager -o cat | grep -q '^qq_trial_ready'; then break; fi
  sleep 1
done
systemctl --user is-active "${units[@]}"
journalctl --user-unit=r2-qq-receive.service -n 30 --no-pager -o cat | grep '^qq_receive_ready'
journalctl --user-unit=r2-qq-bridge.service -n 30 --no-pager -o cat | grep '^qq_trial_ready'
old_qq_off
systemctl --user enable "${units[@]}"
trap - ERR
echo 'R2 QQ switched to Hermes.'
