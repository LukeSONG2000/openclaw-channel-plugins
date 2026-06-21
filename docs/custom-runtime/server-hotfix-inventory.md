# Server Hotfix Inventory

Evidence date: 2026-06-21.

Server deployment:

- Host alias: `laptop-home`
- Runtime process: `/home/PPfavorite/.nvm/versions/node/v24.14.0/bin/node /home/PPfavorite/.nvm/versions/node/v24.14.0/lib/node_modules/openclaw/dist/index.js gateway --port 18789`
- Package path: `/home/PPfavorite/.openclaw/extensions/node_modules/@tencent-connect/openclaw-qqbot`
- Server package version: `@tencent-connect/openclaw-qqbot@1.7.2`
- Official baseline: `@tencent-connect/openclaw-qqbot@1.7.2`, commit `7ceb7f0913d15417c5a74d82442a672ef0382c64`

The deployed package has local edits despite matching the official published version.

## Changed Files

Changed relative to official source:

- `src/api.ts`
- `src/gateway.ts`
- `src/message-queue.ts`
- `src/outbound-deliver.ts`
- `src/reply-dispatcher.ts`
- `src/utils/chunked-upload.ts`

The server package also contains several `.codex-backup-*` files from prior hotfixes. These should not be copied into the fork.

## Keep

Keep as productized runtime behavior:

- Token fetch fallback in `api.ts`: retries with `node:https` when global `fetch` fails and logs network causes. Ported in commit after architecture baseline.
- Queue emergency commands: `/stop`, `/approve`, `/new`, `/compact` should bypass normal queue blocking. Ported in commit after architecture baseline.
- Timeout protection: visible timeout notice, ignore late deliveries after timeout, and continue queue processing. Ported in commit after architecture baseline.
- Tool-only fallback: if tools produce no user-visible block response, release queue with a visible notice. Ported in commit after architecture baseline.
- Error send retry without `msg_id`: if reply anchoring fails because `msg_id` is invalid/expired/unauthorized, retry unanchored. Ported in commit after architecture baseline.
- Non-mergeable synthetic messages: internal digest/catch-up messages must not be merged with user messages.
- Presigned upload PUT without explicit `Content-Length`: keep if it avoids COS upload failures in this environment. Ported in commit after architecture baseline.

## Extract

Move out of the official connector path into a custom runtime module:

- Group unread catch-up timers.
- One-minute follow-up window after bot output.
- Ten-minute sleep catch-up.
- Manual unread catch-up trigger file.
- Group session auto-reset based on oversized session/trajectory files.
- Synthetic digest message creation and lifecycle.

These are the real custom message-flow behaviors and should live behind a small runtime interface rather than being woven through `gateway.ts`.

## Remove From Core

Remove or quarantine from the QQBot core connector:

- Async image prompt interception in `gateway.ts`.
- Hardcoded `/home/PPfavorite/.openclaw/workspace/skills/codex-image-gen` path.
- Hardcoded proxy `http://127.0.0.1:7897`.
- Direct child process spawning for image generation.

Recommendation: expose image generation as a skill/tool that the agent can call, with its own queue, timeout, proxy handling, and result delivery.

Current fork status:

- The custom fork keeps normal QQ image/media receive and send code in core.
- The custom fork does not hardcode `codex-image-gen`, `/home/PPfavorite/.openclaw/workspace/skills/codex-image-gen`, `127.0.0.1:7897`, or direct child-process image generation in `src/gateway.ts`.
- `tests/no-core-image-generation-coupling.test.ts` scans QQBot connector core files so prompt-interception style image generation does not silently re-enter future updates.

## Current Server Config Findings

Server `openclaw.json` has:

- `channels.qqbot.enabled: true`
- `channels.qqbot.appId: 1903501811`
- `channels.qqbot.defaultRequireMention: true`
- `channels.qqbot.allowFrom: ["*"]`
- wildcard group config with `requireMention: true`, `ignoreOtherMentions: false`, `historyLimit: 80`
- group `5C1152CA05D191171B05E6997791C3F5` named `friends-main`, with `historyLimit: 60`
- `plugins.allow` includes `openclaw-qqbot`, `openclaw-lark`, `ddingtalk`, and others.

Known local state from the 2026-06-21 08:18 CST read-only check:

- `~/.openclaw/qqbot/data/known-users.json`
- `~/.openclaw/qqbot/data/ref-index.jsonl`
- `~/.openclaw/qqbot/sessions/session-default.json`
- `~/.openclaw/qqbot/sessions/session-bot2.json`
- `known-users.json`: 32 entries total, 7 C2C and 25 group-member records. Records are openid-based; raw QQ numbers are not present.
- `ref-index.jsonl`: 2379 records using `{ k, t, v }`; 163 records contain attachments, with 166 attachment entries.
- Observed ref-index attachment categories: `image/jpeg`, `image/png`, `image/gif`, generic `image`, `file`, and `voice`.
- Observed attachment metadata keys: `type`, `filename`, `contentType`, `localPath`, `transcript`, and `transcriptSource`.
- Two observed voice attachments include transcript metadata.
- `journalctl --user -u openclaw-gateway` reported no journal files during this check; use QQBot persisted data plus systemd status as the durable evidence source unless journald persistence is enabled later.

The configured test group in the user request is QQ group number `945739251` / `Master Luke的图书馆`; the official event payload exposes `group_openid`, not the raw QQ group number. The current config only showed group openid `5C1152CA05D191171B05E6997791C3F5`, so the mapping should be verified by sending a test message and reading logs/state before hardcoding policy.

The configured test DM in the user request is QQ `1137586795` / `Luke今天喝什么`; the official event payload exposes `user_openid`, not raw QQ number. The current `known-users.json` contains multiple C2C openids, so mapping must be verified through a fresh test message.

## Stability Evidence

Stability logs contain repeated gateway startup failures on 2026-06-18 caused by invalid config:

```text
channels.qqbot.groups.5C1152CA05D191171B05E6997791C3F5: invalid config: must not have additional properties: "sessionMaxBytes"
```

This confirms runtime-specific config must be schema-aware. Do not add arbitrary custom keys under official `channels.qqbot.groups.*` unless the plugin schema/types accept them. Custom runtime config should be placed under an explicit namespace.
