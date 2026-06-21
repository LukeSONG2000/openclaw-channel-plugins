# Custom Runtime Architecture

## Design Principle

Keep the official QQBot connector responsible for platform plumbing:

- authentication
- gateway/webhook connection
- event parsing
- send API wrappers
- media upload
- interaction ACK
- basic OpenClaw channel registration

Move Luke-specific behavior into a custom message-flow runtime:

- scene routing
- authorization
- unread follow-up
- proactive policy
- long task sandboxing
- timeout guards
- deployment/update checks

## Target Layering

```text
QQ official platform
  -> official connector transport/API
  -> normalized inbound event
  -> custom runtime pipeline
  -> OpenClaw agent/tool dispatch
  -> custom outbound policy
  -> official connector send API
```

The runtime should only depend on a small adapter interface, so future official updates can be merged with minimal conflict.

## Proposed Modules

### `src/custom/runtime.ts`

Owns the pure in-memory custom module composition.

Responsibilities:

- create per-account runtime state
- expose shared scene/auth/unread/proactive/task/poll/game runtimes
- provide inspection helpers for unread and proactive config
- re-export stable custom runtime types used by gateway adapters

### `src/custom/message-flow-state.ts`

Owns the per-account custom runtime lifecycle and persistence boundary.

Current implementation status:

- Creates a `CustomMessageFlowRuntime` for one QQBot account.
- Restores auth, proactive budget, task sandbox, poll, game, deploy-confirmation, and unread state from their stores.
- Exposes small persist callbacks for each state area plus `persistAllState()`.
- Returns restored auth intents so the gateway can keep the existing authorization logging behavior.
- Keeps store module imports out of `gateway.ts`, reducing gateway coupling to custom state internals.

Important boundary:

- This module still runs inside the QQBot connector process.
- It is a step toward a thinner gateway adapter, not yet a full standalone middleware package.

### `src/custom/types.ts`

Stable custom types:

- `CustomInboundMessage`
- `CustomPeer`
- `CustomActor`
- `CustomAttachment`
- `CustomScene`
- `CustomAuthorizationDecision`
- `CustomOutboundIntent`
- `CustomRuntimeHookResult`

### `src/custom/scenes.ts`

Maps peers to scenes.

Current implementation status:

- Exists as a pure resolver with no QQ API, OpenClaw SDK, timer, or filesystem dependency.
- Resolves peer bindings in this priority:
  - exact peer key, for example `qqbot:group:<group_openid>`
  - kind wildcard, for example `qqbot:group:*`
  - global wildcard `*`
  - built-in default (`chat` for groups, `default-dm` for non-groups unless `defaultScene` overrides non-group peers)
- Applies built-in profiles for default capabilities, autonomous-reply defaults, proactive-send defaults, labels, descriptions, and scene system prompts.
- Builds a compact scene system prompt that is injected into the gateway message context when `channels.qqbot.customRuntime.enabled=true`.
- Supports `enabled:false` on a scene binding; gateway skips messages for disabled scenes before agent dispatch.
- `src/custom/config.ts` keeps the old `resolveCustomSceneConfig()` compatibility helper while delegating to the scene resolver.
- `src/custom/auth.ts` now reads default capabilities from the scene resolver, so authorization and message-flow policy share the same scene source.

Required scenes:

- `codex-only`: only Codex CLI/task use, no casual chat.
- `chat`: normal chat group.
- `system-admin`: restart, permission requests, system push, deployment checks.
- `dev-lab`: Codex plus system management for self-development.
- `default-dm`: direct message behavior.

Scene config must live under a custom namespace, not arbitrary keys inside official group config:

```json
{
  "channels": {
    "qqbot": {
      "customRuntime": {
        "enabled": true,
        "admins": ["ADMIN_MEMBER_OPENID"],
        "adminGroup": "5C1152CA05D191171B05E6997791C3F5",
        "scenes": {
          "qqbot:group:*": {
            "scene": "codex-only",
            "label": "Default group policy"
          },
          "qqbot:group:5C1152CA05D191171B05E6997791C3F5": {
            "scene": "system-admin",
            "label": "Management group",
            "allowProactiveSend": false
          }
        }
      }
    }
  }
}
```

When `customRuntime.adminGroup` is first written by onboarding or install scripts, the same peer is also bound to `system-admin` if no explicit scene already exists. Existing scene bindings are preserved, so a management group can still be manually promoted to `dev-lab` or another custom profile.

Built-in default capabilities:

- `codex-only`: `codex.run`, `codex.longTask`
- `chat`: `chat.send`
- `system-admin`: `system.status`, `deploy.check`, `config.read`
- `dev-lab`: `chat.send`, `codex.run`, `codex.longTask`, `system.status`, `deploy.check`, `config.read`
- `default-dm`: `chat.send`, `codex.run`, `system.status`, `deploy.check`, `config.read`

High-risk capabilities such as `config.write`, `system.restart`, `auth.grant`, `deploy.apply`, and `proactive.send` are intentionally not granted by default scene profiles. They require admin status, an explicit scene capability, or a temporary grant.

`src/custom/scene-gateway-adapter.ts` handles peer-level scene binding commands before normal slash handling:

- `/bot-scene status`
- `/bot-scene list`
- `/bot-scene bindings`
- `/bot-scene set <codex-only|chat|system-admin|dev-lab|default-dm> [--agent <agentId>]`
- `/bot-scene set <scene> --clear-agent`
- `/bot-scene <scene>` shorthand

`/bot-scene status`, `list`, and `bindings` require `system.status`; scene binding and agent override changes require `config.write`. `list` shows built-in scene profiles, while `bindings` shows explicit configured peer/wildcard bindings with scene, enabled state, label, agent override, and capability summary. `status`, `list`, and successful `set` replies include C2C/group inline command keyboards for switching scenes; each button sends `/bot-scene set <scene>`, so the existing `config.write` authorization still gates the mutation. The adapter updates the live config object only for bind/set commands and returns a precise config persistence intent. `gateway.ts` reloads the latest framework config, merges the scene binding under `channels.qqbot.customRuntime.scenes`, and writes it through `runtime.config.writeConfigFile()`.

Scene `agentId` overrides OpenClaw route selection after the base route resolves; the custom layer rebuilds `sessionKey` with the framework routing helper so agent binding and session storage stay aligned. `/bot-scene status` and `/bot-scene bindings` expose the current override so group/DM routing can be audited without opening `openclaw.json`.

### `src/custom/proactive-budget.ts`

Owns local proactive/unanchored text-send budget for custom runtime paths.

Current implementation status:

