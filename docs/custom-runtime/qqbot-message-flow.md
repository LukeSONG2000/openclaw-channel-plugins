# QQBot Message Flow

Evidence date: 2026-06-21.

Primary sources:

- Official event docs: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/event.html
- Official send docs: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html
- Official rich-media docs: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/rich-media.html
- Official button docs: https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html
- Local source: `src/types.ts`, `src/gateway.ts`, `src/api.ts`, `src/outbound-deliver.ts`, `src/custom/*`
- Server evidence: `laptop-home:/home/PPfavorite/.openclaw/qqbot/data`, `laptop-home:/home/PPfavorite/.openclaw/openclaw.json`, `openclaw-gateway.service` status

## Current Server Evidence

Read-only check on `laptop-home` on 2026-06-21:

- Gateway service is running: `openclaw-gateway.service`, active since 2026-06-19 13:05 CST.
- Current deployed QQBot startup marker reports plugin version `1.7.2` for default account app id `1903501811`.
- Current configured main group entry uses group openid `5C1152CA05D191171B05E6997791C3F5` and config label `friends-main`.
- User-provided human alias for that test group is QQ `945739251` / `Master Luke的图书馆`; the runtime routing key must use the group openid, not the raw QQ group number.
- `known-users.json` records 32 observed users: 7 C2C entries and 25 group-member entries, all by openid.
- It includes group nicknames for observed group members, but C2C entries do not reliably include human-readable nicknames.
- `known-users.json` shows that the server sees group members by `member_openid`, optional nickname, and `groupOpenid`; raw QQ numbers are not present in these local records.
- `ref-index.jsonl` uses a `{ k, t, v }` wrapper where `k` is the ref index, `t` is timestamp, and `v` stores cached sender/content/attachment metadata.
- Current `ref-index.jsonl` has 2384 records; 164 records carry attachments and 167 attachment entries were observed.
- `ref-index.jsonl` value keys are `content`, `senderId`, `timestamp`, optional `senderName`, optional `isBot`, and optional `attachments`; it is not a reliable source for group openid mapping.
- Observed attachment categories include `image/jpeg`, `image/png`, `image/gif`, `image`, `file`, and `voice`.
- Observed attachment keys include `type`, `filename`, `contentType`, `localPath`, `transcript`, and `transcriptSource`; all sampled attachments are local cached files, not raw remote URLs.
- Two observed voice attachment entries include ASR transcript metadata.
- A 2026-06-21 read-only refresh confirmed `openclaw-gateway.service` is active, no raw numeric QQ ids are stored in `known-users.json`, and the attachment distribution remains consistent: voice 2, JPEG 81, generic image 28, file 4, PNG 22, GIF 30.
- `journalctl --user -u openclaw-gateway` currently reports no journal files, so the durable evidence source on this host is the QQBot data directory plus service status, not full historical event logs.

Privacy note: server evidence in this document records identifiers and capability facts only. Message text from private chats/groups should not be copied into docs unless needed for a narrow debugging case.

## Receive Events

The connector subscribes to and handles these events in `src/gateway.ts`:

- `C2C_MESSAGE_CREATE`
- `GROUP_AT_MESSAGE_CREATE`
- `GROUP_MESSAGE_CREATE`
- `AT_MESSAGE_CREATE`
- `DIRECT_MESSAGE_CREATE`
- `INTERACTION_CREATE`
- group management / proactive status events such as `GROUP_ADD_ROBOT`, `GROUP_DEL_ROBOT`, `GROUP_MSG_REJECT`, `GROUP_MSG_RECEIVE`

The gateway uses full intents:

- `PUBLIC_GUILD_MESSAGES`
- `DIRECT_MESSAGE`
- `GROUP_AND_C2C`
- `INTERACTION`

Official event docs note that duplicate delivery of the same `msg_id` can happen in extreme cases, and passive reply code should use `msg_seq`/dedupe to avoid duplicate replies. Local `api.ts` generates `msg_seq` for C2C/group sends.

Official event docs also state message order is not guaranteed to be strictly ordered; if strict ordering matters, the application should buffer and sort by event/message sequence. Local code currently processes gateway events as they arrive.

## Development Capability Matrix

Use this table as the first decision point when adding custom runtime behavior.

