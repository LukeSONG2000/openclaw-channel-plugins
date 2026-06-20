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
- `known-users.json` records C2C and group users by openid only. It includes group nicknames for observed group members, but C2C entries do not reliably include human-readable nicknames.
- `known-users.json` and `ref-index.jsonl` show that the server sees group members by `member_openid`, optional nickname, and `groupOpenid`; raw QQ numbers are not present in these local records.
- `ref-index.jsonl` shows observed attachment content types including `image/jpeg`, `image/png`, `image/gif`, and voice messages stored as `contentType="voice"` with local media files and fallback transcript text when STT is not configured.
- The current service status output did not expose recent QQ event logs through `journalctl --user`, but persisted QQBot data files were present under `~/.openclaw/qqbot/data`.

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

## Official Limits That Affect Custom Runtime

From official send docs:

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
- Delayed group speaking needs scene policy, budget tracking, and visible logging before it is safe to enable broadly.
- Follow-up after direct mention should stay inside the group passive-reply window when using passive replies.
- Synthetic catch-up messages should not pretend to be passive replies if they have no valid QQ `msg_id` anchor.

## Interaction And Buttons

Local types support `InlineKeyboard` and `INTERACTION_CREATE`:

- Button action types include link, callback, command, and mqqapi.
- Callback buttons produce `INTERACTION_CREATE` with `resolved.button_data`.
- The handler must acknowledge interactions through `PUT /interactions/{id}`.
- Official button docs state that, as of 2026-04-23, C2C/group custom button capability is open without separate template approval; channel buttons still require invite/opening.
- Local code already uses inline keyboard buttons for official OpenClaw exec/plugin approvals and custom auth approvals.

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
- Urgent commands bypass blocked queues.

Current custom runtime behavior:

- Unread/follow-up/sleep-digest state is extracted into `src/custom/unread-runtime.ts` and wired through `src/custom/unread-gateway-adapter.ts`.
- Custom runtime defaults off unless `channels.qqbot.customRuntime.enabled=true`.
- Synthetic digest messages use `_customUnreadSnapshot`, `_customUnreadSnapshotId`, and `_noMerge`.
- Synthetic digest sends use proactive/unanchored group sends and should therefore be guarded by proactive budget/policy.
- Mention replies can trigger unread catch-up after the direct reply.
- Custom auth gates plugin-level slash commands before config mutation/deploy actions.
- Custom auth also gates ordinary OpenClaw/model dispatch before tools run: normal chat needs `chat.send`, framework slash-like commands need `codex.run`, and codex-only scenes route ordinary dispatch checks to `codex.run`.
- Custom auth supports temporary grants through text commands and C2C/group inline cards.
- Custom poll commands provide the first lightweight interactive-card feature on top of the same C2C/group inline keyboard send paths.

## Open Items

- Validate custom auth inline cards on the actual deployed bot after installing the custom package; local tests only validate payload construction and handler logic.
- Validate custom poll inline cards on the actual deployed bot after installing the custom package; local tests validate payload construction, command handling, interaction handling, and persistence only.
- Audit channel DM send path before adding scene-specific logic for `DIRECT_MESSAGE_CREATE`.
- Capture official/observed recall-delete event behavior if the custom runtime needs deletion state.
