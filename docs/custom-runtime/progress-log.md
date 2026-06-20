# Progress Log

## 2026-06-21

Created and pushed `custom-runtime` branch on the personal fork.

Added architecture baseline:

- `docs/custom-runtime/README.md`
- `docs/custom-runtime/runtime-architecture.md`
- `docs/custom-runtime/qqbot-message-flow.md`
- `docs/custom-runtime/server-hotfix-inventory.md`
- `docs/custom-runtime/deployment-plan.md`
- `src/custom/*` zero-behavior custom runtime skeleton

Ported safe server hotfixes into the fork:

- Token fetch `node:https` fallback when global `fetch` fails.
- `/new` and `/compact` added to urgent commands, alongside `/stop` and `/approve`.
- Group slash commands strip bot mentions before command matching.
- Dispatch timeout now waits for user-visible block output, sends a visible timeout notice, and ignores late deliver callbacks.
- Tool-only fallback sends a visible notice when no text/media is available.
- Error messages retry without `msg_id` if the reply anchor is invalid, expired, or unauthorized.
- Presigned COS part upload no longer sets explicit `Content-Length`.

Still intentionally not ported:

- Unread catch-up/follow-up timers.
- Synthetic digest messages.
- Async image generation interception.
- Group session auto-reset.

These need to be extracted into `src/custom` instead of being re-woven into `gateway.ts`.

Added custom release/update guardrails:

- Changed package identity to `@lukesong/openclaw-qqbot@1.7.2-luke.1` while keeping OpenClaw plugin id `openclaw-qqbot`.
- Made the update checker derive its default npm package from the installed package name instead of hardcoding the official package.
- `/bot-version` and `/bot-upgrade` now display/check the configured custom update source.
- `/bot-upgrade` defaults to `upgradeMode: "doc"`; hot reload requires explicit opt-in and admin confirmation.
- Upgrade scripts now default to the local package name. `/bot-upgrade --pkg` is blocked by default and requires `allowUpgradePkgOverride=true`.
- Hot reload now downloads the upgrade script from the personal `custom-runtime` branch by default, with `QQBOT_UPGRADE_SCRIPT_URL` kept as an emergency override.
- Added `tests/update-checker.test.ts` for package source normalization.

Extracted unread/follow-up message flow into pure runtime:

- Added `src/custom/unread-runtime.ts` with no gateway, QQ API, timer, filesystem, or OpenClaw SDK dependency.
- Added typed intents for scheduling follow-up timers, scheduling sleep digest timers, enqueueing catch-up, and policy-gated autonomous replies.
- Added `CustomUnreadConfig` under the custom runtime namespace and scene-level overrides.
- Added `createCustomMessageFlowRuntime()` and `inspectCustomUnreadConfig()` in `src/custom/runtime.ts`.
- Added `tests/unread-runtime.test.ts` for non-mention recording, bot-authored ignores, mention follow-up, snapshot consumption, follow-up/sleep firing, and policy gating.

Added gateway adapter bridge for unread runtime:

- Added `src/custom/unread-gateway-adapter.ts`.
- Added `tests/unread-gateway-adapter.test.ts`.
- Added typed custom unread fields on `QueuedMessage`.
- Changed `gateway.ts` message handling to use `QueuedMessage` as the internal event type.
- `gateway.ts` now honors `_customUnreadSnapshot` when building pending group history context for synthetic catch-up messages.

Wired unread runtime into active gateway behavior behind `channels.qqbot.customRuntime.enabled`:

- Non-mentioned group messages record into custom unread runtime instead of legacy history when the custom runtime and unread feature are enabled.
- Mentioned group messages inject custom unread history into the current agent context, clear autonomous timers, and can schedule catch-up after the direct reply.
- Gateway timer effects now manage follow-up and sleep-digest `setTimeout` handles.
- Adapter enqueue effects now enqueue synthetic catch-up messages.
- Snapshot consumption now happens after a synthetic catch-up produces a real model block output; failed, timed-out, `NO_REPLY`, or `[SKIP]` catch-ups keep their snapshot.
- Synthetic catch-up messages bypass mention gating and use unanchored/proactive outbound sends instead of fake `msg_id` passive replies.
- `_noMerge` is now honored by the message queue so synthetic snapshots are not merged away.
- Added `tests/message-queue.test.ts` for the no-merge queue boundary.

Still intentionally open:

- Proactive group send budget/rate-limit enforcement.

Added durable custom unread state:

- `CustomUnreadRuntime` can now load exported state and restore pending history, scheduled timers, follow-up activity, and catch-up snapshots after restart.
- Added `src/custom/unread-store.ts` for atomic JSON persistence under `~/.openclaw/qqbot/data/custom-unread/unread-<accountId>.json`.
- Gateway restores unread state on startup, re-registers pending follow-up/sleep-digest timers, and saves after:
  - non-mentioned group messages are recorded
  - mention/follow-up/sleep timer effects update state
  - catch-up snapshots are created or consumed
  - gateway abort/stop
- Added `tests/custom-unread-store.test.ts` and expanded `tests/unread-runtime.test.ts`.

Expanded authorization runtime baseline:

- `src/custom/auth.ts` now includes `CustomAuthorizationRuntime`.
- The auth runtime evaluates admins, scene capabilities, wildcard scene/grant capabilities, and disabled custom runtime state.
- Added in-memory temporary grants for once, count-limited, timed, and task-scoped access.
- Unauthorized checks can emit deduplicated approval request intents for bound admins.
- Approval resolution can create temporary grants and emits typed resolution intents.
- Grant consumption and expiry emit typed intents for future gateway/card adapters.
- Added `tests/custom-auth-runtime.test.ts`.

Wired custom authorization into plugin-level slash command handling:

- Added `src/custom/auth-gateway-adapter.ts` to keep QQ/gateway translation separate from the pure auth runtime.
- Added slash-command capability metadata and helpers in `src/slash-commands.ts`.
- `gateway.ts` now checks custom auth before executing matched plugin slash command handlers when `channels.qqbot.customRuntime.enabled=true`.
- Config/deploy mutation commands such as `/bot-streaming on`, `/bot-group-allways off`, `/bot-approve on`, `/bot-clear-storage --force`, and `/bot-upgrade --latest` are blocked unless the actor is an admin, the scene grants the capability, or a temporary grant exists.
- Denied commands receive visible text and emit/log request-approval intents when bound admins exist.
- Added `/bot-auth` gateway-level admin commands for text approval:
  - `/bot-auth status`
  - `/bot-auth approve <requestId> once`
  - `/bot-auth approve <requestId> count 3`
  - `/bot-auth approve <requestId> timed 10m`
  - `/bot-auth deny <requestId>`
- `/bot-auth` resolves approval requests against the live per-account `CustomAuthorizationRuntime`, creating once/count/timed temporary grants without entering the AI queue.
- Added QQ inline keyboard cards for new custom auth requests in C2C/group messages.
- Custom auth card buttons currently support allow once, allow 3 times, and deny through `custom-auth:<requestId>:...` interaction callbacks.
- Card handling reuses the same per-account `CustomAuthorizationRuntime` as `/bot-auth`, so button approvals create temporary grants immediately.
- Added `tests/slash-command-capability.test.ts` and `tests/custom-auth-gateway-adapter.test.ts`.

Still intentionally open:

- Persistent grant/request storage across gateway reconnects/restarts.
- Authorization for model/tool dispatch beyond plugin-level slash commands.
- Richer card controls for arbitrary temporary grant count/duration.

Added scene binding and profile resolver:

- Added `src/custom/scenes.ts` as the single source for custom scene defaults and peer binding resolution.
- Scene lookup now supports exact peer keys, kind wildcards such as `qqbot:group:*`, global wildcard `*`, and built-in defaults.
- Built-in scenes now carry default capabilities, labels, descriptions, autonomous-reply defaults, proactive-send defaults, and compact system prompts.
- Added `enabled:false` scene bindings so specific groups/DMs can be disabled under custom runtime before agent dispatch.
- `src/custom/config.ts` keeps backward-compatible helpers while delegating to the scene resolver.
- `src/custom/auth.ts` now uses scene resolver defaults for capability checks, so auth and routing policy share one scene model.
- `gateway.ts` injects the resolved scene system prompt when `channels.qqbot.customRuntime.enabled=true`, giving the model a clear per-peer behavior boundary.
- `src/custom/route.ts` applies scene `agentId` overrides after framework route resolution and rebuilds `sessionKey` through the OpenClaw routing helper.
- Added `tests/custom-scenes.test.ts` and expanded `tests/custom-runtime.test.ts`.

Still intentionally open:

- Long-task sandbox/workspace isolation is not implemented yet.
- Per-scene proactive budget/rate-limit enforcement is not implemented yet.

Added durable custom auth state:

- `CustomAuthorizationRuntime` can now load exported state and continue grant/request sequence numbers after restart.
- Added `src/custom/auth-store.ts` for atomic JSON persistence under `~/.openclaw/qqbot/data/custom-auth/auth-<accountId>.json`.
- Gateway restores custom auth grants/requests on startup and saves after:
  - approval request creation
  - approval resolution through `/bot-auth`
  - approval resolution through QQ inline keyboard buttons
  - grant consumption/expiry emitted by auth checks
  - gateway abort/stop
- Added `tests/custom-auth-store.test.ts` and expanded `tests/custom-auth-runtime.test.ts`.

Still intentionally open:

- Auth state is plain JSON. It currently stores only openids, capabilities, request metadata, and optional notes; add encryption/redaction before storing sensitive note payloads.
- Model/tool dispatch authorization beyond plugin-level slash commands is still pending.

Added custom proactive budget guard:

- Added `src/custom/proactive-budget.ts` as a pure local budget/rate-limit runtime for proactive/unanchored text sends.
- Added `src/custom/proactive-budget-store.ts` for atomic JSON persistence under `~/.openclaw/qqbot/data/custom-proactive-budget/budget-<accountId>.json`.
- Added `src/custom/proactive-send-guard.ts` so outbound send code can depend on a tiny guard interface instead of importing the custom runtime.
- `CustomMessageFlowRuntime` now owns `proactiveBudget` next to `auth` and `unread`.
- `resolveCustomRuntimeConfig()` now reads `customRuntime.proactive`; scene configs can override with `scene.proactive`.
- Gateway restores proactive budget state on startup and saves it on successful proactive text sends and gateway abort/stop.
- `src/outbound-deliver.ts` checks the guard before unanchored C2C/group text sends and commits the budget only after the send succeeds.
- Defaults are conservative: 4 sends per UTC month per account/peer, and 1 send per 60 seconds.
- Added `tests/custom-proactive-budget.test.ts`, `tests/custom-proactive-budget-store.test.ts`, and `tests/custom-proactive-send-guard.test.ts`.

Still intentionally open:

- Real server validation is still required because official docs warn proactive push may error after the 2025-04-21 platform adjustment.

Added proactive acceptance hard block:

- `CustomProactiveBudgetRuntime` now persists per-peer proactive acceptance state alongside monthly/rate budget entries.
- Gateway handles `GROUP_MSG_REJECT` by marking the group rejected and saving budget state.
- Gateway handles `GROUP_MSG_RECEIVE` by marking the group accepted and saving budget state.
- Guard checks reject state before monthly/rate checks, so group proactive text sends are blocked locally while a group has disabled receiving proactive bot messages.
- Expanded proactive budget/store tests to cover acceptance persistence and reject/receive state transitions.

Still intentionally open:

- Real server validation is still required because official docs warn proactive push may error after the 2025-04-21 platform adjustment.

Expanded proactive guard to media sends:

- `CustomProactiveSendGuard` now carries payload kind and media URL metadata while remaining compatible with text sends.
- `src/utils/media-send.ts` accepts a small prepare/commit hook so media tag queues can be guarded without importing the custom runtime.
- `src/outbound-deliver.ts` guards media tag queues, Base64 image sends, plain image sends, local/payload media auto-routing, and tool media forwarding before unanchored proactive sends.
- Gateway direct tool fallback and post-block tool media forwarding now reuse the same proactive guard and commit only after successful media send.
- Added `tests/media-send-proactive-guard.test.ts` and expanded `tests/custom-proactive-send-guard.test.ts`.

Still intentionally open:

- Real server validation is still required because official docs warn proactive push may error after the 2025-04-21 platform adjustment.

Added custom long-task sandbox state skeleton:

- Added `src/custom/task-sandbox.ts` as a pure task metadata runtime with create/list/status/add/cancel operations.
- Added `src/custom/task-sandbox-store.ts` for atomic JSON persistence under `~/.openclaw/qqbot/data/custom-tasks/tasks-<accountId>.json`.
- Added `src/custom/task-gateway-adapter.ts` to parse and handle `/bot-task` commands before they enter the main AI queue.
- Gateway restores task sandbox state on startup and persists it after task changes and gateway abort/stop.
- Added slash-command capability metadata for `/bot-task`:
  - help/list/status require `system.status`
  - create/add/cancel require `codex.longTask`
- Added tests for task runtime, task store, task gateway adapter, and slash capability mapping.

Still intentionally open:

- The task sandbox does not start a real subagent/job yet.
- Result pushback, workspace cleanup, timeout handling, and task-scoped execution permissions still need to be connected once the OpenClaw execution contract is confirmed.