| Scene | Receive event | Stable peer key | Stable actor key | Display fields | Current receive status | Current send status |
| --- | --- | --- | --- | --- | --- | --- |
| QQ C2C | `C2C_MESSAGE_CREATE` | `qqbot:c2c:{author.user_openid}` | `author.user_openid` | no reliable nickname in current server state | Text, quote metadata, images/GIF/files/voice observed through local processing | Text/Markdown, inline keyboard, image/voice/video/file, streaming text, passive and proactive wrappers |
| QQ group | `GROUP_AT_MESSAGE_CREATE`, `GROUP_MESSAGE_CREATE` | `qqbot:group:{group_openid}` | `author.member_openid` | `author.username`, mention usernames when provided | Text, mentions, quote metadata, images/GIF/files/voice observed; raw QQ group/member numbers not exposed | Text/Markdown, inline keyboard, image/voice/video/file, passive and proactive wrappers |
| Guild channel | `AT_MESSAGE_CREATE` | `qqbot:channel:{channel_id}` | `author.id` | `author.username`, `member.nick` when provided | Basic text/attachments normalized | Text send through `/channels/{channel_id}/messages`; custom cards/media are not the focus of current runtime |
| Channel DM | `DIRECT_MESSAGE_CREATE` | `qqbot:dm:{guild_id}` or current queue `dm:{author.id}` needs audit | `author.id` | `author.username` when provided | Basic text/attachments normalized | `sendDmMessage` exists, but several current paths treat `dm` like C2C fallback; audit before adding scene behavior |
| Interaction | `INTERACTION_CREATE` | scene-specific openid fields | `group_member_openid`, `user_openid`, or resolved `user_id` | button metadata only | C2C/group auth and poll callbacks handled | Must ACK with `PUT /interactions/{id}`; follow-up replies use C2C/group send wrappers where available |

Implementation rules:

- Route and authorize by openid fields only. Raw QQ numbers such as `945739251` and `1137586795` are human aliases, not event identifiers in this connector.
- Store human labels separately from policy keys. Labels can change or be absent; openids are the durable keys for scenes, auth, proactive budgets, unread state, task sandboxes, and polls.
- Treat `ref-index.jsonl` as quote/context cache, not as the source of peer mapping. Use `known-users.json`, config, and fresh inbound events for openid mapping.
- Prefer C2C/group custom features first. They have the best local wrapper coverage for messages, media, inline keyboards, proactive acceptance, and current tests.
- Treat channel DM and recall/delete state as unverified until there is direct server evidence and a gateway event mapping.

## C2C Fields

Official docs and local type `C2CMessageEvent` expose:

- `id`: platform message id, used as `msg_id` for passive replies.
- `content`: text content.
- `timestamp`: RFC3339 timestamp.
- `author.user_openid`: user openid used for C2C routing and authorization.
- `author.union_openid`: optional union id where provided.
- `attachments`: images, voice, video, files.
- `message_scene.ext`: may include `ref_msg_idx` and `msg_idx`.
- `message_type`: known local constants include `0` for text and `103` for quote/reference.
- `msg_elements`: quote/reference payloads; when `message_type=103`, `msg_elements[0]` may contain referenced content and attachments.

Current local behavior:

- Routed to queue as `type="c2c"`, peer key `dm:{user_openid}` internally and custom peer `qqbot:c2c:{user_openid}` for custom runtime policy.
- Persisted known-user evidence stores C2C by `openid`; no raw QQ number is persisted.
- C2C supports input typing notification through `sendC2CInputNotify`.
- C2C supports streaming text only when `accountConfig.streaming=true` and `shouldUseStreaming()` allows it.
- Raw QQ number is not exposed; use `user_openid` for authorization and routing.

## Group Fields

Official docs and local type `GroupMessageEvent` expose:

- `id`: platform message id, used as `msg_id` for passive replies.
- `content`: text content.
- `timestamp`: RFC3339 timestamp.
- `group_openid`: stable routing/send target for the group.
- `group_id`: present in local type but not safe to rely on as raw QQ group number.
- `author.member_openid`: member openid within that group.
- `author.username`: observed display name / nickname-like string.
- `author.bot`: whether sender is a bot.
- `mentions`: mention list; may include `is_you` for bot mention detection.
- `attachments`: images, voice, video, files.
- `message_scene.ext`: may include `ref_msg_idx` and `msg_idx`.
- `message_type` and `msg_elements`: quote/reference handling.

Current local behavior:

- `GROUP_AT_MESSAGE_CREATE` and `GROUP_MESSAGE_CREATE` are both normalized to queue `type="group"`.
- Group peer id is `group:{group_openid}` in the queue and `qqbot:group:{group_openid}` in custom runtime config.
- Persisted known-user evidence stores group members as `member_openid` plus optional nickname and `groupOpenid`.
- Group policy is controlled by `groupPolicy`, `groupAllowFrom`, `groups.{groupOpenid}.requireMention`, `ignoreOtherMentions`, and group/custom unread history.
- Non-mentioned group messages can be recorded as unread context instead of triggering immediate AI dispatch.
- Mentioned or implicitly mentioned group messages can inject pending unread context into the current model prompt.
- Raw QQ group number and raw QQ member number are not reliable event fields. Use `group_openid` and `member_openid` for policy, and maintain a separate human alias table for names such as `945739251` / `Master Luke的图书馆`.

## Guild And Channel Fields

Local type `GuildMessageEvent` is used for both `AT_MESSAGE_CREATE` and `DIRECT_MESSAGE_CREATE`:

- `id`: platform message id.
- `channel_id`: sub-channel id for guild messages.
- `guild_id`: guild id or DM guild id.
- `content`, `timestamp`.
- `author.id`, `author.username`, `author.bot`.
- `member.nick`, where provided.
- `attachments`.

Current local behavior:

- `AT_MESSAGE_CREATE` becomes queue `type="guild"` and sends through `sendChannelMessage`.
- `DIRECT_MESSAGE_CREATE` becomes queue `type="dm"`; local code currently replies through C2C-style send fallback when `msg.type === "dm"` in several paths, while `sendDmMessage` exists for `/dms/{guild_id}/messages`. This should be audited before adding custom DM-specific behavior.
- Channel proactive sending is not implemented in `src/proactive.ts`; only C2C/group proactive sends are supported there.

## Attachment And Message Types

Official attachment fields represented locally by `MessageAttachment`:

- `content_type`
- `filename`
- `height`, `width`, `size`
- `url`
- `voice_wav_url`
- `asr_refer_text`

Observed server-side stored attachment categories:

- Static images: `image/jpeg`, `image/png`.
- GIF / animated image payloads: often stored as `image/gif`, sometimes with image file extensions after download.
- Generic image entries: `type="image"` can appear without a `contentType`, especially for bot-side cached/local images in ref-index.
- Files: observed as `type="file"` in ref-index.
- Voice: stored locally with `contentType="voice"`; voice messages may have ASR text from QQ or plugin fallback text if STT is not configured.
- Multiple images in one message are preserved as multiple attachments in ref-index entries.

Local processing:

- `processAttachments` downloads or summarizes attachments.
- Voice can use `voice_wav_url` or `asr_refer_text` when available.
- Attachments are summarized into group history and ref-index entries.
- Outbound media supports image, voice, video, and file upload for C2C/group.

Known local message type constants:

- `MSG_TYPE_TEXT = 0`
- `MSG_TYPE_QUOTE = 103`

Open item: the current plugin does not explicitly model message recall/delete events as first-class inbound events. If recall state matters, add event capture from official docs and server samples before relying on it.

Official recall/delete docs currently describe channel and channel-DM recall APIs/events. Local C2C/group custom runtime should not assume recall state until QQ group/C2C recall events are observed or explicitly added to the gateway event map.

## Send Capabilities

Official send docs describe four send scenes:

- QQ C2C: `POST /v2/users/{openid}/messages`
- QQ group: `POST /v2/groups/{group_openid}/messages`
- text sub-channel: `POST /channels/{channel_id}/messages`
- channel DM: `POST /dms/{guild_id}/messages`

Message types in C2C/group:

- `0`: text
- `2`: markdown
- `3`: ark
- `4`: embed
- `7`: media

Local API wrappers currently provide:

- `sendC2CMessage`
- `sendGroupMessage`
- `sendChannelMessage`
- `sendDmMessage`
- `sendC2CMessageWithInlineKeyboard`
- `sendGroupMessageWithInlineKeyboard`
- `sendProactiveC2CMessage`
- `sendProactiveGroupMessage`
- `sendC2CImageMessage`
- `sendGroupImageMessage`
- `sendC2CVoiceMessage`
- `sendGroupVoiceMessage`
- `sendC2CVideoMessage`
- `sendGroupVideoMessage`
- `sendC2CFileMessage`
- `sendGroupFileMessage`
- `sendC2CStreamMessage`

The connector switches text sends to Markdown when `markdownSupport` is true. Inline keyboard sending is currently wrapped for C2C and group messages, and custom auth cards use those paths.

Current send matrix:

| Capability | C2C | Group | Guild channel | Channel DM | Notes |
| --- | --- | --- | --- | --- | --- |
| Plain text | `sendC2CMessage` | `sendGroupMessage` | `sendChannelMessage` | `sendDmMessage` | C2C/group include `msg_seq`; passive sends include `msg_id` when available; local reply dispatcher requires the proactive guard hook before unanchored C2C/group text sends |
| Markdown text | `sendC2CMessage` when `markdownSupport=true` | `sendGroupMessage` when `markdownSupport=true` | not via current wrapper | not via current wrapper | Local C2C/group body uses `msg_type=2` and `markdown.content` |
| Inline keyboard/cards | `sendC2CMessageWithInlineKeyboard` | `sendGroupMessageWithInlineKeyboard` | not wired for custom runtime | not wired for custom runtime | Auth approvals and polls use this path; text fallback commands remain required |
| Image | `sendC2CImageMessage` | `sendGroupImageMessage` | skipped or text fallback in current outbound code | not audited | Uses rich media upload, then `msg_type=7` media send |
| Voice | `sendC2CVoiceMessage` | `sendGroupVoiceMessage` | text fallback in current reply dispatcher | not audited | Conversion/fallback is handled outside `api.ts` |
| Video | `sendC2CVideoMessage` | `sendGroupVideoMessage` | not the current focus | not audited | Uses media upload |
| File | `sendC2CFileMessage` | `sendGroupFileMessage` | not the current focus | not audited | Chunked upload helpers exist for larger C2C/group files |
| Typing indicator | `sendC2CInputNotify` | no local wrapper | no local wrapper | no local wrapper | C2C only in current code |
| Proactive text | `sendProactiveC2CMessage` | `sendProactiveGroupMessage` | no local proactive helper | no local proactive helper | Custom gateway paths must pass proactive budget/acceptance policy; legacy `outbound.ts`/`proactive.ts` APIs expose optional guard hooks for callers |
| Streaming text | `sendC2CStreamMessage` | no local stream wrapper | no local stream wrapper | no local stream wrapper | Current streaming support is C2C-only |

Current local gap:

- `DIRECT_MESSAGE_CREATE` is normalized as `type="dm"`, but several send paths reply through C2C-style `sendC2CMessage` rather than the existing `sendDmMessage` wrapper. Treat channel-DM behavior as unaudited before adding new custom scene logic there.
- C2C/group text sends support inline keyboards; channel/DM custom card paths currently fall back to text in custom poll/auth code.

## Official Limits That Affect Custom Runtime

From official send docs:

- Sandbox environments are documented as not subject to message frequency controls, but the current production OpenClaw instance should not assume it is a sandbox.
- C2C passive replies: valid for 60 minutes, max 5 replies per incoming message.
- Group passive replies: valid for 5 minutes, max 5 replies per incoming message.
- C2C proactive messages: 4 messages per user per month.
- Group proactive messages: 4 messages per group per month.
- Users/groups can disable receiving proactive messages; `GROUP_MSG_REJECT` / `GROUP_MSG_RECEIVE` events indicate group proactive-message acceptance state changes.
- C2C wakeup/recall messages are available after user interaction, one per period across same day, 1-3 days, 3-7 days, and 7-30 days.
- Official docs state proactive push capability was adjusted from 2025-04-21 and API calls may receive errors.
- Text sub-channel passive replies are valid for 5 minutes; sends in one sub-channel are limited to max 5 messages/second.
- Official rich-media docs say direct rich-media sends with `srv_send_msg=true` consume proactive message frequency. The recommended path is `srv_send_msg=false`, then use returned `file_info` in the message send API.

Implication for custom runtime:

- Group delayed autonomous replies must be either near-term passive replies inside the 5-minute window or scarce proactive sends.
- Ten-minute sleep catch-up cannot rely on passive group `msg_id`.
- Because official docs say proactive push is no longer provided after 2025-04-21, unanchored C2C/group sends must be treated as best-effort and high risk even if older monthly frequency limits are still listed.
- Delayed group speaking needs scene policy, budget tracking, and visible logging before it is safe to enable broadly.
- Follow-up after direct mention should stay inside the group passive-reply window when using passive replies.
- Synthetic catch-up messages should not pretend to be passive replies if they have no valid QQ `msg_id` anchor.
- Long-task completion notifications without a current `msg_id` anchor should pass through the same proactive policy/acceptance/budget layer before any actual send attempt.

## Interaction And Buttons

Local types support `InlineKeyboard` and `INTERACTION_CREATE`:

- Button action types include link, callback, command, and mqqapi.
- Callback buttons produce `INTERACTION_CREATE` with `resolved.button_data`.
- The handler must acknowledge interactions through `PUT /interactions/{id}`.
- Official button docs state that, as of 2026-04-23, C2C/group custom button capability is open without separate template approval; channel buttons still require invite/opening.
- Local code already uses inline keyboard buttons for official OpenClaw exec/plugin approvals and custom auth approvals.
- Callback button events must be acknowledged with `PUT /interactions/{id}`; otherwise the QQ client may keep the button in a loading state until timeout.

Current custom auth cards:

- Button data prefix: `custom-auth:<requestId>:...`.
- Supported decisions: allow once, allow 3 times, deny.
- Text fallback: `/bot-auth approve <requestId> once|count N|timed 10m` or `/bot-auth deny <requestId>`.

Current custom poll cards:

- `/bot-poll create 问题 | 选项A | 选项B [| 选项C | 选项D]` creates a lightweight poll in the per-account custom runtime.
- C2C/group creation replies use inline keyboard buttons when available; channel/DM paths fall back to text.
- Button data prefix: `custom-poll:<pollId>:vote:<1-4>`.
- Button callbacks are acknowledged before local state mutation, then the bot sends a short vote confirmation.
- One actor has one vote per poll; clicking a different option updates the vote.
- Poll state persists under `~/.openclaw/qqbot/data/custom-polls/polls-<accountId>.json`.
- Custom auth gates mutations through `game.interact`; list/status use `system.status`.

Potential future uses:

- Scene switch cards for admins.
- Task status cards: query, cancel, add requirement.
- Additional lightweight games now that callback ACK and state storage have a first poll implementation.
- Admin-only deployment/update confirmation cards.

## Current Group/DM Logic

Current official connector behavior:

- C2C messages go through the message queue and route to C2C openid.
- Group messages use `groupPolicy`, `groupAllowFrom`, `requireMention`, `ignoreOtherMentions`, and group history.
- Non-mentioned group messages are recorded to in-memory pending history if allowed, then skipped.
- Mentioned group messages inject pending history into the agent context.
- Slash commands are detected before normal dispatch.
- Urgent commands (`/stop`, `/approve`, `/new`, `/compact`) bypass blocked queues using first-token matching, so `/new args` is immediate while `/newspaper` is ordinary text.
- Urgent bypasses are persisted as custom fallback diagnostics, including dropped queued-message count and queue snapshots.

Current custom runtime behavior:

- Unread/follow-up/sleep-digest state is extracted into `src/custom/unread-runtime.ts` and wired through `src/custom/unread-gateway-adapter.ts`.
- Custom runtime defaults off unless `channels.qqbot.customRuntime.enabled=true`.
- QQBot initialization binds `customRuntime.admins` and `customRuntime.adminGroup`; onboarding status remains incomplete until both management anchors are present.
- Synthetic digest messages use `_customUnreadSnapshot`, `_customUnreadSnapshotId`, and `_noMerge`.
- Synthetic digest sends use proactive/unanchored group sends and should therefore be guarded by proactive budget/policy.
- Mention replies can trigger unread catch-up after the direct reply.
- Custom auth gates plugin-level slash commands before config mutation/deploy actions.
- Custom auth also gates ordinary OpenClaw/model dispatch before tools run: normal chat needs `chat.send`, framework slash-like commands need `codex.run`, and codex-only scenes route ordinary dispatch checks to `codex.run`.
- Custom auth supports temporary grants through text commands and C2C/group inline cards. Requests created outside `customRuntime.adminGroup` are also copied to that management group when configured, and the copy is treated as a guarded proactive group send.
- Custom poll commands provide the first lightweight interactive-card feature on top of the same C2C/group inline keyboard send paths.
- Response timeout and context-too-long fallbacks leave `/compact` and `/new` available even when the same peer has an active blocked run.
- `/bot-fallback summary` can be used after a timeout/context incident to confirm whether a recovery command hit the urgent queue-bypass path.

## Open Items

- Validate custom auth inline cards on the actual deployed bot after installing the custom package; local tests only validate payload construction and handler logic.
- Validate custom poll inline cards on the actual deployed bot after installing the custom package; local tests validate payload construction, command handling, interaction handling, and persistence only.
- Audit channel DM send path before adding scene-specific logic for `DIRECT_MESSAGE_CREATE`.
- Capture official/observed recall-delete event behavior if the custom runtime needs deletion state.