- Exists as a pure runtime with no QQ API, OpenClaw SDK, timer, or filesystem dependency.
- Resolves `customRuntime.proactive` with scene-level overrides through `scene.proactive`.
- Defaults are conservative:
  - `enabled=true`
  - `monthlyLimit=4`
  - `rateLimitWindowMs=60000`
  - `rateLimitMax=1`
- Tracks budget by `accountId + peer.kind + peer.id` and UTC month.
- 持久化 QQ 单聊主动消息接收状态：`C2C_MSG_REJECT` / `C2C_MSG_RECEIVE`。
- 持久化 QQ 群主动消息接收状态：`GROUP_MSG_REJECT` / `GROUP_MSG_RECEIVE`。
- 当最新本地接收状态为拒收时，阻止对应 C2C/group 主动发送。
- Counts only after a proactive text or media send succeeds, so token retry or failed sends do not consume budget.
- Persists state under `~/.openclaw/qqbot/data/custom-proactive-budget/budget-<accountId>.json`.
- `src/custom/proactive-gateway-adapter.ts` builds the gateway-facing guard from current config, account id, the in-memory proactive budget runtime, and a persist callback. Gateway code no longer repeats budget check/record formatting in each send path.
- Gateway injects that guard into `src/outbound-deliver.ts`; synthetic catch-up sends without a QQ `msg_id` anchor are checked before they call proactive C2C/group APIs.
- The same guard now covers management-group pushes, reply-dispatcher unanchored text sends, task notifications, media tag queues, Base64 image sends, local/payload media auto-routing, and tool fallback/immediate media forwarding.
- `src/reply-dispatcher.ts` exposes a small `prepareUnanchoredTextSend` hook. Gateway reply helpers use it for C2C/group text sends with no real `messageId`, covering error fallbacks, structured-payload captions, admin-group auth notifications, and long-task notifications without importing custom runtime internals into the dispatcher.
- `src/outbound.ts` and `src/proactive.ts` expose optional guard hooks for legacy/framework proactive APIs. These paths are not allowed to reach into custom runtime state directly, but callers that reuse them for custom message-flow work can now inject the same budget/acceptance guard and commit only after successful sends.
- Current send-surface policy:
  - `src/outbound-deliver.ts`: custom runtime gateway delivery, guard injected by gateway.
  - `src/reply-dispatcher.ts`: gateway reply helper, guard injected by gateway for unanchored C2C/group text.
  - `src/outbound.ts`: framework outbound/cron helper, optional `prepareUnanchoredSend`.
  - `src/proactive.ts`: legacy proactive helper, optional `prepareUnanchoredSend`.

Example:

```json
{
  "channels": {
    "qqbot": {
      "customRuntime": {
        "proactive": {
          "monthlyLimit": 4,
          "rateLimitWindowMs": 60000,
          "rateLimitMax": 1
        },
        "scenes": {
          "qqbot:group:5C1152CA05D191171B05E6997791C3F5": {
            "scene": "dev-lab",
            "allowProactiveSend": true,
            "proactive": {
              "monthlyLimit": 2
            }
          }
        }
      }
    }
  }
}
```

Open items:

- Official docs note proactive push capability may error after the 2025-04-21 adjustment; server validation is still required before enabling autonomous proactive scenes broadly.

### `src/custom/auth.ts`

Authorization is evaluated before tool dispatch and before config mutation.

Current implementation status:

- Exists as a pure runtime with no QQ API, timer, filesystem, or OpenClaw SDK dependency.
- Evaluates admins, scene capabilities, wildcard capabilities, and disabled runtime state.
- Maintains in-memory temporary grants:
  - once
  - count-limited
  - timed
  - task-scoped
- Emits typed intents for approval requests, approval resolution, grant consumption, and grant expiry.
- Deduplicates pending approval requests by peer, actor, capability, and task id.
- Can import/export `CustomAuthorizationRuntimeState` so the gateway can persist temporary grants and approval requests.
- `src/custom/auth-gateway-adapter.ts` translates gateway queued messages and plugin slash commands into auth checks.
- `gateway.ts` blocks plugin-level slash commands before their handlers can mutate config or run deploy actions when `channels.qqbot.customRuntime.enabled` is true.
- `gateway.ts` also checks ordinary messages before OpenClaw/model dispatch. Normal chat requests require `chat.send`; slash-like framework commands that are not plugin commands require `codex.run`; codex-only scenes route ordinary dispatch checks to `codex.run`.
- Unauthorized slash commands receive a visible denial message and create an in-memory approval request intent when bound admins exist.
- Unauthorized ordinary dispatch requests receive a visible denial message and can create the same approval-card request in C2C/group.
- QQ inline keyboard approval cards are sent for C2C/group requests when callback buttons are available; text commands remain as fallback.
- Gateway persists grants/requests under `~/.openclaw/qqbot/data/custom-auth/auth-<accountId>.json` and restores them at startup.
- QQBot initialization requires both `customRuntime.admins` and `customRuntime.adminGroup`; onboarding, `qqbotPlugin.setup.validateInput` / `applyAccountConfig`, and install scripts write these anchors before the runtime is enabled. `adminGroup` accepts either a raw QQ `group_openid` or `qqbot:group:<group_openid>` and is normalized to a peer key.
- Initializing `customRuntime.adminGroup` also creates a default `system-admin` scene binding for that group when no binding exists yet, so the management group immediately has status/query/deploy-check semantics without granting high-risk mutation capabilities.
- `scripts/apply-custom-runtime-init.mjs` is the shared installer helper for writing and inspecting those anchors. `upgrade-via-npm.sh`, `upgrade-via-source.sh`, and `upgrade-via-npm.ps1` accept `--admins`/`--admin-group` or `QQBOT_CUSTOM_ADMINS`/`QQBOT_CUSTOM_ADMIN_GROUP`; without them they report the missing initialization anchors instead of silently treating appid/secret as complete setup.
- `/bot-auth status` reports whether the admin binding is complete. Missing admins or admin group means authorization still blocks high-risk actions, but approval requests have no reliable management anchor.
- Approval request records carry the normalized management group key so approval cards, text fallbacks, and future system push/deploy notifications can share the same target.
- When an approval request is created outside the bound management group, the gateway best-effort copies the approval card/text to `customRuntime.adminGroup`. This copy is an unanchored group send, so it passes through the same proactive acceptance/budget guard before any QQ send API call.

Policy inputs:

- channel: `qqbot`
- peer: C2C/group/channel
- actor: `user_openid` or `member_openid`
- scene
- requested capability
- command/tool name
- temporary grants
- admin bindings:
  - `customRuntime.admins`: member/user openids allowed to approve grants and run high-risk capabilities
  - `customRuntime.adminGroup`: management group peer for auth requests, system push, deployment checks, and operational alerts

