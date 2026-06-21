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
- Urgent command matching is now extracted to `src/custom/urgent-commands.ts`, matches only the first slash command token, and avoids treating `/newspaper` or `/compaction` as queue-bypass commands.
- Group slash commands strip bot mentions before command matching.
- Immediate urgent commands are now retained if they arrive before the message processor starts, then flushed when `startProcessor()` is registered.
- Immediate urgent command execution is covered while the same peer already has a blocking message in flight; queued normal messages can be dropped and `/new` or `/compact` still run outside the peer queue.
- Urgent queue bypasses now emit `urgent-queue-bypass` fallback events with the command, queue peer id, dropped queued message count, active processing age, and before/after queue snapshots.
- `/bot-fallback list` now expands urgent queue-bypass records with command, dropped count, queue peer id, after-clear pending counts, and active peer duration; `/bot-fallback summary` counts them separately.
- `/bot-fallback summary` 会汇总最近事件中的最长活跃处理时长，方便直接判断是否存在队列卡住迹象。
- Dispatch timeout now waits for user-visible block output, sends a visible timeout notice, and ignores late deliver callbacks.
- Tool-only fallback sends a visible notice when no text/media is available.
- Error messages retry without `msg_id` if the reply anchor is invalid, expired, or unauthorized.
- Presigned COS part upload no longer sets explicit `Content-Length`.

Clarified channel-DM slash replies:

- Added `src/custom/slash-reply-target.ts` so gateway-level slash replies resolve C2C, group, guild channel, and channel DM targets through a pure helper.
- Gateway slash text replies for `DIRECT_MESSAGE_CREATE` now use `sendDmMessage` with the event `guild_id` instead of falling through to C2C-style user sends.
- Slash file/media replies remain disabled for channel DM until a correct DM media path is added.

Still intentionally not ported:

- Unread catch-up/follow-up timers.
- Synthetic digest messages.
- Async image generation interception.
- Group session auto-reset.

These need to be extracted into `src/custom` instead of being re-woven into `gateway.ts`.

Added an async image-generation boundary check:

- Confirmed the custom fork keeps ordinary image/media receive-send support while leaving prompt interception and image-generation orchestration out of QQBot core.
- Added `tests/no-core-image-generation-coupling.test.ts` to guard against hardcoded `codex-image-gen`, proxy settings, child-process generation, and prompt-interception patterns returning to connector core files.
- Future image generation should be exposed as a separate skill/tool with its own queue, timeout, proxy, and result-delivery policy.

Added custom release/update guardrails:

- Changed package identity to `@lukesong/openclaw-qqbot@1.7.2-luke.1` while keeping OpenClaw plugin id `openclaw-qqbot`.
- Made the update checker derive its default npm package from the installed package name instead of hardcoding the official package.
- `/bot-version` and `/bot-upgrade` now display/check the configured custom update source.
- `/bot-upgrade` defaults to `upgradeMode: "doc"`; hot reload requires explicit opt-in and admin confirmation.
- Upgrade scripts now default to the local package name. `/bot-upgrade --pkg` is blocked by default and requires `allowUpgradePkgOverride=true`.
- Hot reload now downloads the upgrade script from the personal `custom-runtime` branch by default, with `QQBOT_UPGRADE_SCRIPT_URL` kept as an emergency override.
- Added `tests/update-checker.test.ts` for package source normalization.

Added custom update check loop for the personal package:

- Added `src/custom/update-check.ts` to resolve `customUpdateCheck` config and periodically check the personal package source.
- `gateway.ts` starts the loop on startup and stops it on abort; the loop logs available personal-package updates but never installs anything.
- `/bot-version` now labels available versions as custom package updates to avoid implying official auto-upgrade.
- Added `tests/custom-update-check.test.ts` for default config, disabled mode, interval clamping, and update-available behavior.

Extracted custom fallback policy helpers:

- Added `src/custom/fallbacks.ts` for response timeout constants, tool-only fallback selection, no-output notices, model skip tokens, and dispatch failure classification.
- `gateway.ts` now imports those helpers instead of carrying fallback magic numbers and user-facing timeout strings inline.
- Added `tests/custom-fallbacks.test.ts` to lock the current timeout values, skip-token behavior, tool fallback text selection, and timeout classification.

Added context-too-long fallback classification:

- `src/custom/fallbacks.ts` now classifies common context/token limit errors, including nested error causes.
- `gateway.ts` sends a visible recovery notice that points users to `/compact` and `/new` while releasing the message queue.
- The fallback deliberately does not auto-reset sessions yet; automatic reset remains a later policy decision because it can discard context.

Improved fallback recovery shortcuts:

- Response-timeout, tool-no-output, and context-too-long user notices now include QQ `<qqbot-cmd-input>` shortcuts for `/compact`, `/new`, and `/bot-fallback summary 20` as appropriate.
- `/bot-fallback list` and `/bot-fallback summary` append recovery shortcuts for `/compact` and `/new`, so users/admins can inspect an incident and immediately trigger the queue-bypass recovery path without typing slash commands manually.
- Added fallback tests to lock the command-input recovery hints.

Added structured fallback event logs:

- `src/custom/fallbacks.ts` now builds `custom-fallback` event objects for timeout, context-too-long, late-deliver, and tool-only fallback paths.
- `gateway.ts` logs those events with account, peer, actor, session key, run/message id, response state, and tool-deliver counts.
- Added `src/custom/fallback-event-store.ts` for bounded JSON persistence of recent fallback events under `~/.openclaw/qqbot/data/custom-fallback-events/events-<accountId>.json`.
- `gateway.ts` appends fallback events to that ring buffer while keeping the user-visible fallback behavior unchanged.
- Added `src/custom/fallback-gateway-adapter.ts` and `/bot-fallback` so authorized users can inspect recent fallback events from chat.
- Added `/bot-fallback clear --force` behind `config.write` so admins can clear old diagnostic events after verification.
- Fallback events now include the current message queue snapshot (`totalPending`, active users, max concurrency, sender pending) and `/bot-fallback` displays it when available.
- Added `/bot-fallback summary [数量]` to aggregate recent fallback kinds and max queue pressure from chat.
- Future admin notification cards can reuse the same pure event shape.

Refreshed QQBot receive/send capability evidence:

- Confirmed the deployed gateway is active and current durable server state still stores users by openid only, with no raw numeric QQ ids in `known-users.json`.
- Updated `docs/custom-runtime/qqbot-message-flow.md` with a development capability matrix for C2C, group, guild channel, channel DM, and interaction events.
- Added a send capability matrix covering text/Markdown/cards/media/proactive/streaming wrappers and marking channel-DM behavior as unaudited.
- Corrected `ref-index.jsonl` scope: it is a quote/context cache with sender/content/attachment metadata, not a reliable group-openid mapping source.

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
- Custom auth card buttons currently support allow once, allow 3 times, allow 10 minutes, and deny through `custom-auth:<requestId>:...` interaction callbacks.
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

补齐主动消息接收状态硬拦截：

- `CustomProactiveBudgetRuntime` 会把每个 peer 的主动消息接收状态和月度/频率预算一起持久化。
- Gateway 处理 `GROUP_MSG_REJECT` / `GROUP_MSG_RECEIVE`，用于标记群聊主动消息拒收/接收状态。
- Gateway 处理 `C2C_MSG_REJECT` / `C2C_MSG_RECEIVE`，用于标记单聊主动消息拒收/接收状态。
- Guard 会先检查拒收状态，再检查月度/频率预算；如果用户或群已经关闭主动消息接收，本地直接阻止 C2C/group 主动发送。
- 扩展 proactive budget/store 测试，覆盖 C2C 和 group 的接收状态持久化与拒收/恢复接收状态切换。

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

- Added `src/custom/task-sandbox.ts` as a pure task state runtime with create/list/status/add/cancel operations.
- Added `src/custom/task-sandbox-store.ts` for atomic JSON persistence under `~/.openclaw/qqbot/data/custom-tasks/tasks-<accountId>.json`.
- Added `src/custom/task-gateway-adapter.ts` to parse and handle `/bot-task` commands before they enter the main AI queue.
- Gateway restores task sandbox state on startup and persists it after task changes and gateway abort/stop.
- Added slash-command capability metadata for `/bot-task`:
  - help/list/status require `system.status`
  - create/add/cancel require `codex.longTask`
- Added tests for task runtime, task store, task gateway adapter, and slash capability mapping.

Expanded custom long-task sandbox execution boundary:

- `CustomTaskSandboxRuntime` now supports start, heartbeat, complete, and fail transitions in addition to create/add/cancel.
- Task records now include optional execution metadata: executor id, run id, agent id, start/completion timestamps, and last heartbeat.
- Task operations emit typed intents for start requests, requirement additions, cancellation requests, and status updates.
- Added `src/custom/task-workspace.ts` to materialize isolated task workspaces with `TASK.md`, `status.json`, and `requirements.jsonl`.
- Gateway updates task workspace files after `/bot-task create`, `/bot-task add`, and `/bot-task cancel` without entering the main AI queue.
- Added `tests/custom-task-workspace.test.ts` and expanded task runtime/gateway/store tests.

Added custom long-task executor adapter boundary:

- Added `src/custom/task-executor-adapter.ts` to apply task intents to an optional executor without baking a child process or OpenClaw private API into the gateway.
- The adapter materializes task workspaces, keeps tasks queued when no executor is attached, starts tasks when an executor accepts them, forwards appended requirements/cancel requests, and exposes heartbeat/complete/fail helpers.
- `src/custom/slash-gateway-adapter.ts` now routes `/bot-task` intents through the executor adapter, so workspace effects and future executor effects share one boundary.
- Added `tests/custom-task-executor-adapter.test.ts` for queued-without-executor, executor start, requirement forwarding, heartbeat, complete, and fail paths.

Added custom long-task notification effects:

- Added `src/custom/task-notification-adapter.ts` to format completion/failure/cancellation notifications as typed effects instead of directly sending QQ messages.
- `completeCustomTaskExecution()` and `failCustomTaskExecution()` can now emit peer/owner notification effects with result/error truncation while still updating runtime state and `status.json`.
- Added `tests/custom-task-notification-adapter.test.ts` and expanded executor adapter tests for notify effects.

Added custom long-task notification gateway mapping:

- Added `src/custom/task-notification-gateway-adapter.ts` to map task notification effects into gateway send descriptions with `MessageTarget` plus text.
- Peer notifications map to the original task peer; owner notifications map to owner C2C; duplicate audience/target effects are deduped.
- Added `tests/custom-task-notification-gateway-adapter.test.ts` for group, owner, C2C, channel, mismatch, and dedupe paths.

Added custom long-task notification delivery application:

- Added `applyCustomTaskNotificationDeliveries()` so gateway code can apply typed notification deliveries through a provided text sender without coupling task runtime to QQ APIs.
- `src/custom/slash-gateway-adapter.ts` now returns task notification deliveries when task execution effects include `notify`.
- `src/gateway.ts` applies those deliveries after custom slash replies, logging sent/skipped/failed outcomes.
- `/bot-task cancel` now requests a peer notification effect, giving the task notification path an anchored command-flow integration.
- Unanchored async deliveries are skipped by default until proactive send policy is explicitly wired for task-worker completion.

Still intentionally open:

- A real OpenClaw subagent/job executor is still pending until the runtime contract is confirmed.
- Workspace cleanup and richer task-scoped execution controls still need to be connected once the executor contract is confirmed.

Added first custom interactive poll/card feature:

- Added `src/custom/poll.ts` as a pure local poll runtime with create/list/status/close/vote operations.
- Added `src/custom/poll-store.ts` for atomic JSON persistence under `~/.openclaw/qqbot/data/custom-polls/polls-<accountId>.json`.
- Added `src/custom/poll-gateway-adapter.ts` to parse `/bot-poll` commands and handle `custom-poll:<pollId>:vote:<1-4>` button callbacks.
- Gateway restores poll state on startup, persists it after poll changes and gateway abort/stop, and routes poll button interactions after ACK.
- C2C/group `/bot-poll create ...` replies with inline keyboard buttons when available; channel/DM paths fall back to text.
- Added slash-command capability metadata for `/bot-poll`:
  - help/list/status require `system.status`
  - create/close require `game.interact`
