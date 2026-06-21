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

- `src/custom/agent-message-body-context.ts`: pure current-message body builder for group sender prefixes, merged group messages, quote fragments, mention tags, and initial agent body.
- `src/custom/auth.ts`: scene/capability authorization runtime, admin/admin-group binding inspection, temporary grants, and approval request intents.
- `src/custom/auth-gateway-adapter.ts`: gateway adapter for plugin slash command and ordinary dispatch authorization checks.
- `src/custom/admin-group-notification-service-gateway-adapter.ts`: gateway-side management-group notification service for auth copies, repeated-fallback alerts, custom update prompts, proactive guard injection, and shared cooldown state.
- `src/custom/dispatch-authorization-gateway-adapter.ts`: gateway-side ordinary-dispatch auth orchestration for checks, intent persistence/logging, denial delivery, and admin-group copies.
- `src/custom/dispatch-auth-delivery-gateway-adapter.ts`: gateway-facing delivery helper for ordinary-dispatch auth denials, approval cards, text fallback, and management-group copy intent.
- `src/custom/deliver-debounce-gateway-adapter.ts`: gateway-side debounce dispatcher for static deliver payloads and debouncer handle creation/reuse.
- `src/custom/dispatch-completion-gateway-adapter.ts`: gateway-side dispatch completion orchestrator for dispatch/timeout racing, race-failure fallback handling, finalization, and post-finalize hooks.
- `src/custom/dispatch-deliver-callback-gateway-adapter.ts`: gateway-side ordinary dispatch deliver callback orchestrator for late-deliver filtering, tool deliver fallback, block preflight, streaming handoff, static delivery, and debounce.
- `src/custom/dispatch-deliver-gateway-adapter.ts`: gateway-side deliver callback preflight for late-timeout ignores, model-skip tokens, block-state marking, and timer cleanup.
- `src/custom/dispatch-error-callback-gateway-adapter.ts`: gateway-side dispatcher `onError` callback orchestrator for response marking, response-timeout cleanup, streaming error handoff, and fallback notice routing.
- `src/custom/dispatch-fallback-session-gateway-adapter.ts`: gateway-side per-dispatch fallback session for response timeout timers, tool-only timers, fallback recorder binding, and tool fallback sender wiring.
- `src/custom/dispatch-failure-gateway-adapter.ts`: gateway-side response-timeout/context-too-long/framework-error notice and fallback-event orchestration for dispatch race, callback, and processing failures.
- `src/custom/dispatch-finalize-gateway-adapter.ts`: gateway-side dispatch finally cleanup for tool timers, tool completion fallback, debouncer disposal, and streaming finalization.
- `src/custom/dispatch-reply-gateway-adapter.ts`: gateway-side ordinary reply dispatch orchestrator for message config resolution, dispatcher callback wiring, streaming setup, dispatch completion, processing failure fallback, and typing cleanup.
- `src/custom/dispatch-send-helpers-gateway-adapter.ts`: gateway-side helper factory for bound token-retry sends and visible error-message sends during ordinary dispatch.
- `src/custom/dispatch-setup-gateway-adapter.ts`: gateway-side ordinary-dispatch setup for reply context, send helpers, outbound deliver context, proactive guards, and guarded media auto-send.
- `src/custom/dispatch-streaming-setup-gateway-adapter.ts`: gateway-side streaming setup for target-type resolution, streaming enablement, and `StreamingController` construction.
- `src/custom/streaming-gateway-adapter.ts`: gateway-side streaming deliver/error/partial/finalize orchestration around `StreamingController`.
- `src/custom/static-deliver-gateway-adapter.ts`: gateway-side static deliver executor for media tags, structured payloads, plain replies, quote refs, and outbound activity.
- `src/custom/config.ts`: custom runtime config resolution under `channels.qqbot.customRuntime`.
- `src/custom/fallback-alerts.ts`: pure repeated-fallback alert policy for management-group operational notices.
- `src/custom/fallback-event-store.ts`: bounded JSON persistence for recent custom fallback events.
- `src/custom/fallback-gateway-adapter.ts`: `/bot-fallback` status command adapter for recent fallback events.
- `src/custom/fallback-record-context.ts`: pure builder for fallback record peer/actor/session/queue/dispatch snapshots from `QueuedMessage`; dispatch recorder wiring lives in `fallback-record-gateway-adapter.ts`.
- `src/custom/fallbacks.ts`: pure timeout, model-skip, tool-only fallback, and dispatch failure policy helpers.
- `src/custom/tool-deliver-gateway-adapter.ts`: gateway-side tool deliver observer for immediate media forwarding, tool-only timeout scheduling, and completion fallback triggering.
- `src/custom/tool-fallback-gateway-adapter.ts`: gateway-side tool-only fallback sender for collected media/text/no-output notices.
- `src/custom/gateway-message-routing.ts`: pure gateway message routing context helper for queue peer id, framework route peer, custom scene peer, request target, and reply target.
- `src/custom/message-ingress-gateway-adapter.ts`: gateway-side per-message ingress setup for inbound logging/activity, C2C typing keepalive, framework route lookup, custom scene route application, and envelope option resolution.
- `src/custom/message-context-gateway-adapter.ts`: gateway-side message context pipeline for inbound preparation, TTS static hint injection, command authorization, group dispatch gate, and final agent context payload assembly.
- `src/custom/message-dispatch-gateway-adapter.ts`: gateway-side post-context dispatch orchestration for reply setup, custom authorization, request context binding, fallback session creation, reply dispatch, and unread completion.
- `src/custom/websocket-close-gateway-adapter.ts`: gateway-side WebSocket close/connection-failure adapter for applying reconnect policy, session/token side effects, cleanup, and retry scheduling.
- `src/custom/websocket-connection-gateway-adapter.ts`: gateway-side WebSocket connection binder for token/gateway URL acquisition, socket event registration, open lifecycle side effects, message/close/error delegation, heartbeat reset binding, and connection-failure scheduling.
- `src/custom/websocket-message-gateway-adapter.ts`: gateway-side WebSocket `message` event adapter for JSON parsing, seq/session persistence, Hello/Dispatch/Invalid-Session policy application, heartbeat setup, READY greetings, event fanout, and reconnect requests.
- `src/custom/websocket-payload-policy.ts`: pure WebSocket Hello/Dispatch/Invalid-Session payload policy for identify/resume packets, heartbeat payloads, READY/RESUMED startup semantics, and invalid-session retry effects.
- `src/custom/websocket-reconnect-policy.ts`: pure WebSocket close/connection-failure policy for token refresh, session reset, quick-disconnect backoff, and rate-limit retry decisions.
- `src/custom/webhook-transport-gateway-adapter.ts`: gateway-side Webhook transport starter for queue processor startup, background token refresh, event fanout logging, READY greeting, error forwarding, and shutdown cleanup after the Webhook transport returns.
- `src/custom/group-activation.ts`: gateway-adjacent group activation helper for `/activation` session-store path resolution and `mention`/`always` fallback parsing.
- `src/custom/group-message-gate-context.ts`: pure group-message gate context helper for mention detection, implicit quote mention, text-command gating, and synthetic unread catch-up overrides.
- `src/custom/group-dispatch-gateway-adapter.ts`: gateway-side group dispatch gate orchestrator for allow-list checks, mention/activation gates, ingress side effects, prompt context, and unread catch-up metadata.
- `src/custom/group-ingress-gateway-adapter.ts`: gateway-side group ingress side-effect adapter for skipped-message custom unread recording, legacy history fallback, mention catch-up metadata, scheduler/persist callbacks, and equivalent logs.
- `src/custom/group-prompt-context.ts`: pure group prompt context helper for sender label, group subject, group intro/behavior prompt merge, and QQBot system prompt merging.
- `src/custom/guarded-media-send-gateway-adapter.ts`: gateway-side guarded media auto-send helper for proactive media guard checks, send callbacks, logging, and budget commits.
- `src/custom/inbound-event-gateway-adapter.ts`: gateway-side inbound event dispatcher for normalized messages, proactive acceptance, group robot events, delete diagnostics, and interaction handoff.
- `src/custom/typing-keepalive-gateway-adapter.ts`: gateway-side C2C input-notify starter with token refresh retry and keepalive stop handle.
- `src/custom/inbound-preparation-gateway-adapter.ts`: gateway-side inbound preparation orchestrator for attachment processing, user-content normalization, quote/ref-index caching, body envelope formatting, inbound media context, and voice summary logging.
- `src/custom/agent-context-gateway-adapter.ts`: gateway-side agent context orchestrator for current-message body, unread history injection, agent-body length logging, and final inbound context payload finalization.
- `src/custom/inbound-context-payload.ts`: pure `finalizeInboundContext()` payload builder for message addresses, group metadata, voice/media fields, quote fields, and QQBot system prompts.
- `src/custom/inbound-media-context.ts`: pure inbound media context builder for image/voice dynamic prompt lines, voice summary counters, and local/remote media split.
- `src/custom/message-reference-context.ts`: pure quote/ref-index context helper for inbound quote resolution and current-message ref-index record construction.
- `src/custom/runtime-services-gateway-adapter.ts`: gateway-side custom runtime service bootstrap for command-backed task executor callbacks, async task notifications, unread scheduler creation, and restore-time unread config lookup.
- `src/custom/outbound-deliver-context.ts`: pure outbound delivery event/account context builder for media tag delivery and proactive guard source metadata.
- `src/custom/queued-message-context.ts`: pure `QueuedMessage` to custom peer/actor mapper shared by auth, scene, task, poll, game, deploy, and fallback diagnostics adapters.
- `src/custom/queue-status-gateway-adapter.ts`: `/bot-queue` read-only adapter for live per-peer queue health.
- `src/custom/reply-context-gateway-adapter.ts`: gateway-side reply anchor/target/context builder for normal and synthetic unread messages.
- `src/custom/slash-reply-target.ts`: pure slash reply target resolution for C2C/group/guild-channel/channel-DM text replies.
- `src/custom/urgent-commands.ts`: pure queue-bypass command policy for `/stop`, `/approve`, `/new`, and `/compact`.
- `src/custom/urgent-queue-bypass-gateway-adapter.ts`: gateway-side urgent command queue bypass executor with queue snapshots, fallback diagnostics, and immediate execution callbacks.
- `src/custom/scene-route-gateway-adapter.ts`: gateway-side scene route setup for resolving custom scenes, skipping disabled scenes, applying scene agent overrides, and returning system prompts.
- `src/custom/scene-gateway-adapter.ts`: `/bot-scene` status/profile-list/binding-list/bind command adapter with gateway-owned config persistence.
- `src/custom/slash-gateway-adapter.ts`: gateway-facing custom slash auth gate and typed effect merge layer.
- `src/custom/slash-prequeue-gateway-adapter.ts`: gateway-side prequeue slash orchestrator for mention-stripped slash content, urgent bypass, custom slash effects, official slash matching, delegate enqueueing, and file reply delivery callbacks.
- `src/custom/slash-effects-gateway-adapter.ts`: gateway-side custom slash effect applier for logs, state/config persistence, reply delivery, and task notification results.
- `src/custom/slash-reply-delivery-gateway-adapter.ts`: gateway-side custom slash reply delivery for text, keyboard fallback, auth approval cards, and management-group copies.
- `src/custom/slash-router.ts`: pluggable custom slash route table for scene, fallback, queue, unread, task, poll, game, and deploy-confirmation commands.
- `src/custom/config-interaction-gateway-adapter.ts`: gateway-side official QQ config interaction handler for `claw_cfg` query/update ACK payloads.
- `src/custom/interaction-create-gateway-adapter.ts`: gateway-side `INTERACTION_CREATE` orchestrator for config ACKs, custom auth/poll/game/deploy callback cards, legacy approval buttons, persistence effects, and follow-up replies.
- `src/custom/interaction-effects-gateway-adapter.ts`: gateway-side custom callback-card effect applier for logs, state persistence, and reply delivery.
- `src/custom/interaction-router.ts`: pluggable custom callback-card router for auth, poll, game, and deploy-confirmation cards.
- `src/custom/deploy-confirmation.ts`: pure safety confirmation runtime for guarded deployment/update decisions; it records confirm/cancel state but never executes upgrades.
- `src/custom/deploy-preflight.ts`: pure in-runtime deploy preflight summary for `/bot-deploy preflight`; it inspects the live config object but never runs shell commands or touches server files.
- `src/custom/deploy-confirmation-store.ts`: atomic JSON persistence under `~/.openclaw/qqbot/data/custom-deploy-confirmations`.
- `src/custom/deploy-confirmation-gateway-adapter.ts`: `/bot-deploy` command and `custom-deploy:` button callback adapter for deployment confirmation cards.
- `src/custom/task-execution-effects-gateway-adapter.ts`: gateway-side long-task execution effect applier for executor logs, async persistence, and guarded task notification delivery.
- `src/custom/game.ts`: pure lightweight game runtime for interactive cards.
- `src/custom/game-store.ts`: atomic JSON persistence under `~/.openclaw/qqbot/data/custom-games`.
- `src/custom/game-gateway-adapter.ts`: `/bot-game` command and `custom-game:` button callback adapter.
- `src/custom/task-access.ts`: pure long-task account/peer/owner access policy shared by status views and mutation authorization.
- `src/custom/task-cleanup.ts`: pure read-only cleanup plan builder for completed/failed/cancelled long-task workspaces.
- `src/custom/task-command-executor.ts`: optional command-backed long-task executor, disabled by default; supports stdin requirement forwarding and stdout progress events for future runner integration.
- `src/custom/task-sandbox.ts`: pure long-task state runtime with global/scene-level sandbox config resolution, workspace root, active-task limits, and progress metadata.
- `src/custom/runtime.ts`: composition helpers and exported custom runtime modules.
- `src/custom/unread-context.ts`: gateway-side adapter for selecting custom/legacy history, applying it to the initial agent body, legacy history record/clear, and attachment tag formatting.
- `src/custom/unread-completion-gateway-adapter.ts`: gateway-side unread completion adapter for custom unread effects/persistence and legacy history clearing after dispatch.
- `src/custom/unread-runtime.ts`: pure unread/follow-up/sleep-digest state machine.
- `src/custom/unread-gateway-adapter.ts`: effect bridge between unread runtime and gateway queue/history types.
- `src/custom/unread-status-gateway-adapter.ts`: `/bot-unread` read-only status adapter for unread/follow-up/sleep-digest inspection.
- `scripts/apply-custom-runtime-init.mjs`: shared installer helper for binding `customRuntime.admins`, `customRuntime.adminGroup`, and the default management-group `system-admin` scene during initialization.
- `scripts/preflight-custom-runtime-deploy.mjs`: read-only safety checker before custom runtime deploy/update; it fails readiness when management anchors, QQBot credentials, personal update source, or duplicate plugin constraints are unsafe.
- `src/gateway.ts`: executes custom runtime effects, persists scene/config intents, and applies plugin slash command auth checks when `channels.qqbot.customRuntime.enabled` is true; default remains off.
- `src/message-queue.ts`: honors `_noMerge` so synthetic catch-up messages keep their snapshots.
