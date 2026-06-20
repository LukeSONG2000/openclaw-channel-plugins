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
- Upgrade scripts now default to the local package name, with `--pkg` still available as an explicit override.
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
- Durable persistence for pending unread state across gateway reconnects/restarts.
