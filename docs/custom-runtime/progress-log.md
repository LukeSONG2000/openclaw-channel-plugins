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
- Broader task cards, scene switch cards, deploy confirmation cards, and lightweight games remain future increments.

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
