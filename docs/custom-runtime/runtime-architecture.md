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

### `src/custom/runtime-services-gateway-adapter.ts`

Gateway-side service bootstrap for the custom message-flow runtime.

Current implementation status:

- Creates the command-backed long-task executor from `customRuntime.tasks.commandExecutor`.
- Wires executor `complete`/`fail` callbacks to task runtime status transitions, workspace status writes, async notifications, and configured notification audiences.
- Wires executor `heartbeat`/`progress` callbacks to task runtime updates and task-state persistence.
- Creates and restores the custom unread scheduler with peer-level config resolution, synthetic catch-up enqueue callback, and unread-state persistence callback.
- Returns `resolveUnreadForEvent()` / `resolveUnreadForPeer()` so gateway group dispatch can reuse the same restore-time config path without importing unread constants or queue-shape details.

Important boundary:

- The adapter owns custom runtime service wiring, but it does not own QQ token acquisition, proactive-send policy, or text delivery; `gateway.ts` injects `sendTaskStatusText()` so all unanchored task notifications still pass through the existing proactive guard.
- It does not create or persist the top-level runtime state; `src/custom/message-flow-state.ts` remains responsible for loading/saving auth, unread, proactive budget, task, poll, game, and deploy-confirmation state.

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

### `src/custom/scene-route-gateway-adapter.ts`

Gateway-side scene route setup before inbound message preparation.

Current implementation status:

- Receives the framework base route plus normalized route peer and custom scene peer from `gateway.ts`.
- Resolves the custom scene only when `channels.qqbot.customRuntime.enabled=true`.
- Stops processing before dispatch when a resolved scene has `enabled:false`, preserving the existing skip log.
- Applies scene `agentId` overrides through the framework routing helper so `agentId`, `sessionKey`, and `matchedBy` stay aligned.
- Returns the account system prompt plus the resolved scene prompt as `systemPrompts`, so `gateway.ts` no longer builds scene prompts inline.

Important boundary:

- The adapter does not decide framework routing, account lookup, config reloads, message parsing, or QQ send behavior.
- `gateway.ts` still owns the initial OpenClaw route resolution and passes only the route/scene inputs needed by this custom layer.

### `src/custom/message-ingress-gateway-adapter.ts`

Gateway-side setup adapter for the start of each queued message pipeline.

Current implementation status:

- Logs the received `QueuedMessage`, attachment count, and records inbound channel activity through an injected callback.
- Starts the C2C/channel-DM input-notify keepalive and returns the same `typing` handle consumed by downstream dispatch/auth/fallback paths.
- Resolves `gateway-message-routing.ts` context, calls the injected framework route resolver, applies `scene-route-gateway-adapter.ts`, and returns a stop result for disabled scenes.
- Resolves framework envelope format options through an injected callback so inbound preparation can continue without gateway repeating route/envelope setup inline.
- Returns route, message-route, typing, scene prompts, and envelope options as one ingress bundle for the rest of `handleMessage`.

Important boundary:

- The adapter does not parse attachments, build agent context, authorize commands, or dispatch replies. It only owns the ingress setup before custom group dispatch and inbound message preparation.
- QQ token access for input-notify, channel activity recording, framework routing, and envelope formatting remain injected from `gateway.ts`.

### `src/custom/message-context-gateway-adapter.ts`

Gateway-side context pipeline after message ingress and before dispatch setup.

Current implementation status:

- Runs `inbound-preparation-gateway-adapter.ts` with injected attachment, quote/ref-index, and framework envelope callbacks.
- Applies static QQBot context hints such as TTS availability before scene/account prompts reach the final context payload.
- Computes the legacy `allowFrom` command authorization flag used by group gating and downstream dispatch authorization.
- Runs `group-dispatch-gateway-adapter.ts`, including custom unread ingress/skip behavior, mention detection, group prompt context, and stop decisions.
- Runs `agent-context-gateway-adapter.ts` to produce the final `ctxPayload` for OpenClaw dispatch, while returning the fields needed by later auth and unread-completion hooks.

Important boundary:

- The adapter does not send replies, resolve QQ tokens, or call OpenClaw dispatch. It owns context assembly only.
- Gateway still injects framework formatting/finalization, group policy resolvers, history envelope formatting, and custom unread scheduler/persistence callbacks.

### `src/custom/message-dispatch-gateway-adapter.ts`

Gateway-side dispatch pipeline after context assembly.

Current implementation status:

- Runs dispatch setup so reply anchors, send helpers, outbound deliver context, and guarded media sending are prepared in one post-context boundary.
- Runs custom scene/capability authorization before any OpenClaw dispatch call; denied messages stop typing and return before request context binding.
- Binds the AsyncLocalStorage request context for agent/tool execution using the fully qualified QQBot target.
- Creates the fallback session inside that request context, then delegates model reply execution to `dispatch-reply-gateway-adapter.ts`.
- Applies unread completion after reply finalization, including custom unread snapshots, legacy group-history clearing, persistence, and scheduler effects.

Important boundary:

- The adapter does not own QQ token retrieval, inline keyboard transport, framework dispatch implementation, or proactive/fallback admin-group delivery; these remain injected from `gateway.ts`.
- It keeps the remaining `gateway.ts` message handler at ingress -> context -> dispatch, which makes later custom message-flow behavior easier to replace or test.

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

### `src/custom/admin-group-delivery-gateway-adapter.ts`

Gateway-side sender adapter for management-group operational pushes.

Current implementation status:

- Covers auth approval copies, repeated-fallback alerts, and custom update notifications to `customRuntime.adminGroup`.
- Applies the injected proactive guard before any unanchored group send, and commits the budget only after the caller's QQ send callback succeeds.
- Supports inline-keyboard and text fallback callbacks without importing QQ API functions into the custom module.
- Owns shared logging, blocked/skipped/failed result statuses, and fallback-alert cooldown handling so `gateway.ts` only builds delivery descriptions.
- Does not build auth/fallback/update content itself; those policy modules still own the notification text and keyboard payloads.

### `src/custom/admin-group-notification-service-gateway-adapter.ts`

Gateway-side service wrapper for all `customRuntime.adminGroup` pushes.

Current implementation status:

- Provides a single service object for auth approval copies, repeated-fallback alerts, and custom fork update notifications.
- Owns the in-process cooldown map shared by management-group deliveries, while `admin-group-delivery-gateway-adapter.ts` still owns the low-level send/guard decision.
- Builds fallback alert delivery descriptions from `fallback-alerts.ts` config and update prompts from `update-check.ts`.
- Keeps the proactive guard, QQ token-backed text send, and QQ inline-keyboard send as injected callbacks from `gateway.ts`.
- Lets `gateway.ts` pass `customAdminGroupNotifications.sendAuthAdminGroupNotification`, `sendFallbackAdminGroupAlert`, and `sendUpdateAvailableNotification` into slash, dispatch, fallback, and update-check flows instead of maintaining separate closures.

