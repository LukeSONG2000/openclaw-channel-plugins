# QQBot Custom Runtime Notes

This directory records the custom QQBot fork plan, evidence, and migration notes.

## Current Branch

- Fork: `https://github.com/LukeSONG2000/openclaw-qqbot`
- Branch: `custom-runtime`
- Upstream baseline: `tencent-connect/openclaw-qqbot@7ceb7f0913d15417c5a74d82442a672ef0382c64`
- Published package baseline: `@tencent-connect/openclaw-qqbot@1.7.2`

## Goals

The custom version should keep the official connector thin and stable, while moving Luke-specific behavior into a high-performance message-flow runtime.

Core custom behavior:

- Group unread catch-up: remember non-trigger messages and later reply with context.
- Follow-up autonomy: after a direct mention/reply, keep a short self-reply window.
- Proactive contextual nudges: periodically decide whether to speak based on recent group context.
- Active push routing: use platform-safe proactive messages only where limits allow.
- Authorization and scene routing: decide who can do what in each DM/group.
- Initialization anchors: first-time configuration must bind `customRuntime.admins` and `customRuntime.adminGroup` so approval, status, and operational alerts have a reliable management owner.
- Long task sandboxing: run deep tasks in isolated workspaces/subagents and push status/results back.
- Timeout and context fallbacks: keep slash commands and queues usable after long runs.

Out of scope for the first custom runtime:

- Async image generation embedded in `gateway.ts`. Treat it as a separate skill/tool integration, not core connector behavior.
  - Ordinary image/media receive and send paths remain in QQBot core.
  - Prompt interception, proxy setup, child process orchestration, and hardcoded skill paths must stay out of core.
  - `tests/no-core-image-generation-coupling.test.ts` guards this boundary.
- Broad refactors of official API wrappers unless needed for safety, retry, or observability.

## Evidence Files

- Server snapshot: `/Users/lukesong/Work/Workspace/laptop/openclaw-plugin-compare-20260621/server-current/openclaw-qqbot`
- Previous comparison report: `/Users/lukesong/Work/Workspace/laptop/openclaw-plugin-compare-20260621/REPORT.md`
- Server package path: `/home/PPfavorite/.openclaw/extensions/node_modules/@tencent-connect/openclaw-qqbot`
- Server config path: `/home/PPfavorite/.openclaw/openclaw.json`
- Gateway service: `/home/PPfavorite/.config/systemd/user/openclaw-gateway.service`

## Documents

- `runtime-architecture.md`: target architecture and module split.
- `qqbot-message-flow.md`: official and deployed message receive/send capability matrix.
- `server-hotfix-inventory.md`: current deployed hotfix inventory and keep/drop decision.
- `deployment-plan.md`: branch, package, deploy, rollback, and validation plan.
- `progress-log.md`: implementation log, including current custom update guardrails and unread runtime extraction.

## Evidence Scripts

- `node scripts/inspect-message-evidence.mjs`: read-only summary for `~/.openclaw/qqbot/data/known-users.json` and `ref-index.jsonl`.
- `node scripts/inspect-message-evidence.mjs /path/to/data --samples`: same summary with redacted shape samples; it reports presence/shape flags instead of raw message text or openids.
- `node scripts/inspect-upstream-updates.mjs`: fetch/read-only Markdown review of official `upstream/main` against `custom-runtime`; it never merges, installs, or deploys.
- `node scripts/inspect-upstream-updates.mjs --no-fetch --output /tmp/qqbot-upstream-review.md`: generate the same review from existing local refs.
- `node scripts/preflight-custom-runtime-deploy.mjs --config ~/.openclaw/openclaw.json --require-ready`: read-only deployment preflight for admin/admin-group anchors, personal update source, upgrade safety, and duplicate/legacy QQBot plugin risks.

## Current Implementation Modules