Suggested capabilities:

- `chat.send`
- `codex.run`
- `codex.longTask`
- `system.status`
- `system.restart`
- `config.read`
- `config.write`
- `auth.grant`
- `deploy.check`
- `deploy.apply`
- `proactive.send`
- `game.interact`
- `*` is allowed only in scene/grant policy as a wildcard; runtime checks request concrete capabilities.

Default stance:

- DMs from owner: full.
- Known admin members in admin/dev groups: elevated.
- Normal group members: chat and safe Codex only where scene allows.
- Config mutation, restart, deploy, and rule changes require explicit admin permission.

Temporary grants:

- one-shot grant for one command/tool
- multi-use grant with count
- timed grant with expiry
- task-scoped grant for a long-running sandbox task

When unauthorized use is detected, generate an approval request to bound admins. Prefer an inline keyboard if available; otherwise send a text approval command.

### `src/custom/message-delete-events.ts`

Message deletion is currently diagnostic-only.

Current implementation status:

- Parses official channel-side deletion event names: `MESSAGE_DELETE`, `PUBLIC_MESSAGE_DELETE`, and `DIRECT_MESSAGE_DELETE`.
- Extracts only conservative diagnostic fields: event type, scope, message id, channel id, guild id, author id, operator id, timestamp, and safe raw top-level keys.
- `gateway.ts` logs the parsed result as `Message delete diagnostics`.
- The helper does not mutate unread state, ref-index records, group history, task context, authorization state, or scene bindings.
- C2C/group recall-delete state remains unverified until the deployed environment produces an official or observed event shape for it.

### `src/custom/auth-gateway-adapter.ts`

Gateway-side translation layer for authorization runtime.

Current implementation status:

- Converts `QueuedMessage` into `CustomPeer` and `CustomActor`.
- Uses slash-command metadata from `src/slash-commands.ts` to map plugin commands to concrete capabilities.
- Calls `CustomAuthorizationRuntime.check()` before plugin command handlers execute.
- Resolves ordinary message dispatch capabilities for non-plugin messages:
  - normal chat: `chat.send`
  - slash-like framework commands: `codex.run`
  - codex-only scenes without `chat.send`: `codex.run`
- Formats visible denial text for C2C, group, channel, and DM replies.
- Handles `/bot-auth` as a gateway-level admin command so admins can approve or deny custom auth requests against the live per-account runtime.
- Provides admin-only read views for pending approval requests and active temporary grants through `/bot-auth requests [数量]` and `/bot-auth grants [数量]`; these views show ids, actor/peer ids, capabilities, expiry, and command hints, but not raw message bodies.
- Builds QQ inline keyboard approval cards for new unauthorized C2C/group slash-command requests.
- Handles `custom-auth:<requestId>:allow-once|allow-count|allow-timed|allow-task|deny` button callbacks through the same per-account auth runtime; `allow-task` is accepted only for approval requests that carry a task id.
- Logs approval/grant intents in the gateway for observability.

Initial slash command capability mapping:

- `/bot-ping`: `system.status`
- `/bot-version`: `deploy.check`
- `/bot-upgrade`: `deploy.check`; `--latest`, `--version`, `--force`, `--local`, or a bare version require `deploy.apply`
- `/bot-logs`: `config.read`
- `/bot-clear-storage`: `config.read`; `--force` requires `config.write`
- `/bot-streaming`: `config.read`; `on`/`off` require `config.write`
- `/bot-approve`: `config.read`; mutation commands require `auth.grant`
- `/bot-group-allways`: `config.read`; `on`/`off` require `config.write`
- `/bot-task`: `system.status`; `create`/`new`/`start`/`add`/`append`/`cancel`/`stop` require `codex.longTask`
- `/bot-poll`: `system.status`; `create`/`new`/`close`/`end` require `game.interact`
- `/bot-game`: `system.status`; `guess`/`number`/`start`/`new`/`close`/`end` require `game.interact`
- `/bot-scene`: `system.status` for status/list/bindings; `set`/`bind` or direct scene names require `config.write`
- `/bot-fallback`: `system.status`; `clear`/`reset` require `config.write`
- `/bot-queue`: `system.status`
- `/bot-unread`: `system.status`

Text approval commands:

- `/bot-auth status`
- `/bot-auth requests [数量]`
- `/bot-auth grants [数量]`
- `/bot-auth approve <requestId> once`
- `/bot-auth approve <requestId> count 3`
- `/bot-auth approve <requestId> timed 10m`
- `/bot-auth deny <requestId>`

Still open:

- Fine-grained tool-level authorization inside a model run, once the OpenClaw tool execution contract is confirmed.
- Richer custom auth card variants, such as selecting arbitrary grant counts or durations from the card.
- Optional encryption/redaction for the auth state file if future grants include sensitive notes.

### `src/custom/slash-gateway-adapter.ts`

Gateway-side custom slash auth gate and effect merge layer.

Current implementation status:

- Runs before official plugin slash command matching.
- Handles `/bot-auth` directly because it mutates authorization state and must bypass the normal slash route table.
- Applies task-scoped authorization before `/bot-task add` / `/bot-task cancel` can mutate task state.
- Applies custom slash authorization for plugin-level and custom commands.
- Delegates authorized custom runtime commands to `src/custom/slash-router.ts`.
- Merges auth-stage and route-stage typed effects before returning to `gateway.ts`.
- Leaves `gateway.ts` responsible for platform sends, token lookup, fallback text sends, and normal OpenClaw slash command matching.

### `src/custom/slash-router.ts`

Pluggable custom slash command route table.

Current implementation status:

- Owns the ordered custom route list:
  - scene
  - fallback
  - queue
  - unread
  - task
  - poll
  - game
  - deploy
- Routes `/bot-scene`, `/bot-fallback`, `/bot-queue`, `/bot-unread`, `/bot-task`, `/bot-poll`, `/bot-game`, and `/bot-deploy` after the auth gate has allowed the command.
- Returns typed side-effect descriptions instead of sending QQ messages directly:
  - text reply
  - keyboard reply
  - state areas that need persistence
  - task notification deliveries
  - info/error log lines
- Applies task workspace file effects for task create/add/cancel while keeping QQ send APIs out of the custom command decision layer.
- Returns exact scene config persistence intents for `/bot-scene set`, leaving disk writes to the gateway.
- Allows future custom commands to be added as routes without widening the auth gate or `gateway.ts`.

Important boundary:

- This is not a full command framework replacement.
- Official/plugin slash commands still live in `src/slash-commands.ts`; this router only handles custom runtime commands that need live per-account runtime state.

### `src/custom/slash-reply-target.ts`

Pure target resolution for gateway-level slash replies.

Current implementation status:

- Maps C2C slash replies to `sendC2CMessage`.
- Maps group slash replies to `sendGroupMessage`.
- Maps guild channel slash replies to `sendChannelMessage`.
- Maps channel DM slash text replies to `sendDmMessage` using the `guild_id` from `DIRECT_MESSAGE_CREATE`.
- Keeps slash file/media targets limited to C2C, group, and guild channel; channel DM file/media replies stay unsupported until a correct DM media path is added.

Boundary:

- It does not call QQ APIs, load tokens, or inspect custom auth state.
- `gateway.ts` still owns actual sends, keyboard fallbacks, error logging, and file delivery.

### `src/custom/interaction-gateway-adapter.ts`

Gateway-side custom button interaction adapter.

Current implementation status:

- Handles custom inline keyboard button payloads after QQ interaction ACK.
- Delegates custom callback payloads to `src/custom/interaction-router.ts`.
- Keeps QQ event source-peer normalization near the gateway boundary.
- Returns typed reply/persist/log descriptions instead of sending QQ messages directly.
- Leaves `gateway.ts` responsible for the platform ACK, reply target selection, QQ send APIs, and legacy official approval buttons.

### `src/custom/interaction-router.ts`

Pluggable custom callback-card route table.

Current implementation status:

- Owns the ordered custom route list for callback buttons:
  - auth
  - poll
  - game
  - deploy
- Routes `custom-auth:<requestId>:allow-once|allow-count|allow-timed|allow-task|deny` to the per-account auth runtime.
- Routes `custom-poll:<pollId>:vote:<1-4>` to the per-account poll runtime.
- Routes `custom-game:<gameId>:guess:<1-4>` to the per-account game runtime.
- Routes `custom-deploy:<confirmationId>:confirm|cancel` to the per-account deploy-confirmation runtime.
- Returns typed reply/persist/log descriptions instead of sending QQ messages directly.
- Allows future richer game callbacks or admin cards to register as additional routes without widening `gateway.ts`.

Important boundary:

- The router has no QQ API dependency and does not ACK interactions.
- Config query/update interactions still stay in `gateway.ts` because they are part of the official connector protocol.
- Legacy approval buttons with `approve:<approvalId>:...` still stay in `gateway.ts` because they are tied to the existing `approval-handler`.

### `src/custom/unread-runtime.ts`

Owns non-mentioned group history and autonomous speaking decisions.

Current implementation status:

- Exists as a pure state machine with no QQ API, OpenClaw SDK, timer, filesystem, or gateway queue dependency.
- Takes normalized `CustomInboundMessage` inputs and returns typed intents.
- Does not send messages directly. `src/custom/unread-gateway-adapter.ts` converts intents into gateway effects.
- Defaults to policy-gated autonomous/proactive behavior unless the scene explicitly allows it.
- Exposes `inspectCustomUnreadRuntimeState()` for text-safe status summaries that include peer counts, pending counts, scheduled timer counts, snapshot counts, and policy-gated snapshot counts without exposing cached message bodies.
- `src/custom/unread-status-gateway-adapter.ts` exposes `/bot-unread status [limit]` through the custom slash gateway. It is read-only, requires `system.status`, and uses the inspection helper so cached group message bodies are not displayed.

State:

- pending messages by `group_openid`
- recent bot output anchors
- planned follow-up due time
- planned sleep-digest due time
- consumed synthetic history snapshots

Rules:

- Record allowed non-mentioned group messages without blocking the main queue.
- When mentioned, inject pending history into context but do not automatically consume it unless policy says so.
- A short follow-up window may run after bot output.
- Group passive replies must stay inside official 5-minute window.
- Delayed ten-minute speaking must use scarce proactive group send and is guarded by scene policy plus the custom proactive budget runtime for text sends.
- Synthetic digest messages must be non-mergeable.

Primary adapter methods:

- `recordNonMention`: store non-trigger group messages and request a sleep digest timer if needed.
- `observeMention`: cancel pending autonomous windows, return pending history for current context, and report whether catch-up should run after the mention reply.
- `markOutputComplete`: request a follow-up timer after a normal bot output.
- `fireScheduledFollowup`: convert a due follow-up timer into a catch-up or no-op.
- `fireSleepDigest`: convert a due sleep timer into a catch-up or policy-gated decision.
- `consumeSnapshot`: remove only the history entries used by a completed synthetic catch-up.

### `src/custom/unread-gateway-adapter.ts`

Gateway-side translation layer for unread runtime.

Current implementation status:

- Converts gateway group events into `CustomInboundMessage`.
- Converts unread history snapshots into `HistoryEntry[]` for existing envelope formatting.
- Converts runtime intents into side-effect descriptions:
  - set follow-up timer
  - set sleep-digest timer
  - clear follow-up or sleep-digest timer
  - enqueue synthetic catch-up `QueuedMessage`
  - report policy-gated autonomous reply
- Builds synthetic catch-up messages with `_customUnreadSnapshot`, `_customUnreadSnapshotId`, and `_noMerge`.
- `gateway.ts` now reads `_customUnreadSnapshot` and mention-time custom unread history when injecting pending group history context.

### `src/custom/unread-ingress.ts`

Gateway-side pre-dispatch adapter for custom unread flow.

Current implementation status:

- Resolves custom unread config for queued group messages by combining runtime and scene policy.
- Records non-mentioned group messages through `CustomUnreadRuntime.recordNonMention()`.
- Observes mentioned group messages through `CustomUnreadRuntime.observeMention()`.
- Converts mention-time custom unread history into `HistoryEntry[]` so the existing inbound envelope formatter can inject it into the agent context.
- Returns typed effect/persist descriptions instead of applying timers or saving state directly.

Important boundary:

- This module does not perform group allow-list, mention-gating, or command-authorization decisions; those still belong to the gateway policy path.
- It does not format final agent prompts. It only returns history entries that gateway formatting can consume.
- It does not send QQ messages or own timers; `src/custom/unread-scheduler.ts` applies the returned effects.

### `src/custom/unread-context.ts`

Gateway-side history context adapter for custom unread and legacy group history.

Current implementation status:

- Chooses which history source should be injected before the current group message:
  - synthetic catch-up snapshot history
  - mention-time custom unread history
  - legacy group history map