Important boundary:

- The service does not import QQ send APIs or token helpers. It centralizes management-group policy glue without moving platform credentials out of the connector.
- It is the operational-notification boundary for future system pushes, so additional management-group cards should attach here rather than adding more ad-hoc closures to `gateway.ts`.

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
- `src/custom/dispatch-auth-delivery-gateway-adapter.ts` owns the ordinary-dispatch denial delivery decision: prefer C2C/group approval cards, fall back to visible text on card failure or unsupported targets, and return a management-group notification intent for the gateway to send through `admin-group-delivery-gateway-adapter`.

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

### `src/custom/inbound-event-normalizer.ts`

Gateway-side normalizer for QQ inbound event shapes.

Current implementation status:

- Converts `C2C_MESSAGE_CREATE`, `AT_MESSAGE_CREATE`, `DIRECT_MESSAGE_CREATE`, `GROUP_AT_MESSAGE_CREATE`, and `GROUP_MESSAGE_CREATE` into the internal `QueuedMessage` shape used by the message-flow pipeline.
- Emits known-user records alongside message results, preserving the current openid-only mapping: C2C/guild/DM users by user openid and group users by `member_openid + group_openid`.
- Normalizes quote/ref indexes through the shared `parseRefIndices()` helper, including `message_scene.ext` and `msg_elements[0].msg_idx` for quote messages.
- Normalizes proactive receive/reject events (`C2C_MSG_REJECT`, `C2C_MSG_RECEIVE`, `GROUP_MSG_REJECT`, `GROUP_MSG_RECEIVE`) into peer acceptance updates with millisecond timestamps.
- Normalizes `GROUP_ADD_ROBOT` / `GROUP_DEL_ROBOT` into loggable group robot membership events; add events still record the operator as a known group user.
- Does not enqueue, persist known users, mutate proactive budget state, or send replies. `gateway.ts` applies the returned effects.
- Field-level receive coverage and verification status are tracked in `docs/custom-runtime/qqbot-message-flow.md` under `Normalized Event Field Matrix`; that table is the authoritative checklist before custom policy depends on a QQ event field.

### `src/custom/inbound-event-gateway-adapter.ts`

Gateway-side inbound event dispatcher for WebSocket/Webhook shared event fanout.

Current implementation status:

- Calls `src/custom/inbound-event-normalizer.ts` first so C2C/group/guild/channel-DM message events enter the existing `QueuedMessage` path with known-user records.
- Applies proactive receive/reject updates through injected budget and persistence callbacks, keeping proactive acceptance state out of `gateway.ts`.
- Applies group robot add/remove known-user records and logs without coupling the gateway to event-specific field mapping.
- Logs message delete diagnostics through the dedicated delete inspector.
- Normalizes `INTERACTION_CREATE` for logging and hands the raw interaction event to the existing interaction handler with async error logging.

### `src/custom/websocket-reconnect-policy.ts`

Pure WebSocket reconnect/close policy for the official QQ Gateway transport.

Current implementation status:

- Classifies close codes that should stop reconnects, refresh tokens, clear persisted sessions, re-identify, or back off for rate limits.
- Preserves QQ close-code behavior from `gateway.ts`: `4004` refreshes token, `4008` waits the rate-limit delay, `4006`/`4007`/`4009` reset session state, `4900`-`4913` re-identify, and `4914`/`4915` stop reconnecting.
- Tracks quick-disconnect counters as a pure state transition and returns the rate-limit backoff decision when repeated fast disconnects exceed the configured threshold.
- Classifies connection setup failures such as `Too many requests` / `100001` into rate-limit retry delay.

Important boundary:

- The module does not own a WebSocket instance, timers, session storage, token cache, or reconnect scheduling. It only returns a decision object; `gateway.ts` still applies session cleanup, token-cache refresh state, logging, and `scheduleReconnect()`.
- Keeping this policy pure makes future transport changes (Webhook-only mode, official SDK transport changes, or separate connector package) easier to validate without replaying live QQ gateway failures.

### `src/custom/websocket-close-gateway-adapter.ts`

Gateway-side adapter for WebSocket close events and connection setup failures.

Current implementation status:

- Applies `websocket-reconnect-policy.ts` decisions to injected side effects: session clearing, token-refresh flag updates, quick-disconnect counter updates, cleanup, and reconnect scheduling.
- Logs close reasons and policy diagnostics in the same account-prefixed format used by the rest of the connector.
- Handles connection setup failures through the shared rate-limit classifier for `Too many requests` / `100001`.
- Returns a typed summary for tests and future transport lifecycle orchestration.

Important boundary:

- The adapter does not import `ws`, session-store, token-cache helpers, or timers directly. `gateway.ts` still owns the live transport objects and injects setters/callbacks.
- Close handling is now separate from message handling, so future transport changes can independently test connection failure behavior and inbound packet behavior.

### `src/custom/websocket-connection-gateway-adapter.ts`

Gateway-side adapter for binding one live QQ Gateway WebSocket connection.

Current implementation status:

- Acquires the access token and gateway URL, then creates the WebSocket with the plugin User-Agent.
- Registers open/message/close/error event handlers in one boundary, so `gateway.ts` no longer wires each WebSocket callback inline.
- Applies open lifecycle effects through injected setters/callbacks: clear `isConnecting`, reset reconnect attempts, record `lastConnectTime`, start the message queue processor, and start background token refresh.
- Delegates message packets to `websocket-message-gateway-adapter.ts`, while binding `sendJson` and heartbeat timer reset to the live socket.
- Delegates close and connection-failure handling to `websocket-close-gateway-adapter.ts`, preserving quick-disconnect, rate-limit, session, and reconnect behavior.

Important boundary:

- The adapter owns only the connection callback wiring. Higher-level gateway state, message handling, inbound event fanout, reconnect scheduling, cleanup, and startup greeting behavior remain injected from `gateway.ts`.
- The default implementation imports the official API/session helpers and `ws`, but tests can inject fake socket/API/session handlers; this keeps the transport lifecycle movable toward a future standalone connector package.

### `src/custom/websocket-payload-policy.ts`

Pure WebSocket payload/session policy for QQ Gateway op messages.

Current implementation status:

- Builds Hello responses for either Resume (`op=6`) or Identify (`op=2`) using the current access token, session id, last sequence, and full-intent settings.
- Builds heartbeat payloads (`op=1`) without letting the gateway duplicate raw packet shape.
- Classifies Dispatch payloads into `READY`, `RESUMED`, or ordinary event fanout, including whether the first-startup greeting should fire.
- Classifies Invalid Session payloads into session-clear, token-refresh, cleanup, and 3 second reconnect effects.

Important boundary:

- The module does not send WebSocket frames, own heartbeat timers, write session storage, mutate `_pendingFirstReady`, or call `onReady`. `gateway.ts` applies those side effects after reading the returned decision.
- Keeping payload decisions pure gives the transport layer a testable seam before a larger WebSocket/Webhook lifecycle extraction.