- `src/custom/auth.ts`: scene/capability authorization runtime, admin/admin-group binding inspection, temporary grants, and approval request intents.
- `src/custom/auth-gateway-adapter.ts`: gateway adapter for plugin slash command and ordinary dispatch authorization checks.
- `src/custom/config.ts`: custom runtime config resolution under `channels.qqbot.customRuntime`.
- `src/custom/fallback-alerts.ts`: pure repeated-fallback alert policy for management-group operational notices.
- `src/custom/fallback-event-store.ts`: bounded JSON persistence for recent custom fallback events.
- `src/custom/fallback-gateway-adapter.ts`: `/bot-fallback` status command adapter for recent fallback events.
- `src/custom/fallbacks.ts`: pure timeout, model-skip, tool-only fallback, and dispatch failure policy helpers.
- `src/custom/gateway-message-routing.ts`: pure gateway message routing context helper for queue peer id, framework route peer, custom scene peer, request target, and reply target.
- `src/custom/queued-message-context.ts`: pure `QueuedMessage` to custom peer/actor mapper shared by auth, scene, task, poll, game, deploy, and fallback diagnostics adapters.
- `src/custom/queue-status-gateway-adapter.ts`: `/bot-queue` read-only adapter for live per-peer queue health.
- `src/custom/slash-reply-target.ts`: pure slash reply target resolution for C2C/group/guild-channel/channel-DM text replies.
- `src/custom/urgent-commands.ts`: pure queue-bypass command policy for `/stop`, `/approve`, `/new`, and `/compact`.
- `src/custom/scene-gateway-adapter.ts`: `/bot-scene` status/profile-list/binding-list/bind command adapter with gateway-owned config persistence.
- `src/custom/slash-gateway-adapter.ts`: gateway-facing custom slash auth gate and typed effect merge layer.
- `src/custom/slash-router.ts`: pluggable custom slash route table for scene, fallback, queue, unread, task, poll, game, and deploy-confirmation commands.
- `src/custom/interaction-router.ts`: pluggable custom callback-card router for auth, poll, game, and deploy-confirmation cards.
- `src/custom/deploy-confirmation.ts`: pure safety confirmation runtime for guarded deployment/update decisions; it records confirm/cancel state but never executes upgrades.
- `src/custom/deploy-preflight.ts`: pure in-runtime deploy preflight summary for `/bot-deploy preflight`; it inspects the live config object but never runs shell commands or touches server files.
- `src/custom/deploy-confirmation-store.ts`: atomic JSON persistence under `~/.openclaw/qqbot/data/custom-deploy-confirmations`.
- `src/custom/deploy-confirmation-gateway-adapter.ts`: `/bot-deploy` command and `custom-deploy:` button callback adapter for deployment confirmation cards.
- `src/custom/game.ts`: pure lightweight game runtime for interactive cards.
- `src/custom/game-store.ts`: atomic JSON persistence under `~/.openclaw/qqbot/data/custom-games`.
- `src/custom/game-gateway-adapter.ts`: `/bot-game` command and `custom-game:` button callback adapter.
- `src/custom/task-access.ts`: pure long-task account/peer/owner access policy shared by status views and mutation authorization.
- `src/custom/task-cleanup.ts`: pure read-only cleanup plan builder for completed/failed/cancelled long-task workspaces.
- `src/custom/task-command-executor.ts`: optional command-backed long-task executor, disabled by default; supports stdin requirement forwarding and stdout progress events for future runner integration.
- `src/custom/task-sandbox.ts`: pure long-task state runtime with global/scene-level sandbox config resolution, workspace root, active-task limits, and progress metadata.
- `src/custom/runtime.ts`: composition helpers and exported custom runtime modules.
- `src/custom/unread-runtime.ts`: pure unread/follow-up/sleep-digest state machine.
- `src/custom/unread-gateway-adapter.ts`: effect bridge between unread runtime and gateway queue/history types.
- `src/custom/unread-status-gateway-adapter.ts`: `/bot-unread` read-only status adapter for unread/follow-up/sleep-digest inspection.
- `scripts/apply-custom-runtime-init.mjs`: shared installer helper for binding `customRuntime.admins`, `customRuntime.adminGroup`, and the default management-group `system-admin` scene during initialization.
- `scripts/preflight-custom-runtime-deploy.mjs`: read-only safety checker before custom runtime deploy/update; it fails readiness when management anchors, QQBot credentials, personal update source, or duplicate plugin constraints are unsafe.
- `src/gateway.ts`: executes custom runtime effects, persists scene/config intents, and applies plugin slash command auth checks when `channels.qqbot.customRuntime.enabled` is true; default remains off.
- `src/message-queue.ts`: honors `_noMerge` so synthetic catch-up messages keep their snapshots.
