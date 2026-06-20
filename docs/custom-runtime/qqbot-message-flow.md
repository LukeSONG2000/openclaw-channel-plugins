# QQBot Message Flow

Evidence date: 2026-06-21.

Primary sources:

- Official docs: `https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/event.html`
- Official docs: `https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html`
- Local source: `src/types.ts`, `src/gateway.ts`, `src/api.ts`, `src/outbound-deliver.ts`
- Server state: `laptop-home:/home/PPfavorite/.openclaw/qqbot/data`

## Receive Events

The official connector subscribes to:

- `C2C_MESSAGE_CREATE`
- `GROUP_AT_MESSAGE_CREATE`
- `GROUP_MESSAGE_CREATE`
- `AT_MESSAGE_CREATE`
- `DIRECT_MESSAGE_CREATE`
- `INTERACTION_CREATE`
- group management events such as `GROUP_ADD_ROBOT`, `GROUP_DEL_ROBOT`, `GROUP_MSG_REJECT`, `GROUP_MSG_RECEIVE`

The gateway uses full intents:

- `PUBLIC_GUILD_MESSAGES`
- `DIRECT_MESSAGE`
- `GROUP_AND_C2C`
- `INTERACTION`

## C2C Fields

Official and local type `C2CMessageEvent`:

- `id`: platform message id, used as `msg_id` for passive replies.
- `content`: text content.
- `timestamp`: RFC3339 timestamp.
- `author.user_openid`: user openid used for DM routing.
- `author.union_openid`: optional union id.
- `attachments`: images, voice, video, files.
- `message_scene.ext`: may include `ref_msg_idx` and `msg_idx`.
- `message_type`: known values include `0` text and `103` quote in local constants.
- `msg_elements`: quote/reference payloads.

Raw QQ number is not exposed here. Use `user_openid` for authorization and routing.

## Group Fields

Official and local type `GroupMessageEvent`:

- `id`: platform message id, used as `msg_id` for passive replies.
- `content`: text content.
- `timestamp`: RFC3339 timestamp.
- `group_openid`: group openid used for group routing and send target.
- `group_id`: present in local type but not safe to assume as raw QQ group number.
- `author.member_openid`: member openid within the group.
- `author.username`: observed/local type nickname-like display name.
- `author.bot`: whether sender is a bot.
- `mentions`: mention list, including `is_you` for bot mention detection where provided.
- `attachments`: images, voice, video, files.
- `message_scene.ext`: may include `ref_msg_idx` and `msg_idx`.
- `message_type` and `msg_elements`: quote/reference handling.

Raw QQ group number and raw QQ member number are not reliable event fields. Use `group_openid` and `member_openid` for policy. Maintain a local alias mapping for human labels such as `945739251` / `Master Luke的图书馆`.

## Attachment Fields

Official attachment fields:

- `content_type`: examples include `image/jpeg`, `image/png`, `image/gif`, `file`, `video/mp4`, `voice`.
- `filename`
- `height`
- `width`
- `size`
- `url`
- `voice_wav_url`
- `asr_refer_text`

Current plugin processing:

- `processAttachments` downloads or summarizes attachments.
- Voice can use `voice_wav_url` or ASR text.
- Attachments are summarized into group history and ref-index entries.
- Outbound media supports image, voice, video, and file upload for C2C/group.

## Send Capabilities

The official send docs describe four scenes:

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

The connector switches text sends to Markdown when `markdownSupport` is true.

## Official Limits That Affect Custom Runtime

From the official send docs:

- C2C passive replies: valid for 60 minutes, max 5 replies per incoming message.
- Group passive replies: valid for 5 minutes, max 5 replies per incoming message.
- C2C proactive messages: 4 messages per user per month.
- Group proactive messages: 4 messages per group per month.
- Users/groups can disable receiving proactive messages.
- C2C wakeup/recall messages are available after user interaction, 1 per period across same day, 1-3 days, 3-7 days, and 7-30 days.
- Official docs state proactive push capability was adjusted from 2025-04-21 and may return errors.
- Sub-channel passive replies are valid for 5 minutes; send rate in one sub-channel is max 5 messages/second.

Implication:

- The custom runtime must treat group delayed autonomous replies as either a near-term passive reply within the 5-minute window or a scarce proactive send.
- Ten-minute sleep catch-up cannot rely on passive group `msg_id`.
- For delayed group speaking, prefer a policy that asks for confirmation or uses very limited proactive budget.
- For follow-up after a direct mention, keep the active autonomous window inside 5 minutes for group if using passive replies.

## Interaction And Buttons

Local types support `InlineKeyboard` and `INTERACTION_CREATE`:

- Button action types include link, callback, command, and mqqapi.
- Callback buttons produce `INTERACTION_CREATE`.
- The handler must acknowledge interactions through `PUT /interactions/{id}`.
- Current server code already uses buttons for approval decisions.

Potential uses:

- Authorization request cards: allow once, allow N times, deny.
- Scene switch cards for admins.
- Task status cards: query, cancel, add requirement.
- Voting and lightweight games, provided callback ACK and state storage are robust.

Open item:

- Some keyboard/card capabilities require platform review/template approval. Validate in the actual bot environment before building UI-heavy flows.

## Current Group/DM Logic

Current official connector behavior:

- C2C messages go through message queue and route to `qqbot:c2c:{user_openid}`.
- Group messages use `groupPolicy`, `groupAllowFrom`, `requireMention`, `ignoreOtherMentions`, and group history.
- Non-mentioned group messages are recorded to in-memory pending history if allowed, then skipped.
- Mentioned group messages inject pending history into the agent context.
- Slash commands are detected before normal dispatch.
- Urgent commands should bypass blocked queues.

Current server hotfix behavior:

- Non-mentioned group messages can schedule unread catch-up.
- Synthetic digest messages are enqueued with `senderId="__qqbot_digest__"`.
- Synthetic digest sends use proactive group messages.
- Mention replies can trigger unread catch-up after the direct reply.

Target custom behavior should preserve the useful parts while moving them behind a clear runtime module.