### `src/custom/websocket-message-gateway-adapter.ts`

Gateway-side adapter for QQ Gateway WebSocket `message` events.

Current implementation status:

- Parses raw WebSocket message frames into `WSPayload` and logs parse failures without throwing into the WebSocket callback.
- Applies sequence updates and session persistence through injected `saveSession` / state setter callbacks.
- Delegates Hello, READY/RESUMED/ordinary dispatch, and Invalid Session decisions to `websocket-payload-policy.ts`.
- Starts heartbeat through an injected timer reset callback and sends heartbeat payloads through an injected `sendJson` callback.
- Applies READY/RESUMED side effects through injected `onReady`, `_pendingFirstReady` markers, and startup greeting callbacks.
- Applies server reconnect and invalid-session retry through injected `cleanup` and `scheduleReconnect` callbacks.

Important boundary:

- The adapter does not import `ws`, token helpers, session-store helpers, startup-greeting logic, or inbound event normalizers directly. `gateway.ts` still owns those platform/process side effects.
- This adapter is the bridge between the official WebSocket transport and the custom runtime event fanout; it enables a future transport lifecycle extraction without mixing transport packet policy with message-flow customization.

### `src/custom/webhook-transport-gateway-adapter.ts`

Gateway-side adapter for the QQBot Webhook transport mode.

Current implementation status:

- Starts the shared message queue processor before the Webhook transport begins receiving events.
- Starts background token refresh with the same account credentials used by the WebSocket path.
- Logs Webhook event fanout and delegates normalized event handling through the injected `dispatchInboundEvent()` callback.
- Applies Webhook READY side effects: framework `onReady`, first-startup greeting, and `_pendingFirstReady` consumption.
- Forwards Webhook transport errors to the gateway-level error callback, then stops background token refresh and unregisters the approval handler after the transport returns.

Important boundary:

- The adapter does not normalize QQ events, own message handling, or own approval/runtime state; it only binds Webhook transport lifecycle callbacks to injected gateway side effects.
- This keeps WebSocket and Webhook startup paths structurally similar while preserving the same `handleMessage` and `dispatchInboundEvent` core pipeline.

### `src/custom/queued-message-context.ts`

Shared mapper from gateway `QueuedMessage` values into custom runtime peer/actor identities.

Current implementation status:

- Converts queued C2C/group/guild/channel-DM messages into `CustomPeer` without importing auth, scene, task, poll, or game runtimes.
- Converts queued sender metadata into `CustomActor` for auth, poll, game, task, deploy, and fallback adapters.
- Provides the queue peer prefix fallback used by urgent queue-bypass diagnostics when a queued group/channel message is missing the platform peer field.
- Keeps channel-DM peer mapping on the existing sender-id behavior for compatibility; `docs/custom-runtime/qqbot-message-flow.md` still marks channel-DM custom scene behavior as unaudited.
- `src/custom/auth-gateway-adapter.ts` re-exports the mapper for compatibility, but new custom adapters should import it directly from `queued-message-context.ts` to avoid depending on auth internals.

### `src/custom/gateway-message-routing.ts`

Pure helper for the gateway's per-message routing context.

Current implementation status:

- Resolves the queue/framework peer id, framework route peer, custom scene peer, inbound `From` / `To` address, request-context target, and reply target from a `QueuedMessage`.
- Keeps existing compatibility behavior for guild and channel-DM paths while making those mappings explicit and testable; channel-DM custom scene behavior remains marked unaudited in the message-flow document.
- `gateway.ts` now asks this helper for routing primitives instead of repeating event-type conditionals around routing, scene lookup, request context, and reply target construction.

### `src/custom/reply-context-gateway-adapter.ts`

Gateway-side helper for constructing reply anchors, reply targets, and `ReplyContext` values before dispatch/auth/fallback sends.

Current implementation status:

- Resolves the passive reply anchor from the queued message id, but removes it for synthetic unread catch-up messages so proactive-style replies are not tied to a stale original message.
- Reuses the existing gateway message reply target mapping and packages the result into the shared `ReplyContext` used by `reply-dispatcher.ts`.
- Carries the injected unanchored-text proactive guard through the context without importing QQ send APIs or proactive runtime state.
- `gateway.ts` still owns token retry helpers, error-message sends, and platform delivery calls; this adapter only builds the context object.

### `src/custom/dispatch-authorization-gateway-adapter.ts`

Gateway-side orchestration helper for ordinary message dispatch authorization.

Current implementation status:

- Runs `checkCustomDispatchAuthorization()` and logs/restores authorization intents with the same formatting as the gateway path.
- Persists auth state when approval/grant intents are emitted, preserving request durability before any denial delivery happens.
- Delegates visible denial/card/text fallback to `dispatch-auth-delivery-gateway-adapter.ts` and forwards admin-group notification intents with `source=dispatch`.
- Returns a `shouldStop` flag so `gateway.ts` can stop typing and exit the current dispatch without owning auth orchestration details.

### `src/custom/dispatch-send-helpers-gateway-adapter.ts`

Gateway-side helper factory for ordinary-dispatch send callbacks.

Current implementation status:

- Binds account credentials, account id, logger, and `ReplyContext` into the token-retry and visible error-message send helpers used by dispatch auth, fallback notices, media-tag delivery, and plain replies.
- Accepts injected `sendWithTokenRetry()` and `sendErrorToTarget()` callbacks for deterministic tests while defaulting to `reply-dispatcher.ts` at runtime.
- Keeps actual QQ sends, token refresh behavior, and reply-dispatcher retry semantics outside the custom runtime core; the helper only wires per-message parameters.

### `src/custom/dispatch-setup-gateway-adapter.ts`

Gateway-side setup helper for ordinary dispatch after agent context has been built.

Current implementation status:

- Builds the reply anchor, reply target, and `ReplyContext` through `reply-context-gateway-adapter.ts`.
- Binds token-retry send helpers and visible error-message delivery through `dispatch-send-helpers-gateway-adapter.ts`.
- Builds the outbound deliver event/account context through `outbound-deliver-context.ts`, including the proactive source metadata from the inbound message.
- Returns a guarded media auto-send callback that reuses `guarded-media-send-gateway-adapter.ts`.
- Keeps passive reply semantics intact: normal replies keep the QQ `msg_id` anchor, while synthetic unread catch-up messages have no reply anchor and therefore pass through proactive guards.

Important boundary:

- The adapter does not run authorization or dispatch the model; it only prepares shared per-message delivery objects.
- It accepts proactive guard and media-send callbacks from `gateway.ts`, so proactive budget state, token ownership, and QQ media APIs stay at the connector boundary.

### `src/custom/dispatch-reply-gateway-adapter.ts`

Gateway-side orchestrator for one ordinary OpenClaw reply dispatch.