- Added tests for poll runtime, poll store, poll gateway adapter, and slash capability mapping.

Still intentionally open:

- Custom poll cards need validation on the actual deployed bot after installing the custom package.
- Broader task cards, scene switch cards, deploy confirmation execution handoff, and richer lightweight games remain future increments.

Started reducing custom gateway coupling:

- Added `src/custom/message-flow-state.ts` as a per-account lifecycle boundary for custom runtime state.
- The state controller creates the in-memory custom runtime, restores auth/proactive/task/poll/unread state, exposes focused persist callbacks, and supports `persistAllState()` on shutdown.
- `gateway.ts` no longer imports the individual custom store modules directly.
- Added `tests/custom-message-flow-state.test.ts` to verify restore and save across all current custom state areas.

Extracted custom slash command orchestration:

- Added `src/custom/slash-gateway-adapter.ts` to handle `/bot-auth`, custom slash authorization, `/bot-task`, and `/bot-poll` through one gateway-facing adapter.
- The adapter returns typed reply/persist/log descriptions and does not call QQ send APIs directly.
- `gateway.ts` now keeps the platform send/fallback responsibility while delegating custom command decisions to the adapter.
- Added `tests/custom-slash-gateway-adapter.test.ts` for no-match, auth-denial approval card, task command, and poll keyboard paths.

Extracted custom button interaction orchestration:

- Added `src/custom/interaction-gateway-adapter.ts` to route `custom-auth:` and `custom-poll:` button callbacks through one gateway-facing adapter.
- The adapter returns typed reply/persist/log descriptions and does not ACK or send QQ messages directly.
- `gateway.ts` now keeps platform ACK, target selection, QQ send APIs, config interactions, and legacy official approval buttons.
- Added `tests/custom-interaction-gateway-adapter.test.ts` for auth button, poll vote, and unknown legacy button paths.

Extracted custom unread effect scheduling:

- Added `src/custom/unread-scheduler.ts` to own follow-up/sleep-digest timer handles and unread gateway effect application.
- The scheduler receives enqueue/persist/config/log callbacks and does not inspect QQ events or send QQ messages directly.
- `gateway.ts` now delegates set/clear timer effects, synthetic catch-up enqueue effects, policy-gated logs, timer restore, and timer cleanup to the scheduler.
- Added `tests/custom-unread-scheduler.test.ts` for set/clear timer effects, timer firing into synthetic catch-up enqueue, restore, and dispose.

Extracted custom unread dispatch completion:

- Added `src/custom/unread-completion.ts` to handle post-dispatch unread decisions after model output is known.
- The adapter consumes completed synthetic catch-up snapshots, keeps no-output snapshots for retry, creates mention-follow-up catch-ups, and schedules output-complete follow-up effects.
- `gateway.ts` now delegates these decisions to the adapter and only applies returned logs, persistence, and scheduler effects.
- Added `tests/custom-unread-completion.test.ts` for snapshot consume/keep, mention-follow-up catch-up, output-complete follow-up, and ignored no-output paths.

Extracted custom unread pre-dispatch ingress:

- Added `src/custom/unread-ingress.ts` to resolve per-event unread config, record non-mentioned group messages, and observe mentioned group messages before agent dispatch.
- The adapter returns custom unread history as `HistoryEntry[]` plus typed scheduler effects and persistence flags, keeping timer ownership and QQ sends outside the module.
- `gateway.ts` now delegates custom unread record/observe decisions to the adapter while keeping group allow-list, mention gating, command authorization, and final prompt formatting in the gateway path.
- Added `tests/custom-unread-ingress.test.ts` for disabled runtime fallback, disabled scene unread fallback, non-mention record scheduling, and mention-time history injection effects.

Extracted custom unread context selection:

- Added `src/custom/unread-context.ts` to choose between synthetic snapshot history, mention-time custom unread history, and legacy group history before pending-history formatting.
- `gateway.ts` now delegates custom unread history precedence to the selector while still owning the final envelope formatting.
- Added `tests/custom-unread-context.test.ts` for snapshot priority, mention fallback, empty snapshot fallback, and legacy fallback.

Expanded unread context adapter ownership:

- `src/custom/unread-context.ts` now also records legacy non-mentioned group history, clears legacy group history after fallback completion, appends attachment tags, and builds the pending-history context body through a gateway-provided envelope formatter.
- `gateway.ts` no longer imports or calls `recordPendingHistoryEntry`, `buildPendingHistoryContext`, `clearPendingHistory`, `formatAttachmentTags`, or `toAttachmentSummaries` directly.
- Expanded `tests/custom-unread-context.test.ts` to cover legacy record, envelope-body construction, attachment tags, and cleanup.

Added custom auth dispatch gate:

- `src/custom/auth-gateway-adapter.ts` now checks ordinary messages before OpenClaw/model dispatch, not only plugin-level slash commands.
- Dispatch capability resolution defaults to `chat.send`, uses `codex.run` for slash-like framework commands, and uses `codex.run` in codex-only scenes that do not grant `chat.send`.
- `gateway.ts` blocks unauthorized dispatches before model/tool execution, persists auth intents, and sends C2C/group approval cards when a bound admin can approve the request.
- Expanded `tests/custom-auth-gateway-adapter.test.ts` for dispatch denial, temporary grant consumption, and codex-only capability selection.

Added peer scene binding command:

- Added `src/custom/scene-gateway-adapter.ts` to parse and handle `/bot-scene status`, `/bot-scene list`, `/bot-scene set <scene>`, and `/bot-scene <scene>` before normal slash handling.
- Scene status/list require `system.status`; scene binding requires `config.write`, so non-admin users still go through the custom auth approval path unless the scene grants the capability.
- `src/custom/slash-gateway-adapter.ts` now routes `/bot-scene` and returns exact config persistence intents instead of writing files directly.
- `gateway.ts` persists scene binding changes by reloading the latest framework config, merging the peer scene under `channels.qqbot.customRuntime.scenes`, and calling `runtime.config.writeConfigFile()`.
- Added `tests/custom-scene-gateway-adapter.test.ts` and expanded custom slash/capability tests.

Added optional command-backed long-task executor:

- Added `src/custom/task-command-executor.ts` as a conservative local command executor implementing the existing `CustomTaskExecutor` boundary.
- The executor is disabled by default and configured under `channels.qqbot.customRuntime.tasks.commandExecutor`.
- When enabled, it starts the configured command in the task workspace, passes task metadata through `QQBOT_CUSTOM_TASK_*` environment variables, captures stdout/stderr, enforces timeout/output truncation, and calls the same complete/fail helpers used by future executors.
- `gateway.ts` now attaches the command executor to `/bot-task create`, persists async completion/failure state, and sends async task notifications only after applying the proactive acceptance/budget guard for unanchored C2C/group deliveries.
- Added `tests/custom-task-command-executor.test.ts`.

Added task-scoped mutation authorization:

- Added `src/custom/task-auth-gateway-adapter.ts` to check `/bot-task add` and `/bot-task cancel` before task state mutation.
- Task owners can mutate their own tasks; custom runtime admins can mutate any task; other group members need a task-scoped `codex.longTask` temporary grant.
- Task mutation denials create auth requests with `taskId`; approval cards show the task id and default to a task-scoped grant when approved without an explicit mode.
- `src/custom/slash-gateway-adapter.ts` now applies this check before calling `handleCustomTaskCommand`, so denied add/cancel attempts do not modify task records.
- Added `tests/custom-task-auth-gateway-adapter.test.ts` and expanded custom slash gateway tests.

Added custom runtime admin initialization anchors:

- Added `customRuntime.adminGroup` beside `customRuntime.admins`; the runtime normalizes raw QQ `group_openid`, `group:<openid>`, and `qqbot:group:<openid>` into a stable management peer key.
- QQBot onboarding now treats admin and management-group binding as part of initial configuration: it can read CLI input or `QQBOT_CUSTOM_ADMINS` / `QQBOT_CUSTOM_ADMIN_GROUP`, prompts for missing values, and writes them under `channels.qqbot.customRuntime`.
- Added `inspectCustomAdminBindings()` so adapters can detect whether custom runtime initialization has both administrators and a management group.
- Authorization approval requests now carry the normalized management group key, and approval card text displays it for operational clarity.
- `/bot-auth status` now reports bound admins, bound management group, and whether initialization is complete or missing `admins`/`adminGroup`.
- Updated docs and tests for admin-group binding, onboarding status output, and approval-request propagation.

Closed the install-script initialization gap:

- Added `scripts/apply-custom-runtime-init.mjs` as the shared helper for writing and inspecting `channels.qqbot.customRuntime.admins` plus `adminGroup`.
- `scripts/upgrade-via-npm.sh`, `scripts/upgrade-via-source.sh`, and `scripts/upgrade-via-npm.ps1` now accept `--admins` / `--admin-group`; environment fallbacks are `QQBOT_CUSTOM_ADMINS` / `QQBOT_CUSTOM_ADMIN_GROUP`.
- When no admin binding arguments are supplied, install scripts print the current binding status and warn when initialization is incomplete, so `appid`/`secret` alone no longer looks like a complete custom runtime setup.
- Added `tests/custom-runtime-init-script.test.mjs` and updated install/upgrade docs with first-install examples that include admin and management-group binding.

Wired approval requests to the management group:

- Added a pure `buildCustomAuthAdminGroupNotification()` helper that creates a management-group approval notification only when the request has `adminGroup` and the source peer is not already that group.
- `src/custom/slash-gateway-adapter.ts` now returns optional management-group notification intents for denied slash/config commands and denied task mutation commands.
- `gateway.ts` best-effort sends those management-group approval cards/text and also copies ordinary dispatch authorization requests to the management group.
- Management-group copies are unanchored group sends, so the gateway applies the custom proactive acceptance/budget guard before calling QQ send APIs and records budget only after a successful send.
- Expanded auth/slash gateway tests for notification creation, source-group dedupe, and missing-admin-group behavior.

Hardened reply-dispatcher unanchored text sends:

- Added `prepareUnanchoredTextSend` to `ReplyContext` so `src/reply-dispatcher.ts` can explicitly guard C2C/group text sends that have no passive `messageId` anchor.
- Gateway injects the existing custom proactive acceptance/budget guard into reply contexts, covering error fallbacks, structured-payload confirmation/captions, admin-group auth notifications, and task notifications that share `sendTextToTarget()`.
- Removed the hand-rolled task-notification guard branch in favor of the shared reply-dispatcher hook.
- Added `tests/reply-dispatcher-proactive-guard.test.ts` to prove anchored replies skip the guard, unanchored C2C/group sends call it, blocked sends do not hit the API, and commits run only after successful sends.

Added guard hooks to legacy proactive send surfaces:

- `src/outbound.ts` now accepts optional `prepareUnanchoredSend` on text/media contexts and proactive/cron helpers. When present, unanchored C2C/group text, media, media captions, and fallback links are checked before QQ send APIs and committed only after successful delivery.
- `src/proactive.ts` now accepts the same optional guard for direct, bulk, broadcast, and direct-account proactive sends.
- These hooks deliberately do not import or own custom runtime state; gateway/custom callers decide when to inject the shared budget/acceptance guard.
- Added `tests/outbound-proactive-guard.test.ts` for blocked proactive text, passive-skip behavior, direct proactive sends, and cron sends.

Still intentionally open:

- Final QQBot envelope formatting and group policy/mention gating still live in `gateway.ts`; these are platform responsibilities unless a broader gateway presenter layer is introduced.
- Fine-grained tool-level authorization inside model runs remains pending until the OpenClaw tool execution contract is confirmed.

