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

Owns lifecycle and wires custom modules into the gateway.

Responsibilities:

- create per-account runtime state
- receive normalized inbound messages
- return routing decisions, synthetic jobs, or direct replies
- observe dispatch completion and errors
- expose hooks for shutdown/flush

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
        "scenes": {
          "qqbot:group:*": {
            "scene": "codex-only",
            "label": "Default group policy"
          },
          "qqbot:group:5C1152CA05D191171B05E6997791C3F5": {
            "scene": "dev-lab",
            "label": "Master Luke's library",
            "capabilities": ["chat.send", "codex.run", "codex.longTask", "deploy.check"],
            "allowAutonomousReply": true,
            "allowProactiveSend": false
          }
        }
      }
    }
  }
}
```

Built-in default capabilities:

- `codex-only`: `codex.run`, `codex.longTask`
- `chat`: `chat.send`
- `system-admin`: `system.status`, `deploy.check`, `config.read`
- `dev-lab`: `chat.send`, `codex.run`, `codex.longTask`, `system.status`, `deploy.check`, `config.read`
- `default-dm`: `chat.send`, `codex.run`, `system.status`, `deploy.check`, `config.read`

High-risk capabilities such as `config.write`, `system.restart`, `auth.grant`, `deploy.apply`, and `proactive.send` are intentionally not granted by default scene profiles. They require admin status, an explicit scene capability, or a temporary grant.

Open items:

- Scene `agentId` is parsed in config but not yet used to override OpenClaw route selection.
- Per-scene workspace/sandbox routing for `codex.longTask` is still pending.

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
- Persists QQ group proactive acceptance state from `GROUP_MSG_REJECT` / `GROUP_MSG_RECEIVE`.
- Blocks group proactive text sends while the latest local acceptance state is rejected.
- Counts only after a proactive text send succeeds, so token retry or failed sends do not consume budget.
- Persists state under `~/.openclaw/qqbot/data/custom-proactive-budget/budget-<accountId>.json`.
- Gateway injects a guard into `src/outbound-deliver.ts`; synthetic catch-up text sends without a QQ `msg_id` anchor are checked before they call proactive C2C/group APIs.

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

- Media proactive sends routed through generic `sendMediaAuto` still need the same guard.
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
- Unauthorized slash commands receive a visible denial message and create an in-memory approval request intent when bound admins exist.
- QQ inline keyboard approval cards are sent for C2C/group requests when callback buttons are available; text commands remain as fallback.
- Gateway persists grants/requests under `~/.openclaw/qqbot/data/custom-auth/auth-<accountId>.json` and restores them at startup.

Policy inputs:

- channel: `qqbot`
- peer: C2C/group/channel
- actor: `user_openid` or `member_openid`
- scene
- requested capability
- command/tool name
- temporary grants

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

### `src/custom/auth-gateway-adapter.ts`

Gateway-side translation layer for authorization runtime.

Current implementation status:

- Converts `QueuedMessage` into `CustomPeer` and `CustomActor`.
- Uses slash-command metadata from `src/slash-commands.ts` to map plugin commands to concrete capabilities.
- Calls `CustomAuthorizationRuntime.check()` before plugin command handlers execute.
- Formats visible denial text for C2C, group, channel, and DM replies.
- Handles `/bot-auth` as a gateway-level admin command so admins can approve or deny custom auth requests against the live per-account runtime.
- Builds QQ inline keyboard approval cards for new unauthorized C2C/group slash-command requests.
- Handles `custom-auth:<requestId>:allow-once|allow-count|allow-timed|deny` button callbacks through the same per-account auth runtime.
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

Text approval commands:

- `/bot-auth status`
- `/bot-auth approve <requestId> once`
- `/bot-auth approve <requestId> count 3`
- `/bot-auth approve <requestId> timed 10m`
- `/bot-auth deny <requestId>`

Still open:

- Model/tool dispatch authorization outside plugin-level slash commands.
- Richer custom auth card variants, such as selecting arbitrary grant counts or durations from the card.
- Optional encryption/redaction for the auth state file if future grants include sensitive notes.

### `src/custom/unread-runtime.ts`

Owns non-mentioned group history and autonomous speaking decisions.

Current implementation status:

- Exists as a pure state machine with no QQ API, OpenClaw SDK, timer, filesystem, or gateway queue dependency.
- Takes normalized `CustomInboundMessage` inputs and returns typed intents.
- Does not send messages directly. `src/custom/unread-gateway-adapter.ts` converts intents into gateway effects.
- Defaults to policy-gated autonomous/proactive behavior unless the scene explicitly allows it.

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

Still open:

- Durable persistence for pending unread state across gateway reconnects/restarts.

### `src/custom/task-sandbox.ts`

Long task isolation.

Current implementation status:

- Exists as a pure task metadata runtime with no QQ API, OpenClaw SDK, child process, timer, or filesystem dependency.
- Creates durable task records with id, peer, owner, title, prompt, status, workspace path, timestamps, and appended requirements.
- Defaults to at most 3 active tasks per account/peer.
- Default workspace root is `~/.openclaw/qqbot/tasks`.
- Task ids use `qqbot-{accountId}-{peerKind}-{peerIdPrefix}-{timestamp}-{seq}`.
- Supports create, list, status, add requirement, and cancel operations.
- Exports/imports `CustomTaskSandboxRuntimeState` so the gateway can restore task metadata after restart.
- Persists state under `~/.openclaw/qqbot/data/custom-tasks/tasks-<accountId>.json`.
- `src/custom/task-gateway-adapter.ts` handles `/bot-task` before the normal AI queue:
  - `/bot-task create <任务描述>`
  - `/bot-task list`
  - `/bot-task status <taskId>`
  - `/bot-task add <taskId> <追加需求>`
  - `/bot-task cancel <taskId>`
- Slash-command capability metadata gates task mutations through custom auth:
  - query/help/list/status use `system.status`
  - create/add/cancel use `codex.longTask`

Important boundary:

- This first layer does not start a real subagent/job yet.
- It intentionally only creates isolated task state and user-visible status replies, so group long-task commands do not block the main conversation queue or guess at private OpenClaw execution APIs.

Next integration:

OpenClaw integration should use available runtime APIs where possible. Avoid shelling out until the framework contract is confirmed.

### `src/custom/fallbacks.ts`

Guards for known failure modes:

- context too long
- response timeout
- tool-only no block deliver
- late deliver after timeout
- queue stuck
- slash commands blocked by a running task
- invalid/expired `msg_id`
- config schema rejection

Minimum behavior:

- visible user notice
- release queue
- keep urgent slash commands working
- log structured error with peer/session/run id
- suggest `/new` or run an automatic session reset only when authorized and safe

### `src/custom/update-check.ts`

Checks the custom fork/release, not the official plugin, for deployable updates.

Desired behavior:

- detect official upstream changes separately from custom releases
- notify admin group/DM
- show diff summary or release notes
- require explicit approval before installing
- backup current server plugin before update

Current update guardrails:

- The deployed package derives its default update source from `package.json.name`.
- Custom builds use `@lukesong/openclaw-qqbot` while keeping OpenClaw plugin id `openclaw-qqbot`.
- `channels.qqbot.upgradePkg` can override the npm package checked by `/bot-version` and `/bot-upgrade`.
- `channels.qqbot.upgradeMode` defaults to `doc`, so the instance reports available custom updates without installing them.
- Hot reload remains available only after explicit config opt-in and an admin `/bot-upgrade --latest` or `/bot-upgrade --version X`.

## Gateway Integration Points

Minimal changes in `src/gateway.ts` should be limited to:

- normalize incoming events into `CustomInboundMessage`
- call custom runtime before enqueue
- let runtime record non-trigger messages
- let runtime provide extra context for dispatch
- call runtime after dispatch completion/failure
- let runtime create synthetic messages through a typed interface

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