Current implementation status:

- Resolves effective message config for the selected agent route and logs the per-message run id.
- Sets up streaming through `dispatch-streaming-setup-gateway-adapter.ts`.
- Wires the buffered block dispatcher callbacks to `dispatch-deliver-callback-gateway-adapter.ts`, `dispatch-error-callback-gateway-adapter.ts`, and `streaming-gateway-adapter.ts`.
- Delegates dispatch/timeout completion to `dispatch-completion-gateway-adapter.ts`.
- Handles outer processing failures with `dispatch-failure-gateway-adapter.ts` and always stops typing in `finally`.
- Exposes a post-finalize hook so gateway can keep custom unread completion as injected message-flow behavior rather than hardcoding it into the generic reply dispatch adapter.

Important boundary:

- The adapter does not resolve auth, scene, group gates, or agent context; it starts after gateway has already built `ctxPayload` and delivery contexts.
- It does not call QQ APIs directly. Token retry, media tag parsing, structured payload handling, plain reply sending, and outbound activity recording remain injected gateway callbacks.

### `src/custom/dispatch-deliver-gateway-adapter.ts`

Gateway-side preflight helper for dispatch deliver callbacks.

Current implementation status:

- Records and ignores late deliver callbacks after response timeout, preserving the existing `late-deliver-after-timeout` fallback event details.
- Applies group-only model-skip token detection before block state is marked, so `NO_REPLY` / `[SKIP]` still suppresses visible group replies without affecting C2C.
- Marks block response state, stops typing, clears response/tool-only timers, and logs prior tool-deliver counts through injected callbacks.
- Keeps debouncing, media-tag parsing, structured-payload handling, and final QQ sends in `gateway.ts`; streaming callback orchestration is now delegated to `streaming-gateway-adapter.ts`.

### `src/custom/dispatch-deliver-callback-gateway-adapter.ts`

Gateway-side orchestrator for one `deliver` callback from OpenClaw's buffered block dispatcher.

Current implementation status:

- Applies late-deliver filtering before any state mutation, preserving timeout diagnostics and ignoring block/tool output that arrives after a response timeout.
- Marks response state and routes `tool` deliveries to `tool-deliver-gateway-adapter.ts` with the per-dispatch fallback session timer accessors.
- Runs block-deliver preflight from `dispatch-deliver-gateway-adapter.ts`, including model-skip detection, typing stop, response-timeout clearing, and tool-only timer clearing.
- Hands block payloads to `streaming-gateway-adapter.ts` first; when streaming does not handle them, it executes static delivery through `static-deliver-gateway-adapter.ts`.
- Applies static delivery through `deliver-debounce-gateway-adapter.ts`, so the gateway only stores the current debouncer handle and injects send/format callbacks.

Important boundary:

- The adapter does not call QQ APIs directly. `gateway.ts` still injects media tag parsing, structured payload handling, plain reply sending, token retry, outbound activity recording, and the debouncer factory.
- It depends on the per-dispatch fallback session interface rather than owning runtime config, queue snapshots, or fallback persistence itself.

### `src/custom/streaming-gateway-adapter.ts`

Gateway-side orchestration helper around `StreamingController`.

Current implementation status:

- Handles streaming block-deliver callbacks, including debug logging, `onDeliver()`, static fallback detection, and outbound activity recording.
- Handles streaming `onError` and `onPartialReply` callbacks with the same best-effort logging and static fallback behavior as the previous inline gateway path.
- Finalizes streaming after dispatch completion by calling `markFullyComplete()` / `onIdle()` and best-effort `abortStreaming()` on failure.
- Streaming enablement and controller construction now live in `src/custom/dispatch-streaming-setup-gateway-adapter.ts`; this adapter owns only the runtime callback orchestration after a controller exists.

### `src/custom/dispatch-streaming-setup-gateway-adapter.ts`

Gateway-side setup helper for streaming dispatch state.

Current implementation status:

- Resolves the dispatch target type (`c2c`, `group`, or `channel`) from the queued message.
- Applies the existing `shouldUseStreaming()` policy and logs enabled/disabled state with the account prefix.
- Creates `StreamingController` only when streaming is enabled and the message has a passive reply anchor.
- Builds the controller dependencies, including log prefix and media send context, without letting `gateway.ts` know the constructor shape.
- Keeps synthetic unread catch-up unanchored: if there is no reply anchor, streaming remains unavailable and the message falls back to normal/static delivery.

Important boundary:

- The adapter does not send partial replies or finalize streams; `src/custom/streaming-gateway-adapter.ts` still owns deliver/error/partial/finalize orchestration.
- It does not decide account config itself beyond calling the injected/default `shouldUseStreaming()` policy.

### `src/custom/static-deliver-gateway-adapter.ts`

Gateway-side executor for non-streaming/static deliver payloads.

Current implementation status:

- Owns the ordered static delivery pipeline: media-tag parsing/sending first, structured payload handling second, and plain reply sending last.
- Creates a per-deliver single-use quote-ref consumer so media/plain sends keep the same reply-anchor semantics while `gateway.ts` no longer owns that closure.
- Records outbound activity for media-tag and plain-send paths, while structured payloads keep using the injected record callback exactly as before.
- Records block-delivered media before plain sends so late tool-media dedupe continues to work through `CustomFallbackDispatchState`.
- Keeps actual `parseAndSendMediaTags()`, `handleStructuredPayload()`, and `sendPlainReply()` implementations injected by `gateway.ts` to avoid pulling QQ send APIs into the custom adapter.

### `src/custom/deliver-debounce-gateway-adapter.ts`

Gateway-side debounce dispatcher for static deliver payloads.

Current implementation status:

- Owns the create/reuse/direct-dispatch branch around `createDeliverDebouncer()` so `gateway.ts` only stores the current debouncer handle.
- Preserves disabled-debounce behavior by falling back to the injected direct deliver executor when the factory returns `null`.
- Keeps the actual debounce implementation in `src/deliver-debounce.ts`; this adapter only wires account-specific prefix, config, executor, and handle mutation.

### `src/custom/dispatch-finalize-gateway-adapter.ts`

Gateway-side `finally` cleanup helper for an ordinary dispatch.

Current implementation status:

- Clears the tool-only fallback timer through an injected timer clearer while `gateway.ts` only owns the mutable handle.
- Runs the tool-completion fallback path when dispatch completed after tool delivers but no block response.
- Disposes the deliver debouncer and clears the stored handle so buffered static replies still flush before dispatch completion.
- Finalizes the streaming controller through `streaming-gateway-adapter.ts`.
- Keeps unread/history completion and the outer typing stop call in `gateway.ts`.

### `src/custom/dispatch-completion-gateway-adapter.ts`

Gateway-side orchestrator for the end of one ordinary dispatch.

Current implementation status:

- Races the OpenClaw dispatch promise against the response-timeout promise.
- Clears the response-timeout timer before race-failure fallback handling and again before final cleanup, preserving the previous defensive cleanup behavior.
- Delegates timeout/context-too-long recovery notices to `dispatch-failure-gateway-adapter.ts`.
- Delegates tool-only fallback completion, debouncer disposal, and streaming finalization to `dispatch-finalize-gateway-adapter.ts`.
- Exposes a post-finalize hook with `hasModelBlockOutput` so `gateway.ts` can keep custom unread completion wiring outside the dispatch race/finalize core.

Important boundary:

- The adapter does not own unread runtime state. It only invokes the injected post-finalize hook after dispatch cleanup is done.
- It does not send QQ messages directly; visible fallback sends still flow through injected `sendErrorMessage()` / fallback-session callbacks.

### `src/custom/dispatch-fallback-session-gateway-adapter.ts`

Gateway-side per-dispatch fallback session wrapper.

Current implementation status:

- Creates the `CustomFallbackDispatchState` for one ordinary dispatch and exposes it as the shared fallback state source.
- Binds `createCustomDispatchFallbackRecorder()` once with account id, queued message, session key, runtime/queue/dispatch snapshots, logger, and management-group alert callback.
- Owns the response-timeout timer and exposes `createResponseTimeoutPromise()` / `clearResponseTimeout()` so gateway code no longer stores a separate response timer handle.
- Owns the mutable tool-only timer handle and exposes `getToolOnlyTimer()` / `setToolOnlyTimer()` for tool deliver and finalize adapters.
- Wires `sendToolFallback()` to `tool-fallback-gateway-adapter.ts` with guarded media auto-send and visible text fallback callbacks injected by `gateway.ts`.

Important boundary:

- The session wrapper does not classify timeout/context failures; `dispatch-failure-gateway-adapter.ts` still decides which recovery notice to send.
- It does not send QQ messages or read config files directly. Gateway injects the runtime snapshot, queue snapshot, alert sender, media sender, and text sender.

### `src/custom/typing-keepalive-gateway-adapter.ts`

Gateway-side helper for C2C input-notify and typing keepalive.

Current implementation status:

- Starts the initial C2C/channel-DM input-notify asynchronously so attachment processing can continue in parallel.
- Returns the delayed `refIdx` promise used by message-reference caching, matching the existing InputNotify fallback behavior.
- Retries once after token/401/11244-style failures by clearing the token cache through an injected callback.
- Starts the existing `TypingKeepAlive` after the initial notify succeeds and exposes a small `stop()` handle for auth denial, block delivery, and final cleanup paths.
- No-ops for group/guild messages because QQ input-notify is only supported for the C2C path in the current connector.

### `src/custom/dispatch-failure-gateway-adapter.ts`

Gateway-side orchestration helper for dispatch race failures.

Current implementation status:

- Classifies `Promise.race([dispatch, timeout])` failures as response-timeout, context-too-long, or other using the shared fallback policy.
- Records the matching structured fallback event and sends the visible recovery notice for response-timeout/context-too-long only when no block response or tool fallback has already handled the user.
- Handles dispatcher `onError` and outer message-processing failures for framework runtime module errors, context-too-long fallback records, auth-error logs, and ordinary process-error logs.
- Marks dispatch timeout and response state through an injected state interface, keeping `CustomFallbackDispatchState` as the source of truth while removing notice orchestration from `gateway.ts`.
- Leaves timer clearing and actual text delivery callbacks in `gateway.ts`, so OpenClaw/QQ sends stay at the boundary.

### `src/custom/dispatch-error-callback-gateway-adapter.ts`

Gateway-side orchestrator for the dispatcher `onError` callback.

Current implementation status:

- Logs the dispatcher error with the account prefix and marks the fallback session as having a response, preserving the previous no-duplicate-notice behavior.
- Clears the response-timeout timer immediately when the dispatcher error callback fires.
- Hands the error to `streaming-gateway-adapter.ts` first; when streaming handles the error, the callback stops without sending a duplicate fallback notice.
- Falls back to `dispatch-failure-gateway-adapter.ts` callback-failure handling when streaming is absent or degraded to static fallback.

Important boundary:

- The adapter does not classify race timeout failures; it only handles the dispatcher's own error callback.
- It does not send QQ messages directly. It uses the injected fallback recorder and visible text sender from the per-dispatch setup.

### `src/custom/outbound-deliver-context.ts`

Pure helper for constructing outbound delivery contexts used by media-tag parsing and normal reply delivery.

Current implementation status:

- Converts a queued message plus reply anchor into `DeliverEventContext`, preserving type, sender, channel/group ids, message id, ref reply id, and `msgIdx`.
- Packages account, qualified target, logger, and injected proactive guard into `DeliverAccountContext`.
- Builds the proactive guard source actor/message/timestamp metadata from the original queued message without importing proactive runtime state.
- `gateway.ts` still owns actual sends, token retry, media auto-send, and proactive guard creation; this helper only shapes the context objects.

### `src/custom/guarded-media-send-gateway-adapter.ts`

Gateway-side helper for media auto-send operations that must pass the custom proactive guard.

Current implementation status:

- Reuses the outbound delivery context and injected proactive guard to check unanchored media sends before any media send callback runs.
- Preserves passive reply behavior: when `replyToId` exists, media sends do not consume proactive budget.
- Calls the injected media send callback with qualified target, account id, account credentials, media URL, and reply anchor; successful sends commit proactive budget, failed sends do not.
- Logs blocked media sends through the gateway logger while keeping QQ media APIs and actual `sendMediaAuto()` calls outside the helper.

### `src/custom/group-activation.ts`

Gateway-adjacent helper for resolving group activation mode from the OpenClaw `/activation` session store.

Current implementation status:

- Resolves the framework session-store path from `cfg.session.store`, `{agentId}`, `~`, `OPENCLAW_STATE_DIR`, `CLAWDBOT_STATE_DIR`, and the default `~/.openclaw/agents/<agentId>/sessions/sessions.json` layout.
- Reads the current session entry and normalizes `groupActivation` to `mention` or `always`; invalid/missing values fall back to the group config's `requireMention` default.
- Keeps the filesystem read isolated from `gateway.ts`; tests can inject a file reader and environment so the parsing and fallback behavior are deterministic.
- `gateway.ts` still owns framework route/session keys and only consumes the resolved activation mode before the group message gate runs.

### `src/custom/group-message-gate-context.ts`

Pure helper for the group-message gate context that sits between QQ mention parsing and custom unread/autonomous flow.

Current implementation status:

- Normalizes the text-command body used by framework command detection without importing the framework runtime.
- Detects any group mention from QQ `mentions` or `<@...>` fallback text, so command bypass cannot accidentally trigger on messages that mention somebody else.
- Resolves implicit mention from quoted bot messages by accepting a ref-index lookup callback; cache reads stay in `gateway.ts`.
- Applies the synthetic unread catch-up override in one place: catch-up messages bypass `ignoreOtherMentions` and `requireMention`, and enter the gate as mentioned.
- Returns the existing `resolveGroupMessageGate()` decision plus the derived context fields; `gateway.ts` still owns logging, unread history writes, and all QQ/OpenClaw side effects.

