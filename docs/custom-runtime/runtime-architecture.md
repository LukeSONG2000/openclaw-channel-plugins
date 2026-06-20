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
          "qqbot:group:5C1152CA05D191171B05E6997791C3F5": {
            "scene": "chat",
            "label": "Master Luke's library"
          }
        }
      }
    }
  }
}
```

### `src/custom/auth.ts`

Authorization is evaluated before tool dispatch and before config mutation.

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

### `src/custom/unread-runtime.ts`

Owns non-mentioned group history and autonomous speaking.

State:

- pending messages by `group_openid`
- recent bot output anchors
- follow-up timers
- proactive budget state
- consumed synthetic history snapshots

Rules:

- Record allowed non-mentioned group messages without blocking the main queue.
- When mentioned, inject pending history into context but do not automatically consume it unless policy says so.
- A short follow-up window may run after bot output.
- Group passive replies must stay inside official 5-minute window.
- Delayed ten-minute speaking must use scarce proactive group send and should be guarded by scene/policy.
- Synthetic digest messages must be non-mergeable.

### `src/custom/task-sandbox.ts`

Long task isolation.

Responsibilities:

- create workspace per task
- start subagent/job
- maintain status store
- allow authorized members to query/cancel/add requirements
- push final result back to originating peer

Suggested task ids:

```text
qqbot-{scene}-{groupOrUserOpenid}-{shortTime}-{nonce}
```

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