- Gives synthetic snapshot history priority over mention-time history, and mention-time history priority over legacy history.
- Builds the pending-history context body through a gateway-provided envelope formatter callback.
- Records legacy non-mentioned group history when custom unread is disabled for the peer.
- Clears legacy group history after a handled reply falls back to the old history path.
- Owns attachment-tag appending for pending history entries so gateway no longer needs to know that detail.

Important boundary:

- This module does not choose group policy, mention gating, command authorization, or scene routing.
- It does not know QQBot envelope syntax; gateway still provides the final envelope formatter callback.

### `src/custom/unread-scheduler.ts`

Gateway-side scheduler for unread runtime effects.

Current implementation status:

- Owns follow-up and sleep-digest timer handles outside `gateway.ts`.
- Applies unread gateway effects:
  - set/clear timers
  - enqueue synthetic catch-up messages through a provided callback
  - log policy-gated autonomous decisions
  - persist unread state after effectful changes
- Restores scheduled follow-up and sleep-digest timers from `CustomUnreadRuntimeState`.
- Fires due timers by calling `CustomUnreadRuntime.fireScheduledFollowup()` or `fireSleepDigest()`, then recursively applies generated effects.
- Exposes `dispose()` so gateway cleanup can clear timers without knowing scheduler internals.

Important boundary:

- The scheduler does not inspect QQ events or send QQ messages.
- It depends on small callbacks for enqueue, persist, config resolution, and logging, so timer behavior can be tested without the gateway.

### `src/custom/unread-completion.ts`

Gateway-side dispatch completion adapter for custom unread flow.

Current implementation status:

- Handles post-dispatch unread decisions after the OpenClaw/model path has either produced or failed to produce a visible block output.
- Consumes completed synthetic catch-up snapshots only when a real model block output exists.
- Keeps snapshots when a synthetic catch-up times out, fails, or returns no visible block output, allowing a later retry.
- Converts mention-follow-up and output-complete decisions into unread gateway effects that `CustomUnreadScheduler` can apply.
- Returns typed log/persist/effect descriptions instead of logging, saving, sending, or managing timers directly.

Important boundary:

- This module does not send QQ messages.
- It does not own follow-up or sleep-digest timers; `src/custom/unread-scheduler.ts` applies the returned effects.
- It does not clean up legacy group history; when it does not handle an event, `gateway.ts` still performs the existing legacy history cleanup path.

Current gateway wiring:

- Active only when `channels.qqbot.customRuntime.enabled` is true.
- If custom runtime is disabled, or `customRuntime.unread.enabled` is false for a scene, legacy group history behavior remains in use.
- Non-mentioned group messages are recorded through the custom unread runtime and can schedule sleep-digest timers.
- Mentioned group messages receive pending unread history in the same reply context and clear pending autonomous timers.
- Completed mention replies can enqueue a synthetic catch-up when unread history was present.
- Completed normal outputs schedule a follow-up timer.
- Synthetic catch-up messages bypass mention gating, preserve `_customUnreadSnapshot`, and are protected from queue merging by `_noMerge`.
- Synthetic catch-up sends are treated as proactive/unanchored outbound messages because they do not have a real QQ `msg_id`.
- Snapshots are consumed only after a real model block output is produced. If dispatch fails, times out, or returns `NO_REPLY` / `[SKIP]`, the unread snapshot is kept.
- Runtime state is persisted under `~/.openclaw/qqbot/data/custom-unread/unread-<accountId>.json`.
- The state controller restores pending unread history and snapshots; `CustomUnreadScheduler` restores follow-up and sleep-digest timers on startup.

### `src/custom/task-sandbox.ts`

Long task isolation.

Current implementation status:

- Exists as a pure task state runtime with no QQ API, OpenClaw SDK, child process, timer, or filesystem dependency.
- Creates durable task records with id, peer, owner, title, prompt, status, workspace path, timestamps, execution metadata, progress metadata, and appended requirements.
- Emits task intents for start requests, requirement additions, cancellation requests, and status updates so a future executor can be plugged in without changing command parsing.
- Defaults to at most 3 active tasks per account/peer.
- Default workspace root is `~/.openclaw/qqbot/tasks`.
- `channels.qqbot.customRuntime.tasks` can override the global task workspace root and max active tasks per peer.
- Each scene binding can also set `tasks.workspaceRoot` and `tasks.maxActiveTasksPerPeer`; scene values override global values when `/bot-task create` runs in that peer.
- `inspectCustomTaskSandboxConfig()` exposes the resolved task sandbox config for a message, and `/bot-task create` passes it into `CustomTaskSandboxRuntime.createTask()` without rebuilding the per-account runtime.
- Task ids use `qqbot-{accountId}-{peerKind}-{peerIdPrefix}-{timestamp}-{seq}`.
- Supports create, list, status, add requirement, cancel, start, heartbeat, progress update, complete, and fail operations.
- Exports/imports `CustomTaskSandboxRuntimeState` so the gateway can restore task metadata after restart.
- Persists state under `~/.openclaw/qqbot/data/custom-tasks/tasks-<accountId>.json`.
- `src/custom/task-workspace.ts` materializes each task into an isolated workspace with:
  - `TASK.md`
  - `status.json`
  - `requirements.jsonl`
- `src/custom/task-cleanup.ts` builds a read-only cleanup plan for terminal tasks:
  - only considers `completed`, `failed`, and `cancelled` tasks
  - scopes by account and current peer before exposing workspace paths
  - defaults to tasks older than 7 days and limits output to a bounded list
  - never deletes files or mutates task state
- `src/custom/task-executor-adapter.ts` applies task intents to an optional executor boundary:
  - materialize workspace on `start-requested`
  - keep tasks queued when no executor is attached
  - start tasks when an executor accepts them, recording executor id, run id, agent id, and start time
  - forward appended requirements and cancellation requests to the executor when available
  - expose heartbeat, progress, complete, and fail helpers that update runtime state and `status.json`
- `src/custom/task-command-executor.ts` provides a conservative optional command executor:
  - configured under `channels.qqbot.customRuntime.tasks.commandExecutor`
  - disabled by default
  - starts a configured local command in the task workspace without blocking the main QQ message queue
  - passes task metadata through `QQBOT_CUSTOM_TASK_*` environment variables
  - captures stdout/stderr, applies timeout and output truncation, then calls the same complete/fail helpers used by future executors
  - can optionally keep stdin open with `forwardRequirementsToStdin=true`; appended requirements are sent as JSON lines while still being persisted
  - can emit progress by writing either `QQBOT_TASK_PROGRESS {"phase":"...","message":"...","percent":50}` or a JSON line with `type:"qqbot.task.progress"` to stdout