Added channel-side message delete diagnostics:

- Added `src/custom/message-delete-events.ts` to parse official channel deletion events `MESSAGE_DELETE`, `PUBLIC_MESSAGE_DELETE`, and `DIRECT_MESSAGE_DELETE`.
- The parser emits only conservative diagnostic fields: event type, scope, message id, channel id, guild id, author id, operator id, timestamp, and safe raw top-level keys.
- `gateway.ts` now logs these events as `Message delete diagnostics` from the unified WebSocket/Webhook dispatch path.
- This is intentionally diagnostic-only: it does not remove ref-index entries, unread history, group history, task context, or scene/auth state.
- Updated message-flow and architecture docs to record that official C2C/group docs currently expose create plus active-message receive/reject events, while C2C/group recall-delete behavior still needs deployed-server evidence before runtime state can depend on it.

Added reusable deployed-message evidence inspection:

- Added `scripts/inspect-message-evidence.mjs`, a read-only Node script that summarizes `known-users.json` and `ref-index.jsonl` without printing raw message text or openids by default.
- The script records known-user counts, peer type distribution, nickname/group-openid presence, numeric-like raw id hints, attachment type distribution, and text-content hints for face tags, URLs, quotes, and voice markers.
- Recorded the 2026-06-21 `laptop-home` snapshot in `qqbot-message-flow.md`: 32 known users, 2440 ref-index records, 168 attachment summaries, and observed attachment categories for JPEG/PNG/GIF/generic image/file/voice.
- This makes later deployment validation repeatable without relying on one-off shell snippets or memory of prior server checks.

Hardened long-task status visibility:

- `/bot-task status <taskId>` now checks read visibility before formatting task details.
- A task is visible only under the same account and original peer, or to the task owner across peers.
- If an ordinary user queries a task id from another group/DM, the adapter returns "not found or not current session" and does not expose workspace path, owner, prompt-derived title, result, or error.
- Added tests for same-peer status, cross-peer denial, and owner cross-peer status access.

Improved long-task follow-up ergonomics:

- `/bot-task create`, `/bot-task list`, `/bot-task status`, and `/bot-task add` replies now include QQ command-input shortcuts for common follow-up actions.
- Active tasks show status, append-requirement, and cancel shortcuts; completed/cancelled/failed tasks hide append/cancel shortcuts and keep only status/new-task actions.
- Append shortcuts prefill `/bot-task add <taskId> ` without auto-sending, so group members can edit the new requirement before sending.
- This keeps long-task follow-up outside the main AI queue while making status checks and requirement updates easier in group chat.

Hardened poll text-command visibility:

- `/bot-poll status <pollId>` and `/bot-poll close <pollId>` now check account/peer visibility before showing poll details or closing a poll.
- A poll is visible through text commands only in its original account/peer, or to its creator across peers.
- Ordinary users who paste a poll id from another group/DM receive "not found or not current session" and do not see question/options/vote counts.

Hardened poll button callback visibility:

- `gateway.ts` now maps `INTERACTION_CREATE` callback source fields (`group_openid`, `user_openid`, `channel_id`, `guild_id`) into a custom peer before routing `custom-poll:` buttons.
- `handleCustomPollInteraction()` now checks account and source peer before mutating votes. Ordinary users cannot vote on a poll from another group/DM by replaying or pasting a `custom-poll:<pollId>` button payload.
- Poll creators can still interact with their own poll across peers, matching text-command status visibility.
- Added interaction and poll adapter tests for same-peer vote success, cross-peer vote denial, creator cross-peer vote, and source-peer parsing.

Added unread runtime inspection summaries:

- Added `inspectCustomUnreadRuntimeState()` as a pure, text-safe summary helper for the custom unread/follow-up/sleep-digest runtime.
- The summary reports peer count, total pending message count, follow-up/sleep timer counts, snapshot counts, and policy-gated snapshot counts.
- Per-peer summaries include pending count, oldest/newest pending timestamps, timer due times, follow-up activity, and snapshot counts.
- The helper intentionally does not include cached message bodies, so future status commands and remote validation logs can expose runtime health without leaking group chat content.

Added `/bot-unread` runtime status command:

- Added `src/custom/unread-status-gateway-adapter.ts` for `/bot-unread`, `/bot-unread status [数量]`, and `/bot-unread summary [数量]`.
- The command is read-only, requires `system.status` through slash capability metadata, and is routed by `src/custom/slash-gateway-adapter.ts` before normal AI dispatch.
- Output uses `inspectCustomUnreadRuntimeState()` and shows peer/pending/snapshot/timer counts plus per-peer timestamps; it does not include cached message bodies.
- Added tests for parser/status output, custom slash gateway routing, and slash capability mapping.

Added `/bot-queue` live queue status command:

- Added `src/custom/queue-status-gateway-adapter.ts` for `/bot-queue`, `/bot-queue status`, and `/bot-queue help`.
- The command is read-only, requires `system.status` through slash capability metadata, and is routed by `src/custom/slash-gateway-adapter.ts` before unread/task/poll handling.
- `gateway.ts` injects the current `MessageQueue.getSnapshot(peerId)` result, so the adapter can show current-session pending count, global pending count, active user concurrency, sender active duration, and max active duration without importing queue internals into `src/custom`.
- When the current peer has pending or active work, output includes QQ command-input shortcuts for `/compact` and `/new`; idle output avoids recovery shortcuts.
- Output deliberately contains only queue counters and durations, not queued message bodies or cached unread content.
- Added tests for parser/status/help output, recovery shortcuts, custom slash gateway routing, and slash capability mapping.

Added repeated fallback admin-group alerts:

- Added `src/custom/fallback-alerts.ts` as a pure policy module for detecting repeated fallback incidents in the same peer.
- Default policy alerts when `response-timeout` or `context-too-long` happens 3 times within 15 minutes for the same account/peer, then cools down that account/peer for 30 minutes.
- The policy reads `channels.qqbot.customRuntime.fallbackAlerts` for optional `enabled`, `windowMs`, `threshold`, `cooldownMs`, and `kinds` overrides.
- `gateway.ts` evaluates the alert only after a fallback event is successfully persisted, so management-group alerts correspond to `/bot-fallback` history.
- Alerts are sent to `customRuntime.adminGroup` as guarded unanchored group sends; the existing proactive acceptance/budget guard can block them, and successful sends commit the same proactive budget.
- Alert text includes counts, event kinds, latest timestamp, queue counters, and command-input shortcuts for `/bot-queue` and `/bot-fallback summary 20`; it does not include raw error text, prompts, or cached message bodies.
- Added `tests/custom-fallback-alerts.test.ts` for threshold/window/peer grouping, config overrides, disabled/missing-admin-group behavior, and text redaction.

Auto-bound the management group scene during initialization:

- `applyCustomRuntimeAdminBindingsToConfig()` and `scripts/apply-custom-runtime-init.mjs` now bind `customRuntime.adminGroup` to the `system-admin` scene when no explicit scene exists for that management group.
- Existing management-group scene bindings are preserved, so a user-defined `dev-lab` or other profile is not overwritten by later admin/admin-group setup.
- This makes the management group immediately useful for status queries, authorization operations, deploy checks, and operational alerts without implicitly granting high-risk mutation capabilities.
- Added onboarding, runtime-config, and init-script tests for automatic binding and preservation of existing scene config.

Added configured scene binding inspection:

- `/bot-scene bindings` now lists explicit `customRuntime.scenes` bindings without mutating config.
- Output includes binding key, scene, enabled state, label, and resolved capability summary, but no chat content or cached runtime state.
- The command requires only `system.status`; `/bot-scene list` remains the built-in profile list, while `/bot-scene bindings` shows actual configured peers/wildcards.
- Added parser, adapter, slash gateway, and slash capability tests for the new read-only subcommand.

新增授权运维只读视图：

- `/bot-auth requests [数量]` 列出当前仍有效的待审批授权申请，默认 10 条、最多 20 条。
- `/bot-auth grants [数量]` 列出当前仍有效的临时授权，过滤已过期或剩余次数为 0 的记录。
- 两个命令都复用 `/bot-auth` 的管理员校验，只允许 `customRuntime.admins` 中的管理员查看。
- 输出只包含 request/grant id、用户/会话标识、能力、场景、过期时间、剩余次数和审批命令提示，不包含原始消息正文或缓存聊天内容。
- `/bot-auth status` 增加详情命令提示，并按当前时间只统计仍有效的待审批申请和临时授权。
- 同步复核初始化配置目标：首次配置必须绑定 `customRuntime.admins` 和 `customRuntime.adminGroup`；onboarding/setup/install helper 继续把缺失绑定视为未完整初始化，写入管理群时仍自动绑定默认 `system-admin` 场景。

收紧长任务沙盒访问边界：

- 新增 `src/custom/task-access.ts`，把长任务的 account/peer/owner 访问判断抽成纯策略，供状态查看和 mutation 授权共用。
- `/bot-task status` 继续允许原始会话成员查看任务状态，owner 可跨会话查看自己的任务；跨会话普通成员仍只看到“不属于当前会话”，不暴露工作区、发起人、结果或错误。
- `/bot-task add` / `/bot-task cancel` 在进入 task-scoped auth 之前先检查同一 account/peer 边界；跨会话普通成员不会触发授权申请，也不会把任务 id、能力或 owner 信息推给管理群。
- 同会话非 owner 成员仍不能直接改任务，保持通过 task-scoped `codex.longTask` 临时授权申请的路径。
- 新增 `tests/custom-task-access.test.ts`，并扩展 task auth/slash gateway 测试覆盖跨会话 mutation 拦截。

加入场景级长任务沙盒配置：

- `CustomSceneConfig` 支持 `tasks` 字段，和全局 `customRuntime.tasks` 使用同一组轻量配置：`workspaceRoot` 与 `maxActiveTasksPerPeer`。
- 新增 `resolveTaskSandboxConfig()` / `inspectCustomTaskSandboxConfig()`，按“全局默认 + 当前场景覆盖”解析长任务沙盒策略。
- `/bot-task create` 现在根据当前 peer 的 scene 传入沙盒配置，因此不同群聊/单聊可以落到不同工作区，并拥有不同活跃任务上限。
- 这个改动不重建 per-account runtime，也不把 OpenClaw 子 agent 细节塞进 gateway；真实 subagent/job executor 仍通过现有 `CustomTaskExecutor` 边界后续接入。
- 扩展 task sandbox、custom runtime、custom slash gateway 测试，覆盖场景工作区覆盖和场景活跃任务上限。

加固初始化配置的管理员/管理群绑定：

- 将 QQBot setup 初始化的校验和写入逻辑收敛到 `src/onboarding.ts` 的 `validateQQBotSetupInput()` 与 `applyQQBotSetupAccountConfig()`。
- `qqbotPlugin.setup.validateInput` 现在继续把缺少 `customRuntime.admins` 或 `customRuntime.adminGroup` 视为初始化失败，不能只填 AppID/Secret 就完成二开运行时初始化。
- `qqbotPlugin.setup.applyAccountConfig` 复用同一 helper，写入账号凭证时同步写入管理员和管理群，并自动为管理群创建默认 `system-admin` scene 绑定。
- 扩展 `tests/custom-onboarding.test.ts` 覆盖 setup 输入完整、缺管理员、缺管理群，以及写入凭证+绑定管理群的初始化路径。

增强授权申请卡片的临时授权入口：

- `buildCustomAuthApprovalKeyboard()` 现在在 C2C/群聊授权卡片中渲染“允许10分钟”按钮，按钮 payload 为 `custom-auth:<requestId>:allow-timed`。
- `handleCustomAuthInteraction()` 原有的 timed grant 处理路径得到卡片入口覆盖，管理员点击后会创建 10 分钟临时授权；任意时长仍可用 `/bot-auth allow-timed <requestId> <时长>` 文本命令。
- 扩展 `tests/custom-auth-gateway-adapter.test.ts` 和 `tests/custom-interaction-gateway-adapter.test.ts`，覆盖卡片 payload、10 分钟过期时间和 gateway interaction 持久化标记。