### `src/custom/group-dispatch-gateway-adapter.ts`

Gateway-side group dispatch gate orchestrator.

Current implementation status:

- Runs group allow-list checks before any OpenClaw/model dispatch work continues.
- Resolves mention detection, `/activation` state, config-level `requireMention`, quote-based implicit mention, text-command permission, and `ignoreOtherMentions` into one gate decision.
- Applies skipped-message side effects through `src/custom/group-ingress-gateway-adapter.ts`, preserving custom unread first and legacy history fallback.
- Applies mention ingress before dispatch and returns the custom unread config, catch-up-after-reply flag, and mention-time history for downstream prompt/completion logic.
- Builds group prompt metadata through `src/custom/group-prompt-context.ts`, returning sender label, group subject, and group system prompt.

Important boundary:

- It still receives QQ/OpenClaw policy resolvers and send/persist/scheduler callbacks from `gateway.ts`; it does not own config storage, timers, or QQ sends.
- It keeps the group message-flow branch testable as a single application-layer decision instead of spreading stop/continue branches across `gateway.ts`.

### `src/custom/group-prompt-context.ts`

Pure helper for group prompt and metadata assembly after a group message has passed the gate.

Current implementation status:

- Formats the sender label as `name (openid)` when a nickname is available, otherwise uses the sender openid.
- Resolves group subject, group intro hint, and behavior prompt through injected callbacks, so config/plugin lookups stay at the gateway boundary while string assembly is testable.
- Joins prompt fragments with empty-value trimming and exposes a shared system-prompt merge helper for static QQBot instructions plus group prompt context.
- `gateway.ts` still owns the actual config resolvers, plugin `resolveGroupIntroHint()`, message routing, and final `finalizeInboundContext()` call.

### `src/custom/agent-message-body-context.ts`

Pure helper for building the current message body that is passed to the OpenClaw agent before unread-history injection.

Current implementation status:

- Preserves the existing command bypass behavior: slash-like command messages keep `agentBody` equal to the raw command, even though `userMessage` still records the formatted view.
- Formats single group messages with sender prefix and `(@你)` tag, while direct/C2C messages keep the existing no-prefix body shape.
- Formats merged group messages by wrapping preceding messages in the shared merged-message context block and keeping the final message as the current request.
- Accepts injected sub-message formatting and envelope callbacks, so face/mention/attachment parsing and framework envelope formatting remain at the gateway boundary.
- The returned initial `agentBody` is then passed through `src/custom/unread-context.ts` for custom/legacy history injection before `finalizeInboundContext()`.

### `src/custom/agent-context-gateway-adapter.ts`

Gateway-side agent context orchestrator after inbound preparation and group dispatch.

Current implementation status:

- Builds the current OpenClaw agent body through `src/custom/agent-message-body-context.ts`, preserving slash-command bypass, merged group-message formatting, quote fragments, dynamic media context, and `(@你)` tagging.
- Injects unread/catch-up context through `src/custom/unread-context.ts`, preserving custom snapshot/mention history priority over legacy group history.
- Logs final agent-body length at the gateway boundary for operational diagnostics.
- Builds the final inbound context payload through `src/custom/inbound-context-payload.ts` and passes it through an injected framework `finalizeInboundContext()` callback.

Important boundary:

- It does not own QQ sends, config lookups, route resolution, or framework runtime access; `gateway.ts` injects all formatting/finalization callbacks.
- It centralizes the last pre-dispatch context assembly step so custom message-flow changes can be tested before the OpenClaw dispatch call.

### `src/custom/inbound-preparation-gateway-adapter.ts`

Gateway-side inbound message preparation orchestrator.

Current implementation status:

- Runs attachment processing through an injected callback and converts the result into `src/custom/inbound-media-context.ts` media/dynamic-context fields.
- Normalizes user-visible content by applying face parsing, voice transcript injection, attachment info, group bot-mention stripping, and direct-message mention name replacement.
- Resolves quote context through `src/custom/message-reference-context.ts`, logs quote diagnostics, awaits the delayed InputNotify ref id, and writes the current message ref-index entry through an injected cache callback.
- Builds the framework-visible inbound envelope body through an injected formatter while preserving image URL forwarding for the Web UI.
- Logs voice summary counters after media context construction and returns all fields needed by group gate, agent-body construction, and `finalizeInboundContext()`.

Important boundary:

- It does not own attachment download implementation, QQ tokens, or framework formatting; those remain injected gateway/runtime callbacks.
- It keeps the media/quote/ref-index preparation path testable without starting a gateway or touching network/filesystem.

### `src/custom/inbound-context-payload.ts`

Pure helper for building the object passed into the OpenClaw `finalizeInboundContext()` boundary.

Current implementation status:

- Assembles body fields, route addresses, account/session ids, chat type, sender metadata, timestamps, provider/surface ids, and origin QQ ids from the already-normalized queued message.
- Merges static QQBot system prompts with group prompt context before they are injected as `GroupSystemPrompt`.
- Adds voice metadata, local/remote media fields, command authorization status, and quote `ReplyTo*` fields only when present, preserving the previous optional field behavior.
- `gateway.ts` still calls `pluginRuntime.channel.reply.finalizeInboundContext()` and owns framework runtime interaction; this helper only constructs the payload object.

### `src/custom/inbound-media-context.ts`

Pure helper for inbound image/voice context derived after attachment processing.

Current implementation status:

- Deduplicates voice local paths, voice remote URLs, and QQ ASR reference text before they are injected into the agent dynamic context.
- Builds compact dynamic prompt lines for images, voice inputs, and ASR text while keeping user-visible message formatting in `gateway.ts`.
- Counts STT/ASR/fallback transcript sources and formats the voice summary log line without reading config, filesystem, QQ APIs, or OpenClaw runtime state.
- Splits image/media URLs into local paths and remote URLs for the framework media fields, keeping that local/remote rule covered outside the main dispatch loop.

### `src/custom/message-reference-context.ts`

Pure helper for inbound quote/ref-index context.

Current implementation status:

- Resolves quoted-message context from local `ref-index` cache first, then falls back to QQ `msg_elements[0]` for quote messages when available.
- Builds the `[引用消息开始] ... [引用消息结束]` prompt fragment and returns structured `ReplyTo*` fields for `finalizeInboundContext()`.
- Builds current-message `ref-index` records from parsed content, sender metadata, attachment summaries, and voice transcript metadata; `gateway.ts` still owns the actual `setRefIndex()` side effect.
- Keeps quote logging messages and ref-index record construction testable without importing QQ send APIs, OpenClaw runtime state, or custom auth/scene runtimes.