- `src/custom/task-notification-adapter.ts` formats task completion/failure/cancellation notification effects:
  - peer notification for the originating group/DM
  - owner notification for future direct follow-up
  - result/error truncation for safe QQ text sends
- `src/custom/task-notification-gateway-adapter.ts` maps notification effects to gateway send descriptions:
  - peer audience -> original group/channel/DM/C2C target
  - owner audience -> owner C2C target
  - dedupes repeated audience/target effects
  - applies anchored deliveries through a gateway-provided text sender
  - skips unanchored deliveries by default until proactive send policy is explicitly applied
- `gateway.ts` applies async command-executor completion/failure notifications through the same proactive acceptance/budget guard used by autonomous sends before allowing unanchored C2C/group delivery.
- `src/custom/task-access.ts` is the shared pure policy for account, peer, and owner boundaries:
  - task owner can read and mutate across peers in the same account
  - members in the original peer can read status, but mutation still flows through owner/admin/task-scoped auth
  - ordinary members in other peers receive the same not-found/current-session reply and do not create auth requests or expose task metadata
  - account mismatch is always denied before status or auth details are shown
- `src/custom/task-auth-gateway-adapter.ts` gates task mutation commands before they change task state:
  - task owner can append/cancel their own task
  - custom runtime admins can append/cancel any task
  - other members need a task-scoped `codex.longTask` temporary grant
  - denied add/cancel attempts create an approval request that carries `taskId`
- `src/custom/task-gateway-adapter.ts` handles `/bot-task` before the normal AI queue:
  - `/bot-task create <任务描述>`
  - `/bot-task list`
  - `/bot-task status <taskId>`
  - `/bot-task add <taskId> <追加需求>`
  - `/bot-task cancel <taskId>`
  - `/bot-task cleanup [--older-than 7d] [--limit 10]`
- `/bot-task status <taskId>` only reveals task details to the task's original account/peer or to the task owner. A task id from another group/DM is treated as not found for ordinary readers.
- `/bot-task add` and `/bot-task cancel` now use the same account/peer boundary before task-scoped auth; a cross-peer ordinary member cannot trigger an approval request for a task they should not know about.
- Task create/status/add/cancel replies include QQ command-input shortcuts and C2C/group inline command keyboards for status, append, cancel, and new-task actions where applicable. Status/cancel buttons send the slash command directly; append/new-task buttons only prefill the command so the user can edit the requirement text before sending.
- `/bot-task status <taskId>` now shows executor id, run id, agent id, heartbeat time, and the latest progress phase/message/percent when present, so group members can inspect a running long task without entering the main AI queue.
- `/bot-task cleanup` is a read-only cleanup planner for the current peer. It lists eligible terminal tasks and their workspaces, but does not delete files or remove task state; a future destructive cleanup path must still add `--force`, admin confirmation, and backup checks.
- Slash-command capability metadata gates task mutations through custom auth:
  - query/help/list/status/cleanup use `system.status`
  - create/add/cancel use `codex.longTask`
- Task mutation commands get an additional task-scoped ownership check after the scene-level capability check and before any state mutation.

Important boundary:

- This layer still does not start a real OpenClaw subagent/job by itself.
- It now has both a generic executor adapter boundary and a local command executor proving path, so a future OpenClaw runner can attach without changing command parsing, task state, or workspace persistence.
- It returns notification delivery descriptions instead of sending QQ messages directly; gateway applies anchored deliveries through QQ send APIs and applies proactive policy before unanchored async completion notifications.
- Without an enabled executor, tasks remain queued with durable workspace/status files; group long-task commands still return immediately and do not block the main conversation queue.
- The local command executor can optionally keep stdin open with `forwardRequirementsToStdin=true`; when enabled, `/bot-task add` forwards each added requirement as one JSON line while still persisting the requirement to task state and the workspace.
- The local command executor can parse stdout progress events and persist them to task state/status files. This gives a future OpenClaw/subagent runner a minimal streaming-status contract without coupling the gateway to a specific runner API.

Next integration:

Connect `CustomTaskExecutor` to an actual OpenClaw runtime/subagent contract, then add force-gated workspace cleanup and richer runner-specific status cards.

Example command executor config:

```json
{
  "channels": {
    "qqbot": {
      "customRuntime": {
        "tasks": {
          "workspaceRoot": "~/.openclaw/qqbot/tasks",
          "maxActiveTasksPerPeer": 3,
          "commandExecutor": {
            "enabled": false,
            "command": "/usr/local/bin/custom-task-runner",
            "args": [],
            "forwardRequirementsToStdin": false,
            "timeoutMs": 1800000,
            "maxOutputChars": 6000,
            "notifyAudiences": ["peer"]
          }
        },
        "scenes": {
          "qqbot:group:DEV_GROUP_OPENID": {
            "scene": "dev-lab",
            "tasks": {
              "workspaceRoot": "~/.openclaw/qqbot/tasks/dev-lab",
              "maxActiveTasksPerPeer": 1
            }
          }
        }
      }
    }
  }
}
```

### `src/custom/poll.ts`

Lightweight interactive poll/card runtime.

Current implementation status:

- Exists as a pure poll state runtime with no QQ API, OpenClaw SDK, timer, or filesystem dependency.
- Creates durable poll records with id, account, peer, creator, question, 2-4 options, votes, status, and timestamps.
- Supports one active vote per actor per poll; clicking another option updates the existing vote.
- Supports create, list, status, close, and vote operations.
- Poll ids use `poll-{accountId}-{peerKind}-{peerIdPrefix}-{timestamp}-{seq}`.
- Exports/imports `CustomPollRuntimeState` so the gateway can restore poll metadata after restart.
- Persists state under `~/.openclaw/qqbot/data/custom-polls/polls-<accountId>.json`.
- `src/custom/poll-gateway-adapter.ts` handles `/bot-poll` before the normal AI queue:
  - `/bot-poll create 问题 | 选项A | 选项B [| 选项C | 选项D]`
  - `/bot-poll list`
  - `/bot-poll status <pollId>`
  - `/bot-poll close <pollId>`
- For C2C/group messages, poll creation replies with an inline keyboard when available; channel/DM paths fall back to text.
- Button callbacks use `custom-poll:<pollId>:vote:<optionId>`.
- `gateway.ts` acknowledges interactions first, maps the callback source into a custom peer, then routes `custom-poll:` callbacks to the per-account poll runtime.
- `/bot-poll status <pollId>` and `/bot-poll close <pollId>` only reveal or mutate polls in the original account/peer, or polls created by the current actor. A poll id from another group/DM is treated as not found for ordinary readers.
- Button votes apply the same account/peer visibility check before state mutation. Ordinary users cannot vote from another group/DM by replaying a poll callback payload; the poll creator can still interact with their own poll across peers.
- Slash-command capability metadata gates poll mutations through custom auth:
  - help/list/status use `system.status`
  - create/close use `game.interact`