对齐长任务授权卡片与 task-scoped grant：

- 长任务追加/取消触发的授权申请卡片现在使用 `custom-auth:<requestId>:allow-task`，不再用普通 `allow-once` payload 承载“允许此任务”的文案。
- `handleCustomAuthInteraction()` 对 `allow-task` 增加 request 校验：只有带 `taskId` 的申请能生成 task-scoped grant，普通申请即使被手动改 payload 也会返回可见错误。
- 扩展 auth、slash gateway、interaction gateway 测试，覆盖 task 卡片 payload、task grant 写入，以及普通申请误用 `allow-task` 的拒绝路径。

加入长任务指令型状态卡片：

- `handleCustomTaskCommand()` 现在为创建、状态、追加、取消成功回复生成 QQ inline command keyboard；`/bot-task list` 仍保持轻量文本列表。
- 任务卡片按钮使用 QQ 指令型 action，不新增 callback 状态：查看/取消会直接发送 slash 命令，追加需求/新建任务只预填可编辑命令，避免静默提交不完整需求。
- `handleCustomSlashGatewayCommand()` 会把带 keyboard 的任务回复透出为 `kind="keyboard"`，复用现有 C2C/group keyboard 发送路径；客户端不支持时仍有文本中的 `<qqbot-cmd-input>` 兜底。
- 扩展 task gateway 和 slash gateway 测试，覆盖任务键盘内容、活跃/已取消任务按钮差异，以及任务回复从 text 变为 keyboard 的路由。

加入场景切换指令型卡片：

- `handleCustomSceneCommand()` 现在为 `/bot-scene status`、`/bot-scene list` 和成功的 `/bot-scene set <scene>` 生成 QQ inline command keyboard。
- 场景按钮使用 QQ 指令型 action 发送 `/bot-scene set <scene>`，不会绕过已有 `config.write` 鉴权；真正写入仍由 slash gateway 的场景持久化意图完成。
- `handleCustomSlashGatewayCommand()` 会把带 keyboard 的场景回复透出为 `kind="keyboard"`，复用现有 C2C/group keyboard 发送路径。
- 扩展 scene gateway 和 slash gateway 测试，覆盖场景列表按钮、当前场景高亮和场景回复 keyboard 路由。

加入兜底告警管理群指令型卡片：

- `buildCustomFallbackAlertDecision()` 现在随重复兜底告警返回 QQ inline command keyboard，管理群按钮只覆盖只读检查命令 `/bot-queue` 和 `/bot-fallback summary 20`。
- Gateway 发送 `customRuntime.adminGroup` 兜底告警时会优先使用 `sendGroupMessageWithInlineKeyboard()`，仍然先经过 proactive acceptance/budget guard；没有 keyboard 时继续走纯文本发送。
- 告警文本仍只包含聚合计数、队列计数和快捷命令，不包含原始错误、prompt、缓存消息正文或队列正文；`/compact` 和 `/new` 仍应在原故障会话执行，避免管理群命令作用到管理群自己的队列/会话。
- 扩展 `tests/custom-fallback-alerts.test.ts` 覆盖告警卡片结构和只读检查按钮 payload。

增强长任务命令执行器的追加需求通道：

- `customRuntime.tasks.commandExecutor` 新增 `forwardRequirementsToStdin`，默认关闭以保持现有命令执行器行为。
- 开启后，运行中的 `CustomTaskCommandExecutor` 会保持子进程 stdin 打开，`/bot-task add` 仍先持久化到任务状态/工作区，再把追加需求作为一行 JSON 转发到子进程 stdin。
- 这给后续真实 OpenClaw/subagent runner 提供了轻量协议：主群聊不被长任务阻塞，同时可以继续引导任务追加需求。
- 扩展 `tests/custom-task-command-executor.test.ts`，用真实 Node 子进程验证追加需求能通过 stdin 到达执行器并进入最终结果。

补齐场景绑定的 agent 路由运维入口：

- `/bot-scene set <scene>` 现在支持 `--agent <agentId>` 和 `--clear-agent`，可以在聊天里把当前群/单聊绑定到指定 OpenClaw agent 或恢复默认路由。
- 该能力仍走 `/bot-scene set` 的 `config.write` 鉴权和 gateway 持久化路径，不绕过现有管理员/临时授权机制。
- `/bot-scene status` 和 `/bot-scene bindings` 会显示当前 agent override，方便审计 codex-only/chat/system-admin/dev-lab 等场景实际会路由到哪个 agent。
- 扩展 `tests/custom-scene-gateway-adapter.test.ts`，覆盖 agent 参数解析、写入、状态展示和清除。

新增第一版轻量小游戏卡片：

- Added `src/custom/game.ts` as a pure local game runtime, starting with a guess-number game over 1-4.
- Added `src/custom/game-store.ts` for atomic JSON persistence under `~/.openclaw/qqbot/data/custom-games/games-<accountId>.json`.
- Added `src/custom/game-gateway-adapter.ts` to parse `/bot-game` commands and handle `custom-game:<gameId>:guess:<1-4>` button callbacks.
- Gateway state composition now restores and persists game state alongside auth/proactive/task/poll/unread state.
- `/bot-game guess` replies with C2C/group inline keyboard buttons when available; list/status/close remain text-compatible fallbacks.
- Game callbacks use the same account/peer visibility rule as polls: original peer can interact, the creator can interact across peers, and ordinary cross-peer replays are denied without leaking the answer.
- Slash-command capability metadata gates `/bot-game` list/status through `system.status` and guess/close through `game.interact`.
- Added tests for game runtime, game store, game gateway adapter, slash/interaction aggregate adapters, message-flow state restore/persist, and slash capability mapping.

同步复核初始化配置目标：

- 当前分支已有 `src/onboarding.ts` / `scripts/apply-custom-runtime-init.mjs` 初始化路径，首次配置必须绑定 `customRuntime.admins` 和 `customRuntime.adminGroup`。
- `qqbotPlugin.setup.validateInput` 缺管理员或管理群会返回初始化错误；交互式 onboarding 会提示补齐两者。
- 写入管理群时仍自动为该群创建默认 `system-admin` scene 绑定，保留已有显式 scene override。

抽出自定义互动卡路由表：

- Added `src/custom/interaction-router.ts` as the ordered route table for callback-card payloads.
- `src/custom/interaction-gateway-adapter.ts` now stays as a thin gateway boundary: normalize QQ source fields, call the router, and return typed reply/persist/log effects.
- Auth, poll, game, and deploy-confirmation callback payloads are routed without widening `gateway.ts`.
- Added `tests/custom-interaction-router.test.ts` for default route order, unknown payload fallback, custom route injection, and first-handled short circuit behavior.

抽出自定义 slash 命令路由表：

- Added `src/custom/slash-router.ts` as the ordered route table for scene/fallback/queue/unread/task/poll/game/deploy commands.
- `src/custom/slash-gateway-adapter.ts` now focuses on `/bot-auth`, task-scoped auth, general slash auth, and merging typed effects returned by the router.
- Task workspace effects, task notification deliveries, scene config persistence intents, and poll/game/deploy-confirmation persistence flags are now produced from the route layer after authorization has passed.
- Future custom slash commands can be added as routes without widening `gateway.ts` or the authorization gate.
- Added `tests/custom-slash-router.test.ts` for default route order, unknown command fallback, custom route injection, first-handled short circuit behavior, and a real `/bot-game guess` route.

加入安全部署确认卡骨架：

- Added `src/custom/deploy-confirmation.ts` as a pure local confirmation runtime for guarded `/bot-upgrade ...` commands.
- Added `src/custom/deploy-confirmation-store.ts` for atomic JSON persistence under `~/.openclaw/qqbot/data/custom-deploy-confirmations/deploy-confirmations-<accountId>.json`.
- Added `src/custom/deploy-confirmation-gateway-adapter.ts` to parse `/bot-deploy confirm /bot-upgrade ...`, list/status confirmations, and handle `custom-deploy:<confirmationId>:confirm|cancel` callbacks.
- `/bot-deploy` is auth-gated through slash capability metadata: list/status/help require `deploy.check`, while confirm/plan require `deploy.apply`.
- Confirmation buttons only record `confirmed` or `cancelled` state and send a safety reply. They do not execute hot reload, restart the gateway, or call `/bot-upgrade`; after confirmation the admin must manually send the confirmed `/bot-upgrade ...` command in private chat after backup.
- Gateway restores and persists deploy-confirmation state alongside auth/proactive/task/poll/game/unread state, and interaction callbacks persist only when they mutate confirmation state.
- Callback visibility follows the same safe account/peer rule used by poll/game cards: original peer can interact, the creator can inspect/interact across peers, and ordinary cross-peer replay gets a generic not-current-session response.
- Added tests for deploy confirmation runtime, store, gateway adapter, slash/interaction routers, slash gateway auth gating, message-flow state restore/persist, interaction persistence, and slash capability mapping.

把二开版本检查连接到管理群判断流程：

- `src/custom/update-check.ts` now builds a management-group notification for `update-available` results when `customRuntime.enabled=true` and `customRuntime.adminGroup` is bound.
- `startCustomUpdateCheckLoop()` accepts an `onUpdateAvailable` hook and deduplicates notifications by latest version within the current process, so repeated background checks do not spam the management group.
- `gateway.ts` sends the notification through the same custom proactive guard used by auth/fallback management pushes, then records proactive budget only after the QQ send succeeds.
- The notification card contains QQ command buttons for `/bot-version` and `/bot-deploy confirm /bot-upgrade --latest`. It still does not call `/bot-upgrade`, restart the gateway, or install packages.
- Extended `tests/custom-update-check.test.ts` to cover notification construction, missing runtime/admin-group suppression, and per-version notification dedupe.

工具化官方 upstream 更新审查：

- Added `scripts/inspect-upstream-updates.mjs` as a read-only local review helper for `custom-runtime...upstream/main`.
- The script can fetch upstream refs, report custom-only/upstream-only commit counts, list upstream-only commits and changed files, and classify high-risk files such as `src/gateway.ts`, `src/slash-commands.ts`, `package.json`, send/transport code, and upgrade scripts.
- It never merges, cherry-picks, installs, restarts, or touches the deployed OpenClaw instance; it only prints or writes Markdown.
- Current fetched state on 2026-06-21: `custom-runtime` is 92 commits ahead of `upstream/main` and 0 commits behind, so no official upstream merge is needed right now.
- Added `tests/upstream-review-script.test.mjs` for count parsing, name-status parsing, risk classification, CLI args, and Markdown output.

加入二开部署前只读预检：

- Added `scripts/preflight-custom-runtime-deploy.mjs` to inspect an OpenClaw config snapshot without writing config, installing packages, restarting gateway, or contacting the server.
- `--require-ready` exits `2` when blocking deploy risks exist: missing QQBot credentials, missing `customRuntime.admins`, missing `customRuntime.adminGroup`, official update package source, or active duplicate/legacy QQBot plugin entries.
- The preflight also warns on `customRuntime.enabled=false`, missing management-group scene binding, `upgradeMode=hot-reload`, `allowUpgradePkgOverride=true`, missing/disabled `customUpdateCheck`, and leftover official/legacy QQBot extension directories under `~/.openclaw/extensions`.
- JSON output is available for future deployment checklists or OpenClaw admin cards; text output is Chinese and explicitly states the script is read-only.
- Added `tests/custom-runtime-deploy-preflight.test.mjs` for package-source classification, duplicate plugin detection, management-anchor blockers, extension-dir warnings, CLI JSON output, and `--require-ready` exit code.

增强长任务进度状态协议：