### `src/custom/interaction-event-normalizer.ts`

Gateway-side normalizer for QQ `INTERACTION_CREATE` button/config events.

Current implementation status:

- Extracts interaction id, data type, scene description, button id/data, resolved fields, and actor id from QQ's scene-specific fields.
- Maps callback source fields into a custom peer: `group_openid` -> group, `user_openid` -> C2C, `channel_id` -> channel, `guild_id` -> DM fallback.
- Resolves follow-up reply targets for group, C2C, and channel callbacks without sending messages.
- Parses legacy OpenClaw approval button payloads (`approve:<id>:allow-once|allow-always|deny`) so gateway approval handling no longer owns regex details.
- Custom auth/poll/game/deploy callback routing now receives normalized actor/source/button fields from `gateway.ts`; config query/update interactions use the same normalized interaction fields before ACK.
- Interaction field coverage uses the same message-flow matrix so C2C/group cards can be deployed first while channel/DM interaction behavior stays explicitly marked as unverified.

### `src/custom/config-interaction-gateway-adapter.ts`

Gateway-side handler for official QQ connector config interactions.

Current implementation status:

- Handles `INTERACTION_CREATE` config query/update types `2001` and `2002`.
- Builds `claw_cfg` ACK payloads with plugin version, framework date version, group policy, current require-mention mode, mention patterns, and online state.
- Reads the latest config snapshot before query ACKs so QQ sees the same state as disk.
- Applies `require_mention` updates to default or named-account group config and writes the updated config through an injected config API.
- Resolves agent-aware mention patterns through the same routing + custom scene agent override path used by normal message processing.
- Leaves token lookup and the actual QQ ACK call in `gateway.ts` through an injected `acknowledge` callback.

### `src/custom/interaction-create-gateway-adapter.ts`

Gateway-side orchestrator for QQ `INTERACTION_CREATE` events.

Current implementation status:

- Normalizes the raw QQ interaction event once and reuses the normalized actor/source/reply-target fields across all callback-card branches.
- Runs official connector config query/update ACK handling first; config interactions return immediately and do not send a second generic ACK.
- Sends the generic interaction ACK before custom callback-card routing, matching the previous gateway behavior for auth/poll/game/deploy buttons.
- Applies custom interaction effects through `interaction-effects-gateway-adapter.ts`, including auth/poll/game/deploy persistence and optional follow-up replies.
- Keeps legacy OpenClaw approval buttons (`approve:<id>:...`) compatible by resolving the registered approval handler after ACK.

Important boundary:

- The adapter does not fetch QQ access tokens and does not call QQ send APIs directly. `gateway.ts` still injects `acknowledge`, `sendReply`, config API access, routing, and the legacy approval-handler lookup.
- It is the single gateway entry point for interactive cards, so future auth cards, poll/game cards, deploy confirmations, or other mini-interactions can be added behind the custom callback router without growing `gateway.ts`.

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
- Leaves `src/custom/slash-prequeue-gateway-adapter.ts` to run prequeue command orchestration and `src/custom/slash-effects-gateway-adapter.ts` to apply typed effects.

### `src/custom/slash-prequeue-gateway-adapter.ts`

Gateway-side prequeue slash command orchestrator.

Current implementation status:

- Normalizes group slash content after removing bot mentions, preserving `/command` use when a user sends `@bot /command`.
- Runs urgent queue bypass before any custom or official slash matching so `/stop`, `/approve`, `/new`, and `/compact` remain usable during blocked peer queues.
- Runs custom runtime slash commands before official plugin slash commands and applies their typed effects through `src/custom/slash-effects-gateway-adapter.ts`.
- Falls through to official plugin slash command matching, preserving the three existing outcomes: enqueue unknown slash messages, delegate selected commands to the AI by replacing `message.content`, or reply directly.
- Resolves slash reply targets and file media targets inside the adapter while keeping token lookup and QQ send APIs behind injected callbacks.

Important boundary:

- This adapter does not own QQ credentials, access tokens, or media upload implementation.
- It does not mutate persistent state directly; persistence still flows through injected effect callbacks.
- It centralizes slash prequeue ordering so gateway queue recovery paths and custom auth command paths do not drift apart.

### `src/custom/slash-effects-gateway-adapter.ts`

Gateway-side effect applier for handled custom slash commands.

Current implementation status:

- Applies custom slash logs with consistent account-prefixed gateway logging.
- Persists auth/task/poll/game/deploy-confirmation state through injected state callbacks.
- Persists scene/config changes through an injected config API, while reusing the existing scene upsert helper and latest loaded config snapshot.
- Delegates reply delivery to `src/custom/slash-reply-delivery-gateway-adapter.ts` so reply-send failures are logged without preventing task notification delivery.
- Sends task notification deliveries through injected text callbacks and records sent/skipped/failed delivery logs.

### `src/custom/slash-reply-delivery-gateway-adapter.ts`

Gateway-side delivery helper for custom slash replies.

Current implementation status:

- Sends simple text replies through an injected text callback.
- Sends keyboard replies through an injected keyboard callback and falls back to text on card-send failure.
- Sends auth approval cards when `approvalText` + keyboard are available, falls back to denial text if the card send fails, and preserves management-group notification forwarding.
- Keeps actual QQ token lookup, target resolution, and API calls in `gateway.ts`.

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
- Leaves `src/custom/interaction-effects-gateway-adapter.ts` to apply typed custom effects, while `gateway.ts` remains responsible for the platform ACK, QQ send callbacks, and legacy official approval buttons.

### `src/custom/interaction-effects-gateway-adapter.ts`

Gateway-side effect applier for handled custom callback-card interactions.

Current implementation status:

- Applies custom interaction logs with account-prefixed gateway logging.
- Persists auth/poll/game/deploy-confirmation state through injected callbacks.
- Sends follow-up replies through an injected reply callback using the normalized group/C2C/channel reply target.
- Logs reply-send failures without affecting callback state persistence.

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
- Config query/update interaction ACK payload construction lives in `src/custom/config-interaction-gateway-adapter.ts`.
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

### `src/custom/group-ingress-gateway-adapter.ts`

Gateway-side application layer for group ingress side effects immediately after the group gate decision.

Current implementation status:

- Applies skipped-message ingress for `drop_other_mention` and `skip_no_mention`.
- Tries custom unread first and falls back to legacy `groupHistories` recording when custom unread is disabled for the peer.
- Applies custom unread scheduler effects through an injected callback and persists unread state only when the runtime reports a change.
- Logs the same operational messages as the previous inline gateway path for custom unread, legacy history, and mention catch-up decisions.
- Applies mention ingress before ordinary dispatch and returns the unread config, pending history, and catch-up-after-reply flag that downstream prompt/completion logic consumes.

Important boundary:

- This adapter does not decide group allow-list, activation mode, mention detection, command authorization, or prompt formatting.
- It does not own timers or persistence; the gateway still injects scheduler and persistence callbacks.
- It keeps custom unread and legacy history fallback behavior together so future gate changes do not need to duplicate side-effect branches in `gateway.ts`.

### `src/custom/unread-context.ts`

Gateway-side history context adapter for custom unread and legacy group history.

Current implementation status:

- Chooses which history source should be injected before the current group message:
  - synthetic catch-up snapshot history
  - mention-time custom unread history
  - legacy group history map
- Gives synthetic snapshot history priority over mention-time history, and mention-time history priority over legacy history.
- Builds the pending-history context body through a gateway-provided envelope formatter callback.
- Applies the selected history context to the initial `agentBody` for group messages, and returns direct/C2C messages unchanged without invoking the envelope formatter.
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

### `src/custom/unread-completion-gateway-adapter.ts`

Gateway-side effect applier for post-dispatch unread completion.

Current implementation status:

- Calls `completeCustomUnreadAfterDispatch()` for group messages and applies its logs, persist request, and scheduler effects through injected gateway callbacks.
- Falls back to `clearLegacyGroupHistoryAfterDispatch()` only when the custom unread completion path does not handle the dispatch.
- Resolves the legacy history limit through an injected callback, keeping account/config lookups in `gateway.ts`.
- Returns typed `custom-handled`, `legacy-cleared`, or `non-group` results for deterministic tests.

Important boundary:

- This adapter still does not send QQ messages or own timers; it only invokes scheduler/persist callbacks supplied by gateway.
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
- `src/custom/task-execution-effects-gateway-adapter.ts` applies executor completion/failure effects at the gateway boundary:
  - logs executor/workspace/status/notify effects with account-prefixed messages
  - resolves notification effects back to current task records
  - persists async task state before delivering completion/failure notifications
  - sends notification deliveries through injected gateway text callbacks
  - allows unanchored async C2C/group deliveries only when the gateway opts in with the same proactive acceptance/budget guard used by autonomous sends
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
- Builds `urgent-queue-bypass` diagnostic events from injected queue snapshots.
- Keeps the command list, peer mapping, and event construction testable outside `gateway.ts`; `src/custom/urgent-queue-bypass-gateway-adapter.ts` owns gateway queue callbacks.

Boundary:

- It is pure TypeScript and has no gateway, QQ API, queue, filesystem, or OpenClaw SDK dependency.
- `gateway.ts` still owns mention stripping and final routing; queue snapshot/clearing/immediate execution are injected through the gateway adapter.

### `src/custom/urgent-queue-bypass-gateway-adapter.ts`

Gateway-side urgent queue bypass executor:

- Checks normalized slash content with `src/custom/urgent-commands.ts`.
- Reads the peer id and before/after queue snapshots through injected queue callbacks.
- Clears queued work for the same peer, executes the urgent message immediately, and records a structured `urgent-queue-bypass` event through an injected fallback recorder.
- Keeps `/new` and `/compact` recovery behavior isolated from normal custom slash routing so context-too-long/timeout incidents cannot block recovery commands behind the same peer queue.

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

### `src/custom/fallback-dispatch-state.ts`

Pure per-dispatch fallback state tracker.

Current implementation status:

- Tracks whether any response arrived, whether a block response arrived, whether that block was real model output, and whether the dispatch has timed out.
- Collects tool deliver text/media counts and mutable media URLs for fallback forwarding without spreading counters across `gateway.ts`.
- Owns block-media dedupe state for tool media that arrives after a block reply.
- Tracks tool-only fallback renewal count and one-shot fallback-sent state; gateway still stores the timer handle, while `tool-deliver-gateway-adapter.ts` now owns renewal/scheduling decisions.
- Does not log, send, persist, or know QQ/OpenClaw APIs; it only exposes a snapshot used by the fallback recorder.

### `src/custom/fallback-record-context.ts`

Pure builder for fallback record inputs.

Current implementation status:

- Combines a `QueuedMessage`, queue snapshot, dispatch-state snapshot, session key, timeout/reason metadata, and caller details into the `CustomFallbackRecordInput` shape.
- Reuses `gateway-message-routing.ts` and `queued-message-context.ts` for peer/actor mapping so fallback diagnostics stay aligned with scene/auth routing.
- Keeps fallback event assembly out of the main gateway dispatch loop; `gateway.ts` now supplies snapshots and sends the resulting record through `fallback-record-gateway-adapter`.

### `src/custom/fallback-record-gateway-adapter.ts`

Gateway-side fallback recorder and alert trigger.

Current implementation status:

- Builds or accepts `CustomFallbackEvent` records, logs the sanitized JSON event, and persists through `custom-fallback-event-store`.
- Exposes `createCustomDispatchFallbackRecorder()` so `gateway.ts` only binds account/message/session callbacks once per dispatch and no longer assembles fallback record payloads inline.
- Loads recent fallback events only after a successful append, then applies `buildCustomFallbackAlertDecision()` with current runtime config.
- Returns typed persisted/alert status and dispatches an optional alert delivery callback without importing QQ send APIs.
- Keeps snapshot producers, visible user notices, and final QQ delivery in `gateway.ts`; the adapter owns dispatch record assembly, persistence, and alert-trigger glue.
- Urgent queue bypass and dispatch fallback paths now share this recorder instead of each importing fallback store helpers in `gateway.ts`.

### `src/custom/tool-deliver-gateway-adapter.ts`

Gateway-side observer for tool deliver callbacks.

Current implementation status:

- Records each tool deliver into `CustomFallbackDispatchState` and logs text/media counters.
- Immediately forwards post-block tool media through an injected guarded media sender, including block-media dedupe and send-error logging.
- Owns tool-only timer renewal-limit decisions and timeout scheduling while `gateway.ts` only stores/clears the current timer handle.
- On timeout, records `tool-only-timeout`, marks the fallback as sent, and invokes the injected `sendToolFallback()` callback without importing QQ send APIs.
- On dispatch completion with tool delivers but no block, records `tool-only-complete-no-block` and triggers the same injected fallback sender.

### `src/custom/tool-fallback-gateway-adapter.ts`

Gateway-side sender for tool-only fallback content.

Current implementation status:

- Chooses the fallback delivery path in the same order as the previous inline gateway code: collected tool media first, then collected tool text, then a visible no-output notice.
- Records the concrete `tool-fallback-media`, `tool-fallback-text`, or `tool-fallback-no-output` event through the injected dispatch fallback recorder.
- Wraps each media send with the configured media timeout and logs send errors without failing the whole fallback path.
- Keeps actual QQ sends behind injected callbacks, so the adapter does not import token retry, reply-dispatcher, or QQ API functions.

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
- `gateway.ts` loads recent persisted fallback events and passes alert delivery intents to `admin-group-notification-service-gateway-adapter`, which applies cooldown and commits the proactive budget only after successful QQ delivery.
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