Important boundary:

- This layer is intentionally only a small interactive-card proving ground.
- It does not yet implement richer games or deploy/update confirmation cards.
- Poll button callbacks receive source peer fields from the gateway and enforce the same account/peer visibility rule as text status/close commands.

### `src/custom/game.ts`

Lightweight interactive game/card runtime.

Current implementation status:

- Exists as a pure game state runtime with no QQ API, OpenClaw SDK, timer, or filesystem dependency.
- Adds a first `guess-number` game where each game stores a secret number from 1 to 4, per-actor guesses, status, timestamps, and an optional winner.
- Supports create, list, status, close, and guess operations.
- Game ids use `guess-{accountId}-{peerKind}-{peerIdPrefix}-{timestamp}-{seq}`.
- Exports/imports `CustomGameRuntimeState` so the gateway can restore game metadata after restart.
- Persists state under `~/.openclaw/qqbot/data/custom-games/games-<accountId>.json`.
- `src/custom/game-gateway-adapter.ts` handles `/bot-game` before the normal AI queue:
  - `/bot-game guess`
  - `/bot-game list`
  - `/bot-game status <gameId>`
  - `/bot-game close <gameId>`
- For C2C/group messages, game creation replies with an inline keyboard when available; channel/DM paths fall back to text.
- Button callbacks use `custom-game:<gameId>:guess:<1-4>`.
- `gateway.ts` acknowledges interactions first, maps the callback source into a custom peer, then routes `custom-game:` callbacks to the per-account game runtime.
- `/bot-game status <gameId>` and `/bot-game close <gameId>` only reveal or mutate games in the original account/peer, or games created by the current actor.
- Button guesses apply the same account/peer visibility check before state mutation. Ordinary users cannot guess from another group/DM by replaying a callback payload; the game creator can still interact with their own game across peers.
- Slash-command capability metadata gates game mutations through custom auth:
  - help/list/status use `system.status`
  - guess/close use `game.interact`

Important boundary:

- This first game proves the card/runtime/storage path; richer game mechanics should remain in `src/custom/game.ts` or adjacent custom modules rather than `gateway.ts`.
- Open game status intentionally does not reveal the secret; answers are shown only after win/close.

### `src/custom/fallbacks.ts`

Pure fallback policy helpers for known failure modes:

- response timeout constants and user notice text
- tool-only no-block timeout constants and no-output notice text
- tool media send timeout constants
- tool text fallback selection
- model skip tokens such as `NO_REPLY` and `[SKIP]`
- dispatch failure classification
- context/token limit error classification and recovery notice text
- structured `custom-fallback` event construction and log formatting

Boundary:

- It is pure TypeScript and has no gateway, QQ API, timer, filesystem, or OpenClaw SDK dependency.
- `gateway.ts` still owns queue release, timer lifecycle, log emission, retry, and outbound sends.

### `src/custom/urgent-commands.ts`

Pure queue-bypass command policy:

- Defines the urgent slash commands that must remain usable while a peer queue is blocked: `/stop`, `/approve`, `/new`, and `/compact`.
- Matches the first slash command token only, so `/new reset` bypasses the queue but `/newspaper` does not.
- Builds `urgent-queue-bypass` diagnostic events from gateway-provided queue snapshots.
- Keeps the command list, peer mapping, and event construction testable outside `gateway.ts`; gateway still owns mention stripping, queue clearing, immediate execution, logging, and slash/framework dispatch.

Boundary:

- It is pure TypeScript and has no gateway, QQ API, queue, filesystem, or OpenClaw SDK dependency.
- `gateway.ts` still owns mention stripping, queue snapshot/clearing, immediate execution, and final routing.

Current implemented safeguards:

- `/stop`, `/approve`, `/new`, and `/compact` bypass normal queueing in `gateway.ts`.
- `src/message-queue.ts` now keeps immediate commands in a small pending-immediate list if the processor has not started yet, then flushes them as soon as `startProcessor()` is called.
- Immediate execution can run while the same peer has a blocking queued message in flight, which keeps recovery commands usable after context-length failures or response timeouts.
- Urgent queue bypasses emit `urgent-queue-bypass` fallback events with command, queue peer id, dropped queued message count, before/after sender pending counts, and active processing age.
- Response timeout sends a visible user notice and ignores late block/tool deliveries.
- Tool-only runs get a fallback path that forwards collected tool media/text, or sends a visible no-output notice.
- Context/token limit errors send a visible recovery notice that suggests `/compact` first and `/new` if needed.
- Timeout/no-output/context notices include QQ command-input shortcuts so users can trigger `/compact`, `/new`, or `/bot-fallback summary 20` without manually typing slash commands while the chat is in a degraded state.
- Fallback paths emit structured log events with account, peer, actor, session key, run/message id, response state, and tool-deliver counts.
- Fallback events include a queue snapshot: total pending, active users, max concurrency, sender pending, sender active age, and max active age.
- Recent fallback events are persisted under `~/.openclaw/qqbot/data/custom-fallback-events/events-<accountId>.json` with a bounded ring buffer.
- Error replies retry without `msg_id` when the passive reply anchor is invalid/expired/unauthorized.
- `/bot-queue` reads a live queue snapshot for the current peer, so users/admins can check pending and active durations before or after a fallback event is written.
- Repeated timeout/context fallback incidents can notify `customRuntime.adminGroup` after persistence, using the same proactive acceptance/budget guard as other unanchored management-group sends.

### `src/custom/fallback-event-store.ts`

Bounded JSON persistence for recent fallback events.

Implemented behavior:

- Stores recent `custom-fallback` events per account.
- Defaults to retaining the latest 100 events.
- Keeps queue snapshot fields inside event details when the gateway provides them, including active peer duration when available.
- Stores urgent queue-bypass diagnostics in the same stream as timeout/context/tool fallback events.
- Uses the same atomic write pattern as auth/unread/task/poll stores.
- Returns an empty list on missing, incompatible, or unreadable files so fallback handling never blocks queue recovery.

### `src/custom/fallback-gateway-adapter.ts`

Chat command adapter for recent fallback events.

Implemented commands:

- `/bot-fallback`
- `/bot-fallback list [1-20]`
- `/bot-fallback status [1-20]`
- `/bot-fallback summary [1-100]`
- `/bot-fallback clear --force`

Authorization:

- Uses slash-command metadata, so list/status access requires `system.status` through admin, scene capability, or temporary grant.
- Summary access also requires `system.status` and aggregates recent fallback kinds plus max queue pressure.
- Summary output also reports the longest sender-active/max-active durations observed in recent fallback events.
- List/status output expands urgent queue-bypass events with command, dropped queued-message count, queue peer id, after-clear pending counts, and active peer duration.
- Summary output includes an urgent queue-bypass count so admins can verify whether `/new` or `/compact` recovery commands actually reached the queue bypass path.
- List/status and summary output append QQ command-input shortcuts for `/compact` and `/new`.
- Clearing events requires `config.write` and an explicit `--force`.

Still separate from the pure module:

- automatic session reset after context-too-long errors
- config schema rejection formatting

### `src/custom/fallback-alerts.ts`

Pure repeated-fallback alert policy for management-group operational notices.

Implemented behavior:

- Default enabled when `customRuntime.enabled=true` and `customRuntime.adminGroup` is bound.
- Default alert kinds are `response-timeout` and `context-too-long`.
- Default threshold is 3 matching incidents for the same account/peer within 15 minutes.
- Default cooldown is 30 minutes per account/peer; gateway owns the in-process cooldown map.
- Supports optional config under `channels.qqbot.customRuntime.fallbackAlerts`:
  - `enabled`
  - `windowMs`
  - `threshold`
  - `cooldownMs`
  - `kinds`
- Alert text includes aggregate counts, latest event timestamp, queue counters, and command-input shortcuts for `/bot-queue` and `/bot-fallback summary 20`.
- Alert decisions also include a QQ inline command keyboard for the management group with read-only buttons for `/bot-queue` and `/bot-fallback summary 20`; gateway sends it through the same guarded management-group path and falls back to text if no keyboard is present.
- Recovery commands such as `/compact` and `/new` are intentionally not exposed as management-group alert buttons because they act on the peer where the command message is sent.
- Alert text deliberately omits raw error reasons, prompts, cached message bodies, and queued message content.

Boundary:

- The module only decides whether an alert should exist and formats the text.
- `gateway.ts` loads recent persisted fallback events, applies cooldown, sends the group message, and commits the proactive budget only after successful QQ delivery.
- Alert sends are best-effort and must not block the user-visible fallback reply or queue release path.

### `src/custom/queue-status-gateway-adapter.ts`

Read-only adapter for live queue health.

Implemented commands:

- `/bot-queue`
- `/bot-queue status`
- `/bot-queue help`

Behavior:

- Requires `system.status` through slash-command metadata.
- Receives `peerId` and `QueueSnapshot` from `gateway.ts`; it does not import `src/message-queue.ts` or own queue state.
- Reports current-session pending count, global pending count, active user concurrency, sender active duration, and longest active duration.
- Adds QQ command-input shortcuts for `/compact` and `/new` only when the current peer has pending or active work.
- Does not display queued message bodies, unread snapshots, or cached chat content.

### `src/custom/deploy-preflight.ts`

Read-only deploy safety summary for chat.

Implemented behavior:

- `/bot-deploy preflight` inspects the live config object and formats a management-friendly summary.
- Checks admin anchors, management group anchor, `customRuntime.enabled`, management-group scene binding, update package source, upgrade mode, package override setting, custom update check setting, and duplicate/legacy QQBot plugin config entries.
- Uses `deploy.check` capability through slash-command metadata.
- Returns a QQ command keyboard: refresh/version are always available, `confirm /bot-upgrade --latest` appears only when no blockers exist, and blocker states expose only read-only diagnostics such as `/bot-auth status` and `/bot-scene bindings`.
- Does not read server extension directories, run shell commands, install packages, restart the gateway, delete files, or mutate config.
- Complements but does not replace `scripts/preflight-custom-runtime-deploy.mjs --require-ready`, which should still run on the server before real deploy/update.

### `src/custom/update-check.ts`

Checks the custom fork/release, not the official plugin, for deployable updates.

Implemented behavior:

- Resolves the update source from `channels.qqbot.upgradePkg` or the installed package name.
- Runs a gateway background loop with `customUpdateCheck.enabled !== false`.
- Defaults to a 6 hour interval and clamps overly small intervals to 5 minutes.
- Logs available personal-package updates once per version.
- Builds a management-group notification when a new personal-package version is detected and `customRuntime.adminGroup` is bound.
- The notification includes command buttons for `/bot-version`, `/bot-deploy preflight`, and `/bot-deploy confirm /bot-upgrade --latest`; it is sent through the same proactive budget/acceptance guard as other management-group pushes.
- Never installs packages; `/bot-deploy` and `/bot-upgrade` remain explicit admin-controlled paths.

Still separate from runtime:

- Official upstream change review stays in local git workflow (`git fetch upstream`, inspect diff, then merge/cherry-pick into `custom-runtime` if desired).
- Release-note summaries are still future UX work.
- Server backup and install remain part of the upgrade script/manual deploy path.

Current update guardrails:

- The deployed package derives its default update source from `package.json.name`.
- Custom builds use `@lukesong/openclaw-qqbot` while keeping OpenClaw plugin id `openclaw-qqbot`.
- `channels.qqbot.upgradePkg` can override the npm package checked by `/bot-version` and `/bot-upgrade`.
- `channels.qqbot.upgradeMode` defaults to `doc`, so the instance reports available custom updates without installing them.
- `channels.qqbot.customUpdateCheck.enabled` defaults to true; it checks/logs personal package updates and can notify the bound management group once per version.
- Hot reload remains available only after explicit config opt-in and an admin `/bot-upgrade --latest` or `/bot-upgrade --version X`.

## Gateway Integration Points

Minimal changes in `src/gateway.ts` should be limited to:

- normalize incoming events into `CustomInboundMessage`
- call custom runtime before enqueue
- let runtime record non-trigger messages
- let runtime provide extra context for dispatch
- call runtime after dispatch completion/failure
- let runtime create synthetic messages through a typed interface
- delegate custom state restore/save to `src/custom/message-flow-state.ts`

Avoid hardcoding custom timers, scene policy, or child processes directly in `gateway.ts`.

## Initial Milestones

1. Land documentation and current-state evidence.
2. Add custom type skeleton and config namespace without changing behavior.
3. Productize safe hotfixes: token fallback, timeout fallback, urgent commands, unanchored error retry.
4. Extract unread runtime from server hotfix into `src/custom/unread-runtime.ts`.
5. Add auth and scene policy in dry-run/log-only mode.
6. Enable policy enforcement for config mutation and dangerous commands.
7. Add task sandbox status model.
8. Deploy to server under custom package identity and validate in test group/DM.