- `CustomSandboxTask` 新增 `progress` 元数据，记录 phase/message/percent/updatedAt；`CustomTaskSandboxRuntime.updateTaskProgress()` 会同步更新时间和 heartbeat。
- `progressCustomTaskExecution()` 将 executor 进度事件写入 task state 与 `status.json`，并产生 `task-progress` effect；gateway 的命令执行器回调会持久化该状态。
- `CustomTaskCommandExecutor` 现在可以从 stdout 解析 `QQBOT_TASK_PROGRESS {...}` 或 `{"type":"qqbot.task.progress",...}` JSON 行，作为未来 OpenClaw/subagent runner 的轻量进度协议。
- `/bot-task status` 输出执行器、run id、agent、heartbeat 和最新进度；完成/失败/取消通知也会携带最新进度摘要。
- 扩展 task sandbox、executor adapter、command executor、gateway adapter、notification、workspace 测试，覆盖进度解析、状态持久化和状态展示。

加入长任务工作区只读清理规划：

- Added `src/custom/task-cleanup.ts` to build a cleanup plan for terminal long tasks without deleting files or mutating runtime state.
- `/bot-task cleanup [--older-than 7d] [--limit 10]` now lists old completed/failed/cancelled tasks for the current account/peer and shows their workspace paths for audit.
- The command is intentionally read-only and uses `system.status`; future destructive cleanup still needs `--force`, admin confirmation, and backup guardrails.
- Added `tests/custom-task-cleanup.test.ts` and expanded task gateway/capability tests for cleanup duration parsing, bounded planning, current-peer scope, and read-only slash capability.

加入聊天内部署预检摘要：

- Added `src/custom/deploy-preflight.ts` as a pure in-runtime safety summary for `/bot-deploy preflight`.
- The command checks the live config object for admin/admin-group anchors, `customRuntime.enabled`, management-group scene binding, personal update package source, hot-reload/override settings, custom update check config, and duplicate/legacy QQBot plugin entries.
- It is read-only and uses `deploy.check`; it does not run shell commands, inspect extension directories, install packages, restart gateway, delete files, or mutate config.
- The preflight response now includes QQ command buttons: refresh/version always; create-confirm-card only when blockers are zero; auth/scene diagnostics when blockers exist.
- Server-side deployment still requires `scripts/preflight-custom-runtime-deploy.mjs --require-ready` plus backup because chat preflight cannot see filesystem-level leftovers.
- Added `tests/custom-deploy-preflight.test.ts` and expanded deploy gateway/capability tests.

把二开版本更新通知串到预检流程：

- The custom update-available management-group card now includes a `/bot-deploy preflight` command button between `/bot-version` and `/bot-deploy confirm /bot-upgrade --latest`.
- Update notification text explicitly recommends running the in-chat preflight before creating a confirmation card.
- This still never calls `/bot-upgrade`, installs packages, restarts gateway, or touches the server; it only guides the admin through the safer manual review path.
- Expanded `tests/custom-update-check.test.ts` for the preflight button and text.

继续降低主动推送 gateway 耦合：

- Added `src/custom/proactive-gateway-adapter.ts` as the single gateway-facing builder for custom proactive guards.
- `gateway.ts` no longer hand-builds proactive budget checks/records in multiple send paths; management-group pushes, reply-dispatcher unanchored sends, task notifications, and media forwarding now reuse the same guard builder.
- The adapter still does not send QQ messages or own stores; it only resolves scene/runtime proactive config, checks budget/receive state, formats block reasons, and commits persistence after the caller confirms a successful send.
- Added `tests/custom-proactive-gateway-adapter.test.ts` for enabled/runtime-disabled/scene-disabled guard behavior and successful budget persistence.

抽出管理群推送发送适配器：

- Added `src/custom/admin-group-delivery-gateway-adapter.ts` for guarded management-group delivery of auth approval copies, fallback alerts, and custom update notifications.
- `gateway.ts` now builds typed delivery descriptions and delegates shared proactive guard application, send success commit, cooldown handling, and sent/blocked/skipped/failed logging to the adapter.
- The adapter receives QQ send callbacks, so it still does not import QQ API functions or own network side effects; it only coordinates policy gates around the caller-confirmed send result.
- Added `tests/custom-admin-group-delivery-gateway-adapter.test.ts` for keyboard sends, proactive blocks, cooldown skips, and failed sends without budget commits.

抽出 fallback 记录与告警触发适配器：

- Added `src/custom/fallback-record-gateway-adapter.ts` to centralize sanitized fallback event logging, JSON persistence, recent-event loading, and repeated-fallback alert decision wiring.
- `gateway.ts` no longer imports fallback event store helpers or alert decision policy directly; urgent queue bypass and dispatch timeout/context/tool fallback paths share the same recorder.
- The recorder accepts an alert delivery callback and still does not send QQ messages; management-group delivery remains behind `admin-group-delivery-gateway-adapter` and its proactive guard.
- Added `tests/custom-fallback-record-gateway-adapter.test.ts` for below-threshold persistence, threshold alert creation, prebuilt urgent events, and runtime-disabled alert skipping.

抽出 dispatch fallback 状态跟踪器：

- Added `src/custom/fallback-dispatch-state.ts` as a pure per-dispatch tracker for response/block state, model-output visibility, timeout state, tool deliver counts, tool text/media collections, block-media dedupe, and tool-only renewal counters.
- `gateway.ts` now keeps timer handles and QQ sends locally, but reads fallback snapshots from the tracker when recording timeout/context/tool fallback events.
- This reduces mutable fallback counters in the main dispatch loop and keeps the state reusable for later inbound normalization or runner-specific dispatch adapters.
- Added `tests/custom-fallback-dispatch-state.test.ts` for response/block flags, tool collection counts, media dedupe, renewal limits, timeout state, and model-output visibility.

抽出 QQ 入站事件归一化：

- Added `src/custom/inbound-event-normalizer.ts` to convert C2C/group/guild/channel-DM message events into the shared `QueuedMessage` shape before queueing.
- The normalizer also emits known-user records, proactive receive/reject acceptance updates, and group robot add/remove log metadata without mutating stores or sending messages.
- `gateway.ts` now applies normalized effects instead of hand-building every C2C/group/channel/DM queued message inline; message delete diagnostics and interaction handling remain separate for now.
- Added `tests/custom-inbound-event-normalizer.test.ts` covering C2C quote refs, group mentions/openids, guild and DM routing fields, proactive acceptance timestamps, group add records, and unsupported events.

抽出 QQ interaction/button 事件归一化：

- Added `src/custom/interaction-event-normalizer.ts` to normalize `INTERACTION_CREATE` id/type/scene/button payload, actor id, callback source peer, and follow-up reply target.
- The normalizer also parses legacy `approve:<id>:allow-once|allow-always|deny` payloads so gateway no longer owns button regex details.
- `gateway.ts` now feeds custom auth/poll/game/deploy callbacks with normalized actor/source/button fields; config query/update ACK logic still owns the framework `claw_cfg` payload.
- Added `tests/custom-interaction-event-normalizer.test.ts` covering group/C2C/channel/DM fallback source mapping, reply target mapping, and legacy approval payload parsing.

补充 QQ 事件字段矩阵：

- `docs/custom-runtime/qqbot-message-flow.md` 新增 `Normalized Event Field Matrix`，按事件列出归一化模块、peer key、actor 字段、消息/展示字段、runtime effect 和验证状态。
- 矩阵覆盖 C2C、群聊、频道、频道私信、互动按钮、主动消息接收/拒收、机器人入/退群、频道删除诊断事件。
- 明确区分“本地归一化已覆盖”“服务器持久数据已观察”“官方文档存在但本环境未观测”“仍需实测”，避免后续策略误依赖尚未在部署环境验证的字段。
- `runtime-architecture.md` 改为引用该字段矩阵作为 QQ 事件字段依赖的权威检查点；本轮未 SSH、未部署、未触碰服务器。

抽出 QueuedMessage 身份映射边界：

- Added `src/custom/queued-message-context.ts` as the shared pure mapper from gateway `QueuedMessage` values to custom `peer` / `actor` identities.
- Auth、scene、task、poll、game、deploy 和 urgent fallback diagnostics 现在直接复用该 mapper，避免为了拿 peer/actor 而依赖 `auth-gateway-adapter.ts`。
- `auth-gateway-adapter.ts` 暂时保留 re-export 兼容已有调用；新 adapter 应直接从 `queued-message-context.ts` 导入。
- Added `tests/custom-queued-message-context.test.ts` for C2C/group/guild/channel-DM peer mapping, queue-peer fallback, actor mapping, and prefix stripping.

抽出 gateway 消息路由上下文：

- Added `src/custom/gateway-message-routing.ts` to resolve per-message queue peer id, framework route peer, custom scene peer, `From` / `To` address, request target, and reply target from `QueuedMessage`.
- `gateway.ts` now uses that helper around agent route resolution, custom scene lookup, request-context target, and reply target construction instead of repeating event-type conditionals inline.
- The helper intentionally preserves current guild/channel-DM compatibility behavior while making it explicit and covered by tests; channel-DM custom scene/media/card behavior remains marked unaudited.
- Added `tests/custom-gateway-message-routing.test.ts`.

抽出普通消息鉴权拒绝发送适配器：

- Added `src/custom/dispatch-auth-delivery-gateway-adapter.ts` to own ordinary-dispatch auth denial delivery decisions.
- The adapter prefers C2C/group approval cards, falls back to visible denial text when card delivery fails or the target does not support custom cards, and returns the management-group notification intent for gateway delivery.
- `gateway.ts` now keeps only token/QQ send callbacks and management-group delivery orchestration; approval-card text/keyboard construction and fallback choice live outside the main dispatch loop.
- Added `tests/custom-dispatch-auth-delivery-gateway-adapter.test.ts` for card send, text fallback, admin-group copy intent, no-request denial, and runtime-disabled no-op behavior.

抽出 fallback 记录上下文构造：

- Added `src/custom/fallback-record-context.ts` to build sanitized fallback record inputs from `QueuedMessage`, queue snapshot, dispatch-state snapshot, session key, timeout/reason metadata, and extra details.
- The helper reuses message routing and queued-message identity mapping so fallback peer/actor fields stay aligned with scene/auth routing.
- `gateway.ts` now only collects current snapshots and delegates fallback record shape construction before calling `recordCustomFallbackEventGateway()`.
- Added `tests/custom-fallback-record-context.test.ts` for group, C2C, and guild fallback record identity plus queue/dispatch counter fields.

抽出入站媒体上下文构造：

- Added `src/custom/inbound-media-context.ts` to build compact image/voice/ASR dynamic context, voice summary counters, ASR fallback status, and local/remote media split after attachment processing.
- `gateway.ts` now delegates voice path/url/ASR dedupe, transcript source counting, dynamic media prompt lines, and media path/url partitioning to that helper.
- The helper is pure and does not read config, filesystem, QQ APIs, OpenClaw runtime state, or custom stores; it only reshapes already-processed attachment metadata for the message-flow pipeline.
- Added `tests/custom-inbound-media-context.test.ts` for dedupe, STT/ASR/fallback counts, dynamic context formatting, voice summary formatting, and local/remote media partition.

抽出引用消息/ref-index 上下文构造：

- Added `src/custom/message-reference-context.ts` to resolve inbound quote context from local `ref-index` cache or QQ `msg_elements[0]`, and to build current-message ref-index records.
- `gateway.ts` now delegates quote prompt fragment generation, `ReplyTo*` fields, quote log message text, attachment summary creation, and voice transcript attachment metadata to this helper.
- The helper remains pure around side effects: it accepts cache/formatter callbacks and returns the ref-index record, while `gateway.ts` still owns `getRefIndex()`, `formatMessageReferenceForAgent()`, and `setRefIndex()`.
- Added `tests/custom-message-reference-context.test.ts` for cache hit, quote element fallback, missing quote body, non-quote refs, outbound current-message ref records, and InputNotify fallback ref ids.

