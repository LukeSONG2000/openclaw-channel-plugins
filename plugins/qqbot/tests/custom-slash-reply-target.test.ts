import assert from "node:assert";
import type { QueuedMessage } from "../src/message-queue.js";
import {
  resolveCustomSlashReplyMediaTarget,
  resolveCustomSlashReplyTarget,
} from "../src/custom/slash-reply-target.js";

const base = {
  senderId: "USER_OPENID",
  senderName: "User",
  content: "/bot-ping",
  messageId: "MSG_ID",
  timestamp: "2026-06-21T00:00:00.000Z",
} satisfies Partial<QueuedMessage>;

assert.deepEqual(resolveCustomSlashReplyTarget({
  ...base,
  type: "c2c",
} as QueuedMessage), {
  kind: "c2c",
  userOpenid: "USER_OPENID",
  msgId: "MSG_ID",
});

assert.deepEqual(resolveCustomSlashReplyTarget({
  ...base,
  type: "group",
  groupOpenid: "GROUP_OPENID",
} as QueuedMessage), {
  kind: "group",
  groupOpenid: "GROUP_OPENID",
  msgId: "MSG_ID",
});

assert.deepEqual(resolveCustomSlashReplyTarget({
  ...base,
  type: "guild",
  channelId: "CHANNEL_ID",
} as QueuedMessage), {
  kind: "channel",
  channelId: "CHANNEL_ID",
  msgId: "MSG_ID",
});

assert.deepEqual(resolveCustomSlashReplyTarget({
  ...base,
  type: "dm",
  guildId: "DM_GUILD_ID",
} as QueuedMessage), {
  kind: "dm",
  guildId: "DM_GUILD_ID",
  msgId: "MSG_ID",
});

assert.equal(resolveCustomSlashReplyTarget({
  ...base,
  type: "dm",
} as QueuedMessage), null);

assert.deepEqual(resolveCustomSlashReplyMediaTarget({
  ...base,
  type: "c2c",
} as QueuedMessage), {
  targetType: "c2c",
  targetId: "USER_OPENID",
});
assert.deepEqual(resolveCustomSlashReplyMediaTarget({
  ...base,
  type: "group",
  groupOpenid: "GROUP_OPENID",
} as QueuedMessage), {
  targetType: "group",
  targetId: "GROUP_OPENID",
});
assert.deepEqual(resolveCustomSlashReplyMediaTarget({
  ...base,
  type: "guild",
  channelId: "CHANNEL_ID",
} as QueuedMessage), {
  targetType: "channel",
  targetId: "CHANNEL_ID",
});
assert.equal(resolveCustomSlashReplyMediaTarget({
  ...base,
  type: "dm",
  guildId: "DM_GUILD_ID",
} as QueuedMessage), null);

console.log("custom slash reply target tests passed");
