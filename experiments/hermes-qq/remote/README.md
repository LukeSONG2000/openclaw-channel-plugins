# Luke Linux deployment

Run on the R2 host as a separate test stack, without modifying its gateway, account, services, or storage. Use rootless Podman and systemd user units from this directory. Node.js needs support for `node:sqlite`. The service files use this layout under `~/.local/share/luke-qq-pilot`:

- `code/`: checkout or deployment snapshot at the verified revision.
- `inbox/`: existing QQ inbox and verified group binding, plus the SQLite receipts in `hermes-trial/`. Install the pinned QQ SDK from the test runtime's package manifest and lockfile in this directory.
- `deploy.env`: set `LUKE_NODE` to the absolute Node binary path, `LUKE_QQ_SDK` to the absolute SDK ESM entry path, and `LUKE_QQ_APP_ID` to the existing test-bot account, never the production R2 account.
- `secrets/`: private `qq-app-secret` (one line), `chat.env` and `work.env` (each containing the model credential and a separate API server key). The root and secrets directory must be private, and the files owner-only. Do not commit any of this state.

Before starting the receiver, stop any listener for the same test account. Migrate the inbox and receipts as closed SQLite files and check their integrity. Copy only portable state into the separate named volumes `luke-hermes-qq-chat-state` and `luke-hermes-qq-work-state`: transcripts, native databases (including any required WAL), memories and task state, not cache, process locks or machine-specific dependencies. Pull the pinned image in `run-profile.sh`; neither profile publishes a port or mounts the Podman socket. This host delegates the memory and pids controllers to user services, not the cpu controller; do not change host-wide delegation for this pilot.

Install the three `*.service` files in `~/.config/systemd/user/`, run `systemctl --user daemon-reload`, then enable both `luke-hermes-qq@{chat,work}.service`, `luke-qq-receive.service` and `luke-qq-bridge.service`. Verify both profile readiness probes, the QQ READY log and the bridge's cadence state separately. A ready socket does not prove a group reply was delivered. To pause, stop only these units and keep both volumes and the inbox.