## 2026-06-22

抽出群消息门控上下文构造：

- Added `src/custom/group-message-gate-context.ts` to own group message gate context derivation for command text normalization, any-mention fallback detection, quoted-bot implicit mention, and synthetic unread catch-up overrides.
- `gateway.ts` now delegates text-command enablement, implicit quote mention lookup wrapping, mention presence detection, and synthetic unread gate overrides before reading the existing `resolveGroupMessageGate()` result.
- The helper remains pure around side effects: gateway still owns session activation reads, ref-index cache reads, unread/history persistence, logging, framework command detection, and all QQ/OpenClaw sends.
- Added `tests/custom-group-message-gate-context.test.ts` for text-command config, mention fallback detection, implicit mention, skip/drop/block/pass gate outcomes, command bypass, and synthetic unread catch-up pass-through.

抽出群激活模式/session-store 边界：

- Added `src/custom/group-activation.ts` to resolve OpenClaw `/activation` session-store paths and normalize per-session `groupActivation` values to `mention` or `always`.
- `gateway.ts` no longer owns session-store path expansion or JSON parsing; it passes cfg, agent id, and session key into the helper and keeps only the resulting activation mode.
- The helper preserves current fallback behavior: missing store files, invalid JSON, missing session entries, and invalid activation values fall back to the group config's `requireMention` default.
- Added `tests/custom-group-activation.test.ts` for default mode selection, store path expansion, env state-dir fallback, valid session overrides, invalid/missing fallback, and injected reader failure handling.

抽出群提示与元数据上下文：

- Added `src/custom/group-prompt-context.ts` to assemble group sender labels, group subject, intro hint, behavior prompt, and merged system-prompt fragments outside `gateway.ts`.
- `gateway.ts` now keeps config/plugin resolver callbacks at the boundary but delegates prompt string joining and sender/group metadata formatting to the helper before `finalizeInboundContext()`.
- The helper has no QQ API, OpenClaw runtime, filesystem, unread, or auth dependencies; it only formats already-resolved group message metadata and injected prompt pieces.
- Added `tests/custom-group-prompt-context.test.ts` for sender label formatting, prompt trimming/merge behavior, injected resolver wiring, empty prompt fallback, and static+group system prompt merging.

抽出当前消息正文/合并消息上下文构造：

- Added `src/custom/agent-message-body-context.ts` to build the formatted current `userMessage` and initial `agentBody` outside `gateway.ts`.
- The helper preserves single group sender prefixes, C2C/direct no-prefix behavior, mention tags, quote fragments, dynamic context prefixing, slash-command raw-body bypass, and merged group message context blocks.
- `gateway.ts` now injects only sub-message formatting and framework envelope callbacks; face/mention/attachment parsing, envelope options, unread-history injection, and final `finalizeInboundContext()` still remain at the gateway boundary.
- Added `tests/custom-agent-message-body-context.test.ts` for single group, command bypass, C2C quote body, merged group messages, duplicate sender id handling, and missing merged payload fallback.

收窄 agentBody 未读历史注入边界：

- Added `applyCustomUnreadHistoryContextToAgentBody()` in `src/custom/unread-context.ts` so group history injection, direct-message no-op behavior, and selected history source reporting are handled behind the unread context adapter.
- `gateway.ts` now only resolves the group history limit and provides the framework envelope formatter callback; custom snapshot/mention/legacy history selection and no-op handling stay outside the main dispatch flow.
- The helper preserves current behavior for non-group/C2C messages by returning the initial agent body unchanged without invoking the envelope formatter.
- Expanded `tests/custom-unread-context.test.ts` to cover agentBody history injection and direct-message no-op behavior.

抽出 finalizeInboundContext 入站 payload 构造：

- Added `src/custom/inbound-context-payload.ts` to build the object passed into OpenClaw `finalizeInboundContext()` from normalized message, routing, media, voice, quote, auth, and group prompt fields.
- `gateway.ts` now keeps the actual framework `finalizeInboundContext()` call, but no longer owns the large literal object or the conditional media/quote field spread logic.
- The helper preserves optional-field behavior for group metadata, local/remote media, quote `ReplyTo*` fields, and static QQBot + group prompt merging.
- Added `tests/custom-inbound-context-payload.test.ts` for group payload metadata, voice/media/quote fields, system prompt merging, direct-message group-field suppression, and absent optional media/quote fields.

抽出回复锚点与 ReplyContext 构造：

- Added `src/custom/reply-context-gateway-adapter.ts` to resolve reply anchors, reply targets, and `ReplyContext` values for normal dispatch messages.
- Synthetic custom unread catch-up messages continue to clear the passive reply anchor, so they use unanchored/proactive-guarded sends instead of replying to stale source messages.
- `gateway.ts` now injects the unanchored-text proactive guard into the adapter result and keeps token retry, error sends, auth-denial delivery, and platform sends at the gateway boundary.
- Added `tests/custom-reply-context-gateway-adapter.test.ts` for group targets, C2C targets, synthetic anchor clearing, and guard callback propagation.

抽出 outbound deliver 上下文构造：

- Added `src/custom/outbound-deliver-context.ts` to build `DeliverEventContext`, `DeliverAccountContext`, and proactive guard source metadata from queued messages.
- `gateway.ts` now keeps actual platform sends, token retry, media auto-send, and proactive guard creation, but no longer owns the deliver event/account object literals.
- The helper preserves reply anchor propagation, synthetic unanchored sends, group/channel ids, `msgIdx`, qualified target, logger, and injected proactive guard identity.
- Added `tests/custom-outbound-deliver-context.test.ts` for group/guild deliver events, account context packaging, unanchored reply handling, and proactive source metadata.

抽出 guarded media auto-send 适配器：

- Added `src/custom/guarded-media-send-gateway-adapter.ts` to centralize proactive media guard checks, blocked-send logging, media send callback invocation, and budget commit handling for auto-routed media sends.
- `gateway.ts` now keeps the actual `sendMediaAuto()` dependency and platform side effects, but no longer repeats guard/block/send/commit logic inside the main dispatch closure.
- The adapter preserves passive reply behavior: anchored media sends bypass proactive budget checks, while unanchored media sends are checked and committed only after a successful send.
- Added `tests/custom-guarded-media-send-gateway-adapter.test.ts` for anchored passive media, allowed unanchored media, blocked media, and send-error no-commit behavior.

抽出 dispatch 发送 helper 绑定：

- Added `src/custom/dispatch-send-helpers-gateway-adapter.ts` to bind account credentials, account id, logger, and `ReplyContext` into reusable `sendWithRetry` and `sendErrorMessage` callbacks.
- `gateway.ts` now delegates token-retry/error-message helper construction, while still owning actual approval card sends, fallback notices, media-tag delivery, and plain reply side effects.
- The adapter accepts injected `sendWithTokenRetry()` and `sendErrorToTarget()` callbacks for tests, but defaults to `reply-dispatcher.ts` at runtime.
- Added `tests/custom-dispatch-send-helpers-gateway-adapter.test.ts` for bound credential/log/account arguments, token forwarding, and ReplyContext error-send routing.

抽出普通 dispatch 鉴权编排：

- Added `src/custom/dispatch-authorization-gateway-adapter.ts` to orchestrate ordinary message dispatch authorization, auth-intent logging/persistence, denial delivery, and management-group notification forwarding.
- `gateway.ts` now delegates the auth check + denial branch and only reacts to the returned `shouldStop` flag by stopping typing and exiting the current message.
- The adapter still receives gateway-owned send callbacks for visible text, approval cards, and admin-group copies, so QQ API sends and token retry remain at the gateway boundary.
- Added `tests/custom-dispatch-authorization-gateway-adapter.test.ts` for approval-card denial, text fallback after card failure, admin-group `source=dispatch` forwarding, persistence/logging, and runtime-disabled pass-through.

抽出 dispatch fallback 记录器绑定：

- Added `createCustomDispatchFallbackRecorder()` in `src/custom/fallback-record-gateway-adapter.ts` to bind account/message/session/runtime/snapshot callbacks once per dispatch.
- `gateway.ts` no longer imports `buildCustomFallbackRecordInput()` or fallback event detail types directly; it only invokes the returned recorder with kind/reason/details at timeout/tool-fallback sites.
- Snapshot reads remain lazy per fallback event through injected queue/dispatch callbacks, so persisted diagnostics still include current queue pressure and dispatch counters.
- Added adapter coverage in `tests/custom-fallback-record-gateway-adapter.test.ts` for recorder-created events, session key propagation, queue/dispatch counters, and callback invocation counts.

同步新增初始化目标：

- 已确认当前分支把首次初始化必须绑定 `customRuntime.admins` 和 `customRuntime.adminGroup` 作为硬约束：`src/onboarding.ts` 的 setup/onboarding 校验、`scripts/apply-custom-runtime-init.mjs`、README/升级文档、preflight 均已覆盖。
- 本轮复跑 `tests/custom-onboarding.test.ts` 通过，继续保持“缺管理员或管理群=未完整初始化”的目标；管理群写入时仍默认绑定 `system-admin` 场景且保留已有 scene override。

抽出 tool-only fallback 发送适配器：

- Added `src/custom/tool-fallback-gateway-adapter.ts` to own the gateway-side fallback delivery order for tool-only runs: media first, then selected text, then no-output notice.
- `gateway.ts` now delegates `sendToolFallback()` to the adapter and only passes current fallback state plus injected media/text send callbacks, keeping QQ API/token retry at the boundary.
- The adapter records the concrete fallback event (`tool-fallback-media` / `tool-fallback-text` / `tool-fallback-no-output`) through the existing dispatch fallback recorder and preserves per-media timeout/error logging.
- Added `tests/custom-tool-fallback-gateway-adapter.test.ts` for media forwarding, media timeout, text fallback selection, and no-output notice behavior.

抽出 tool deliver/timer 编排适配器：

- Added `src/custom/tool-deliver-gateway-adapter.ts` to observe tool deliver callbacks, immediately forward post-block tool media, and manage tool-only timeout scheduling decisions.
- `gateway.ts` now stores/clears only the current tool-only timer handle; tool deliver collection, block-media dedupe, renewal-limit checks, timeout event recording, completion-no-block recording, and fallback callback triggering live in the adapter.
- The adapter still receives guarded media send and `sendToolFallback()` as injected callbacks, so QQ sends, proactive budget, token retry, and visible fallback notices remain outside the pure state tracker.
- Added `tests/custom-tool-deliver-gateway-adapter.test.ts` for timer start, timeout callback, renewal, renewal limit, post-block media forwarding, media dedupe, already-sent fallback, and dispatch-complete no-block behavior.

抽出 dispatch race failure 兜底编排：

- Added `src/custom/dispatch-failure-gateway-adapter.ts` to handle `Promise.race([dispatch, timeout])` failures for response-timeout and context-too-long.
- `gateway.ts` now clears the timeout handle locally, then delegates fallback event recording, recovery notice sending, and response/timeout state marking to the adapter.
- The adapter skips duplicate notices when a block response or tool fallback already handled the user, preserving queue recovery without double-sending fallback text.
- Added `tests/custom-dispatch-failure-gateway-adapter.test.ts` for timeout notices, context-too-long notices, block/tool-fallback skips, send failures, and other ignored errors.

收敛 dispatch callback/processing 错误处理：

- Extended `src/custom/dispatch-failure-gateway-adapter.ts` to also handle dispatcher `onError` and outer message-processing failures.
- `gateway.ts` now delegates framework runtime module notices, context-too-long fallback records, AI auth/process error logs, and best-effort outer failure notices to the adapter.
- The framework/runtime-module recovery text is centralized, avoiding duplicated `root-alias.cjs` handling in both callback and outer catch paths.
- Expanded `tests/custom-dispatch-failure-gateway-adapter.test.ts` for callback framework errors, callback context-too-long, auth-only logs, outer framework notices, outer context notice failures, and ignored ordinary processing errors.

