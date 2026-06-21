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

## Current Implementation Modules

- `src/custom/auth.ts`: scene/capability authorization runtime, temporary grants, and approval request intents.
- `src/custom/auth-gateway-adapter.ts`: gateway adapter for plugin slash command authorization checks.
- `src/custom/config.ts`: custom runtime config resolution under `channels.qqbot.customRuntime`.
- `src/custom/runtime.ts`: composition helpers and exported custom runtime modules.
- `src/custom/unread-runtime.ts`: pure unread/follow-up/sleep-digest state machine.
- `src/custom/unread-gateway-adapter.ts`: effect bridge between unread runtime and gateway queue/history types.
- `src/gateway.ts`: executes unread runtime effects and plugin slash command auth checks when `channels.qqbot.customRuntime.enabled` is true; default remains off.
- `src/message-queue.ts`: honors `_noMerge` so synthetic catch-up messages keep their snapshots.