抽出 dispatch deliver 前置处理：

- Added `src/custom/dispatch-deliver-gateway-adapter.ts` to own late-deliver-after-timeout recording, group model-skip checks, block-response state marking, typing stop, and response/tool timer cleanup.
- `gateway.ts` now delegates deliver preflight before streaming/debounce/plain-send handling, so the main dispatch callback keeps only tool/streaming/send boundaries.
- The adapter keeps QQ/OpenClaw sends out of scope and uses injected timer/typing callbacks, preserving the gateway-owned side-effect boundary.
- Added `tests/custom-dispatch-deliver-gateway-adapter.test.ts` for late deliver diagnostics, normal block readiness, group skip tokens, and C2C skip-token non-suppression.

抽出 streaming 回调编排：

- Added `src/custom/streaming-gateway-adapter.ts` to own `StreamingController` deliver/error/partial/finalize orchestration, debug logging, static fallback detection, and outbound activity callback invocation.
- `gateway.ts` still constructs `StreamingController` and keeps non-streaming static delivery, but no longer inlines `onDeliver()` / `onError()` / `onPartialReply()` / `onIdle()` handling.
- Streaming finalization now has a tested best-effort abort path when `onIdle()` fails, while degraded-to-static logging remains centralized in the adapter.
- Added `tests/custom-streaming-gateway-adapter.test.ts` for handled/fallback/static deliver paths, error handling, partial replies, finalization, abort cleanup, and already-terminal fallback logging.

抽出 static deliver 执行管线：

- Added `src/custom/static-deliver-gateway-adapter.ts` to own the non-streaming/static delivery order: media tags, structured payloads, then plain replies.
- `gateway.ts` now injects `parseAndSendMediaTags()`, `handleStructuredPayload()`, and `sendPlainReply()` into the adapter, preserving QQ send boundaries while removing quote-ref/activity/plain-send orchestration from the main dispatch callback.
- The adapter keeps single-use quote-ref behavior per deliver payload and records block-delivered media before plain replies so post-block tool media dedupe still works.
- Added `tests/custom-static-deliver-gateway-adapter.test.ts` for media-tag handled, structured handled, and plain-send paths including quote-ref consumption and outbound activity recording.

抽出 deliver debounce 调度：

- Added `src/custom/deliver-debounce-gateway-adapter.ts` to own debouncer creation/reuse/direct-dispatch branching for static deliver payloads.
- `gateway.ts` now only stores the current `DeliverDebouncer` handle and injects `createDeliverDebouncer()` plus the static deliver executor.
- Disabled debounce still falls through to direct static delivery when the factory returns `null`.
- Added `tests/custom-deliver-debounce-gateway-adapter.test.ts` for created debouncer, reused debouncer, and direct dispatch paths.

抽出 dispatch finally 收尾清理：

- Added `src/custom/dispatch-finalize-gateway-adapter.ts` to centralize ordinary dispatch `finally` cleanup for tool-only timer clearing, tool completion fallback, debouncer disposal, and streaming finalization.
- `gateway.ts` now keeps only mutable handles for `toolOnlyTimeoutId` and `debouncer`; the adapter owns the cleanup order and reuses the existing tool/streaming adapters.
- Unread runtime completion and outer typing cleanup intentionally remain in `gateway.ts` because they depend on group-history/runtime state beyond one dispatch send pipeline.
- Added `tests/custom-dispatch-finalize-gateway-adapter.test.ts` for timer clearing, completion fallback, debouncer disposal, streaming finalization, and no-op cleanup paths.

抽出 unread completion gateway 应用层：

- Added `src/custom/unread-completion-gateway-adapter.ts` to apply post-dispatch custom unread completion results through injected log/persist/scheduler callbacks.
- `gateway.ts` now delegates custom unread completion and legacy group-history clearing to the adapter, while still owning config-based history-limit resolution and runtime handles.
- The adapter preserves the fallback path: if custom unread does not handle the dispatch, legacy pending group history is cleared with the resolved history limit.
- Added `tests/custom-unread-completion-gateway-adapter.test.ts` for custom-handled persist/scheduler/log behavior, legacy clear fallback, and non-group no-op behavior.

抽出 custom slash reply 投递：

- Added `src/custom/slash-reply-delivery-gateway-adapter.ts` to own custom slash reply delivery branching for text, keyboard, and auth-approval replies.
- `gateway.ts` still owns token lookup and QQ API calls through injected text/keyboard/admin-group callbacks, while fallback-to-text and management-group copy ordering live in the adapter.
- Auth approval cards still fall back to denial text on card-send failure and continue forwarding approval requests to the bound management group with `source=slash`.
- Added `tests/custom-slash-reply-delivery-gateway-adapter.test.ts` for text replies, keyboard fallback, auth approval card success/failure, admin-group notification forwarding, and no-card denial text.

抽出 custom slash effects 应用层：

- Added `src/custom/slash-effects-gateway-adapter.ts` to apply handled custom slash side effects outside `gateway.ts`: logs, auth/task/poll/game/deploy state persistence, scene config writes, reply delivery, and task notification delivery logs.
- `gateway.ts` now only builds injected platform callbacks for text/card/admin-group/task-notification sends and delegates custom slash effect ordering to the adapter.
- Reply send failures remain non-fatal for task notifications, preserving the previous behavior where a failed command reply does not prevent cancellation/async task notification copies.
- Added `tests/custom-slash-effects-gateway-adapter.test.ts` for persistence callbacks, latest-config scene writes, reply failure isolation, task notification sent/skipped logging, and missing config API guardrails.

抽出 urgent queue bypass gateway 执行层：

- Added `src/custom/urgent-queue-bypass-gateway-adapter.ts` to own the gateway-side `/stop`、`/approve`、`/new`、`/compact` bypass sequence: detect command, snapshot queue, clear same-peer pending work, record `urgent-queue-bypass`, and execute immediately.
- `gateway.ts` now only passes normalized slash content plus queue/fallback-record callbacks, keeping context-too-long/timeout recovery bypass separate from custom slash routing and official slash matching.
- The pure `src/custom/urgent-commands.ts` still owns command-token policy and diagnostic event construction, while the new adapter owns queue side-effect ordering.
- Added `tests/custom-urgent-queue-bypass-gateway-adapter.test.ts` for urgent execution, dropped-message diagnostics, non-urgent no-op behavior, and C2C peer label propagation.

抽出 inbound event gateway 分发层：

- Added `src/custom/inbound-event-gateway-adapter.ts` to own WebSocket/Webhook shared inbound fanout for normalized messages, proactive acceptance updates, group robot events, delete diagnostics, and interaction handoff.
- `gateway.ts` now injects known-user recording, message enqueueing, proactive-budget persistence, and interaction handling callbacks instead of branching on every QQ event type directly.
- The adapter keeps message/delete/interaction field normalization in the existing focused helpers while moving side-effect ordering into a testable gateway boundary.
- Added `tests/custom-inbound-event-gateway-adapter.test.ts` for C2C enqueue/known-user records, group proactive acceptance persistence, group robot records, delete diagnostics, interaction logging/error handling, and unsupported events.

抽出 custom interaction effects 应用层：

- Added `src/custom/interaction-effects-gateway-adapter.ts` to apply handled custom callback-card effects outside `gateway.ts`: logs, auth/poll/game/deploy-confirmation persistence, and follow-up reply delivery.
- `gateway.ts` now only builds the QQ ACK, custom interaction routing input, normalized reply target, and platform send callback; effect ordering lives in the adapter.
- Reply-send failures are logged by the adapter after persistence callbacks run, preserving callback state updates even if QQ follow-up reply delivery fails.
- Added `tests/custom-interaction-effects-gateway-adapter.test.ts` for persistence callbacks, group/C2C/channel reply targets, missing-target skip behavior, send failure logging, and optional persistence callbacks.

抽出长任务执行 effects 应用层：

- Added `src/custom/task-execution-effects-gateway-adapter.ts` to apply command-executor task effects outside `gateway.ts`: effect logging, notify-effect to delivery mapping, async task persistence, and delivery result logging.
- `gateway.ts` now only injects task runtime, persistence callback, proactive-guarded text sender, and account logger when command-executor complete/fail callbacks return effects.
- Async completion/failure notifications still require explicit unanchored opt-in and the gateway keeps using the same proactive acceptance/budget guard before sending C2C/group notices.
- Added `tests/custom-task-execution-effects-gateway-adapter.test.ts` for effect-to-delivery mapping, missing-task skip behavior, anchored sends, unanchored group/channel policy, empty no-op, and async failure logging.

抽出 QQ config interaction ACK 处理：

- Added `src/custom/config-interaction-gateway-adapter.ts` to handle official QQ config interaction query/update types `2001`/`2002` outside `gateway.ts`.
- The adapter builds `claw_cfg` ACK payloads, resolves group policy/require-mention/mention patterns with scene-aware agent routing, and applies `require_mention` updates for default or named accounts through an injected config API.
- `gateway.ts` now only injects config API, routing, plugin/framework versions, and the QQ ACK callback while keeping token ownership at the boundary.
- Added `tests/custom-config-interaction-gateway-adapter.test.ts` for query ACKs, default-account updates, named-account updates, no-change updates, version parsing fallback, and non-config interaction no-op behavior.

抽出 C2C typing keepalive 网关适配器：

- Added `src/custom/typing-keepalive-gateway-adapter.ts` to start C2C input-notify asynchronously, retry token-expired failures, start `TypingKeepAlive`, and expose a small stop handle.
- `gateway.ts` now only injects token/cache callbacks and awaits the returned refIdx promise when building the current-message ref-index record.
- Group/guild messages remain no-op because current QQ input-notify support is C2C-only; auth denial, block delivery, and final cleanup now call the adapter's `stop()` handle.
- Added `tests/custom-typing-keepalive-gateway-adapter.test.ts` for non-C2C no-op, success/refIdx capture, keepalive start/stop, token-refresh retry, and non-token failure logging.

同步新增初始化目标并抽出 group ingress 网关应用层：

- 已复核新增目标：首次初始化仍必须绑定 `customRuntime.admins` 和 `customRuntime.adminGroup`；`src/onboarding.ts`、`scripts/apply-custom-runtime-init.mjs`、setup 校验和 preflight 均保持缺管理员/管理群即未完整初始化。
- Added `src/custom/group-ingress-gateway-adapter.ts` to own skipped group message ingress side effects, including custom unread recording, legacy group-history fallback, scheduler/persist callbacks, and existing-equivalent logs.
- `gateway.ts` now delegates `drop_other_mention`、`skip_no_mention` 和 mention ingress/catch-up metadata extraction to the adapter, removing the local custom unread/legacy history closures from the group gate path.
- The adapter preserves the previous fallback boundary: custom unread handles scene-enabled peers first; peers without custom unread still write legacy pending history with attachment summaries.
- Added `tests/custom-group-ingress-gateway-adapter.test.ts` for custom unread skipped messages, legacy fallback with attachments, mention catch-up metadata, and disabled-runtime no-op behavior.

抽出 slash prequeue 网关编排层：

- Added `src/custom/slash-prequeue-gateway-adapter.ts` to own slash 入队前编排：群聊 mention 清理后的 `/command` 识别、紧急命令绕队列、custom slash effect 应用、官方 slash 匹配、delegate 入队和文件回复目标解析。
- `gateway.ts` now injects token-based QQ text/keyboard/file send callbacks and state persistence callbacks into the adapter, removing the inline slash command try/catch flow from the main gateway body.
- The adapter preserves ordering: `/stop`、`/approve`、`/new`、`/compact` 先于 custom slash 和官方 slash，custom slash 先于官方插件命令，未知 slash 继续入队交给框架。
- Added `tests/custom-slash-prequeue-gateway-adapter.test.ts` for non-slash enqueue, urgent bypass, custom slash reply, official slash null/delegate/text/file replies, mention-stripped commands, and error fallback enqueue.

抽出 group dispatch 网关门控编排层：

- Added `src/custom/group-dispatch-gateway-adapter.ts` to own group dispatch gate orchestration: allow-list check, mention/activation/implicit-mention/control-command gate, skipped-message ingress side effects, mention catch-up metadata, and group prompt context.
- `gateway.ts` now injects QQ/OpenClaw policy resolvers, history-limit lookup, ref-index lookup, scheduler/persist callbacks, and logs into the adapter; the main message path only consumes stop/continue plus returned group context fields.
- The adapter preserves previous behavior for `drop_other_mention`、`skip_no_mention`、unauthorized control commands, custom unread catch-up, and legacy history fallback while making the full group gate decision testable outside `gateway.ts`.
- Added `tests/custom-group-dispatch-gateway-adapter.test.ts` for non-group pass-through, group-policy stop, legacy skip history, unauthorized control command stop, and mention-triggered custom unread catch-up prompt context.

抽出 inbound preparation 网关准备层：

- Added `src/custom/inbound-preparation-gateway-adapter.ts` to own inbound message preparation before group gate/agent-body construction: attachment processing, media context, face/voice/attachment user-content normalization, quote resolution, current ref-index caching, body envelope formatting, and voice summary logging.
- `gateway.ts` now injects attachment processing, mention stripping, quote/ref formatters, ref-index cache writes, and framework envelope formatting into the adapter, keeping QQ/OpenClaw runtime ownership at the boundary while removing another inline preparation block from the main message path.
- The adapter preserves delayed InputNotify `refIdx` behavior: attachment/quote preparation can proceed first, then the adapter awaits the ref id only when writing the current message reference cache.
- Added `tests/custom-inbound-preparation-gateway-adapter.test.ts` for group mention stripping with voice/attachment text, C2C mention-name replacement, quote diagnostics, msgIdx/InputNotify ref cache writes, media dynamic context, and voice summary logging.

抽出 agent context 网关组装层：

- Added `src/custom/agent-context-gateway-adapter.ts` to own the final pre-dispatch context assembly: current-message agent body, unread/catch-up history injection, agent-body length logging, `buildCustomInboundContextPayload()`, and framework `finalizeInboundContext()` callback.
- `gateway.ts` now injects sub-message formatting, merged/history envelope formatting, and finalization callbacks into the adapter; route/context/media/quote fields are passed as data instead of rebuilding the payload inline.
- The adapter preserves slash-command body bypass, merged group message formatting, custom unread snapshot/mention history priority, legacy history fallback, and group/direct payload field behavior.
- Added `tests/custom-agent-context-gateway-adapter.test.ts` for group history injection plus finalized payload fields, and direct slash-command no-history behavior.

抽出 scene route 网关编排层并复核初始化目标：

- Added `src/custom/scene-route-gateway-adapter.ts` to own custom scene route setup: resolve scene state, skip disabled scenes, apply scene `agentId` route override, and return account/scene system prompts.
- `gateway.ts` now delegates scene route setup to the adapter after the framework base route is resolved, so later inbound preparation consumes a finalized route and prompt list without rebuilding scene state inline.
- 同步复核新增目标：初始化配置仍要求绑定 `customRuntime.admins` 和 `customRuntime.adminGroup`；现有 onboarding/setup/helper/preflight 路径继续把缺管理员或管理群视为未完整初始化。
- Added `tests/custom-scene-route-gateway-adapter.test.ts` for scene route override, disabled-scene stop behavior, and disabled-runtime no-op behavior.

抽出 custom runtime services 网关启动层：

- Added `src/custom/runtime-services-gateway-adapter.ts` to own per-connect custom runtime service wiring: command-backed task executor callbacks, async task status notifications, unread scheduler creation, restore, and unread config lookup helpers.
- `gateway.ts` now only injects proactive-guarded task notification sending, queue enqueue, and persistence callbacks; task executor status transitions and unread scheduler bootstrap no longer live inline in the WebSocket connect path.
- The adapter keeps task notifications behind the existing unanchored/proactive guard boundary by accepting `sendTaskStatusText()` from gateway instead of calling QQ send APIs or token helpers directly.
- Added `tests/custom-runtime-services-gateway-adapter.test.ts` for previous executor disposal, task executor config/log wiring, unread scheduler restore/config resolution, progress persistence, and async completion notification effects.

抽出 ordinary dispatch setup 网关准备层：

- Added `src/custom/dispatch-setup-gateway-adapter.ts` to own ordinary-dispatch delivery setup: reply context, send helpers, outbound deliver context, proactive guard source metadata, and guarded media auto-send callback.
- `gateway.ts` now passes account/config/event/target plus proactive guard and media-send callbacks into the setup adapter, removing another inline cluster before authorization and model dispatch.
- The adapter preserves anchored reply behavior for normal QQ messages and unanchored proactive-guard behavior for synthetic unread catch-up messages.
- Added `tests/custom-dispatch-setup-gateway-adapter.test.ts` for normal reply anchors, synthetic snapshot anchors, proactive guard source wiring, blocked media sends, and unanchored media budget commit behavior.

抽出 dispatch streaming setup 网关准备层：

- Added `src/custom/dispatch-streaming-setup-gateway-adapter.ts` to own streaming target-type resolution, `shouldUseStreaming()` policy application, enable/disable logs, and `StreamingController` construction.
- `gateway.ts` now consumes `targetType`、`useStreaming` 和 `streamingController` from the setup adapter; streaming deliver/error/partial/finalize behavior remains in the existing streaming gateway adapter.
- The setup adapter preserves the synthetic unread catch-up boundary: no passive reply anchor means no streaming controller, so unanchored replies continue through normal/static proactive-guarded delivery.
- Added `tests/custom-dispatch-streaming-setup-gateway-adapter.test.ts` for C2C controller deps, missing-anchor no-op, group disabled streaming, account-level streaming disable, and target-type mapping for guild/dm compatibility.

抽出 dispatch fallback session 网关会话层：

- Added `src/custom/dispatch-fallback-session-gateway-adapter.ts` to own per-dispatch fallback state, fallback recorder binding, response-timeout timer, tool-only timer handle, and tool fallback sender wiring.
- `gateway.ts` now asks the session for `state`、`recordFallbackEvent`、response timeout promise/clearer and tool-only timer accessors, instead of keeping those mutable handles inline in the model dispatch body.
- The adapter preserves the timeout/context-too-long boundary: failure classification and recovery notice delivery still live in `dispatch-failure-gateway-adapter.ts`, while QQ/media/text sends remain injected by gateway callbacks.
- Added `tests/custom-dispatch-fallback-session-gateway-adapter.test.ts` for response timeout rejection, block-response timeout suppression, response timer clearing, tool-only timer accessors, and injected tool fallback sender wiring.

抽出 dispatch deliver callback 网关编排层：

- Added `src/custom/dispatch-deliver-callback-gateway-adapter.ts` to own the ordinary dispatcher `deliver` callback sequence: late-deliver filtering, response marking, tool-deliver fallback handling, block preflight, streaming handoff, static delivery, and debounce orchestration.
- `gateway.ts` now only injects fallback session, reply/deliver contexts, send callbacks, debouncer handle setters, and outbound activity callbacks; the large inline deliver branch is no longer embedded in the model dispatch body.
- The adapter preserves the existing boundary: no QQ API/token calls inside the custom layer, and fallback persistence still flows through the per-dispatch fallback session recorder.
- Added `tests/custom-dispatch-deliver-callback-gateway-adapter.test.ts` for late-deliver ignore, tool branch routing, model-skip short circuit, static delivery via debounce, quote refs, tool media propagation, and outbound activity recording.

抽出 dispatch error callback 网关编排层：

- Added `src/custom/dispatch-error-callback-gateway-adapter.ts` to own dispatcher `onError` handling: account-prefixed logging, response-state marking, response-timeout cleanup, streaming error handoff, and fallback callback-failure routing.
- `gateway.ts` now delegates `onError` to the adapter, leaving the model dispatch body focused on wiring callbacks instead of duplicating streaming/error fallback branches.
- The adapter preserves duplicate-notice prevention: when streaming handles the error, it stops before `dispatch-failure-gateway-adapter.ts`; otherwise it uses the existing callback-failure policy and injected send/record callbacks.
- Added `tests/custom-dispatch-error-callback-gateway-adapter.test.ts` for streaming-handled errors, no-controller fallback routing, response marking, timer cleanup, visible text fallback, and fallback recorder propagation.

抽出 dispatch completion 网关收尾层：

- Added `src/custom/dispatch-completion-gateway-adapter.ts` to own dispatch/timeout `Promise.race` handling, response-timeout cleanup, race-failure fallback routing, finalization, and post-finalize hook execution.
- `gateway.ts` now delegates the dispatch completion sequence to this adapter and only injects the unread completion hook, keeping unread runtime wiring outside the generic dispatch race/finalize core.
- The adapter preserves timeout/context-too-long fallback behavior by reusing `dispatch-failure-gateway-adapter.ts`, and preserves tool/debounce/streaming cleanup by reusing `dispatch-finalize-gateway-adapter.ts`.
- Added `tests/custom-dispatch-completion-gateway-adapter.test.ts` for successful dispatch finalization, post-finalize `hasModelBlockOutput` propagation, race-failure notice routing, and defensive response-timeout cleanup.

抽出 dispatch reply 网关编排层：

- Added `src/custom/dispatch-reply-gateway-adapter.ts` to own ordinary OpenClaw reply dispatch orchestration: message config resolution, streaming setup, dispatcher deliver/onError/onPartialReply callback wiring, dispatch completion, processing-failure fallback, and typing cleanup.
- `gateway.ts` now delegates the full model dispatch body to the adapter after auth/context/delivery setup, leaving only injected callbacks for QQ sends, media parsing, outbound activity, and custom unread post-finalize handling.
- The adapter preserves the core custom-runtime boundary: scene/auth/group/unread context remains upstream, while the generic dispatch adapter does not import QQ API token helpers or perform platform sends directly.
- Added `tests/custom-dispatch-reply-gateway-adapter.test.ts` for callback wiring, streaming partial handoff, debouncer propagation into completion, post-finalize hook propagation, processing-failure fallback, and guaranteed typing cleanup.

抽出 interaction create 网关编排层：

- Added `src/custom/interaction-create-gateway-adapter.ts` as the single gateway entry point for QQ `INTERACTION_CREATE` events: official config ACKs, custom auth/poll/game/deploy callback cards, and legacy OpenClaw approval buttons.
- `gateway.ts` now injects token-backed `acknowledge`/`sendReply` callbacks, config API access, routing, and approval-handler lookup into the adapter, keeping QQ token/API ownership at the connector boundary.
- The adapter preserves callback-card semantics: config interactions only send the special `claw_cfg` ACK, while normal buttons get a generic ACK before persistence/reply effects or legacy approval resolution.
- Added `tests/custom-interaction-create-gateway-adapter.test.ts` for config interaction ACK routing, custom callback persistence/reply effects, and legacy approval handler compatibility.

抽出管理群通知服务：

- Added `src/custom/admin-group-notification-service-gateway-adapter.ts` to centralize `customRuntime.adminGroup` notification orchestration for auth approval copies, repeated-fallback alerts, and custom fork update prompts.
- `gateway.ts` now injects QQ token-backed text/keyboard send callbacks and a proactive guard factory into this service instead of keeping separate auth/fallback/update notification closures.
- The service owns shared management-group cooldown state and delegates the low-level guarded send to `admin-group-delivery-gateway-adapter.ts`, preserving the boundary that custom modules do not import QQ API token helpers.
- Added `tests/custom-admin-group-notification-service-gateway-adapter.test.ts` for auth card delivery, fallback alert cooldown suppression, and update-available notification/skipped behavior.
