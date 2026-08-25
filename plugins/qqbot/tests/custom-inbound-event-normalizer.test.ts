import assert from "node:assert";
import { MSG_TYPE_QUOTE } from "../src/types.js";
import {
  normalizePlatformTimestampMs,
  normalizeQQBotInboundEvent,
} from "../src/custom/inbound-event-normalizer.js";

const c2c = normalizeQQBotInboundEvent({
  eventType: "C2C_MESSAGE_CREATE",
  accountId: "default",
  data: {
    id: "c2c-msg-1",
    content: "hello",
    timestamp: "2026-06-21T08:00:00+08:00",
    author: {
      id: "AUTHOR_ID",
      union_openid: "UNION_OPENID",
      user_openid: "USER_OPENID",
    },
    message_scene: { source: "c2c", ext: ["ref_msg_idx=EXT_REF", "msg_idx=SELF_REF"] },
    message_type: MSG_TYPE_QUOTE,
    msg_elements: [{ msg_idx: "ELEMENT_REF" }],
    attachments: [{ content_type: "image/png", url: "https://example.com/a.png" }],
  },
});
assert.equal(c2c.kind, "message");
if (c2c.kind === "message") {
  assert.deepEqual(c2c.knownUsers, [{ openid: "USER_OPENID", type: "c2c", accountId: "default" }]);
  assert.equal(c2c.message.type, "c2c");
  assert.equal(c2c.message.senderId, "USER_OPENID");
  assert.equal(c2c.message.refMsgIdx, "ELEMENT_REF");
  assert.equal(c2c.message.msgIdx, "SELF_REF");
  assert.equal(c2c.message.msgType, MSG_TYPE_QUOTE);
  assert.equal(c2c.message.attachments?.[0]?.content_type, "image/png");
}

const guild = normalizeQQBotInboundEvent({
  eventType: "AT_MESSAGE_CREATE",
  accountId: "default",
  data: {
    id: "guild-msg-1",
    channel_id: "CHANNEL_ID",
    guild_id: "GUILD_ID",
    content: "guild hello",
    timestamp: "2026-06-21T08:01:00+08:00",
    author: { id: "GUILD_USER", username: "Guild User" },
  },
});
assert.equal(guild.kind, "message");
if (guild.kind === "message") {
  assert.equal(guild.message.type, "guild");
  assert.equal(guild.message.channelId, "CHANNEL_ID");
  assert.equal(guild.message.guildId, "GUILD_ID");
  assert.equal(guild.knownUsers[0]?.nickname, "Guild User");
}

const dm = normalizeQQBotInboundEvent({
  eventType: "DIRECT_MESSAGE_CREATE",
  accountId: "default",
  data: {
    id: "dm-msg-1",
    channel_id: "DM_CHANNEL",
    guild_id: "GUILD_ID",
    content: "dm hello",
    timestamp: "2026-06-21T08:02:00+08:00",
    author: { id: "DM_USER", username: "DM User" },
  },
});
assert.equal(dm.kind, "message");
if (dm.kind === "message") {
  assert.equal(dm.message.type, "dm");
  assert.equal(dm.message.channelId, undefined);
  assert.equal(dm.message.guildId, "GUILD_ID");
}

const group = normalizeQQBotInboundEvent({
  eventType: "GROUP_AT_MESSAGE_CREATE",
  accountId: "default",
  data: {
    id: "group-msg-1",
    content: "@bot hello",
    timestamp: "2026-06-21T08:03:00+08:00",
    group_id: "RAW_GROUP_ID",
    group_openid: "GROUP_OPENID",
    author: {
      id: "AUTHOR_ID",
      member_openid: "MEMBER_OPENID",
      username: "Member Name",
      bot: false,
    },
    message_scene: { source: "group", ext: ["msg_idx=GROUP_SELF_REF"] },
    mentions: [{ member_openid: "BOT_MEMBER", nickname: "Bot", is_you: true }],
  },
});
assert.equal(group.kind, "message");
if (group.kind === "message") {
  assert.equal(group.message.type, "group");
  assert.equal(group.message.eventType, "GROUP_AT_MESSAGE_CREATE");
  assert.equal(group.message.groupOpenid, "GROUP_OPENID");
  assert.equal(group.message.senderName, "Member Name");
  assert.equal(group.message.msgIdx, "GROUP_SELF_REF");
  assert.equal(group.message.mentions?.[0]?.username, "Bot");
  assert.deepEqual(group.knownUsers, [{
    openid: "MEMBER_OPENID",
    type: "group",
    nickname: "Member Name",
    groupOpenid: "GROUP_OPENID",
    accountId: "default",
  }]);
}

const c2cReject = normalizeQQBotInboundEvent({
  eventType: "C2C_MSG_REJECT",
  accountId: "default",
  data: { timestamp: 1_000, openid: "USER_OPENID" },
});
assert.equal(c2cReject.kind, "proactive-acceptance");
if (c2cReject.kind === "proactive-acceptance") {
  assert.equal(c2cReject.accepted, false);
  assert.deepEqual(c2cReject.peer, { kind: "c2c", id: "USER_OPENID" });
  assert.equal(c2cReject.timestampMs, 1_000_000);
}

const groupReceive = normalizeQQBotInboundEvent({
  eventType: "GROUP_MSG_RECEIVE",
  accountId: "default",
  data: { timestamp: 1_000_000_000_000, group_openid: "GROUP_OPENID", op_member_openid: "OP_MEMBER" },
});
assert.equal(groupReceive.kind, "proactive-acceptance");
if (groupReceive.kind === "proactive-acceptance") {
  assert.equal(groupReceive.accepted, true);
  assert.equal(groupReceive.updatedBy, "OP_MEMBER");
  assert.equal(groupReceive.timestampMs, 1_000_000_000_000);
  assert.equal(groupReceive.logMessage.includes("accepted"), true);
}

const addRobot = normalizeQQBotInboundEvent({
  eventType: "GROUP_ADD_ROBOT",
  accountId: "default",
  data: { timestamp: "2026-06-21T08:04:00+08:00", group_openid: "GROUP_OPENID", op_member_openid: "OP_MEMBER" },
});
assert.equal(addRobot.kind, "group-robot");
if (addRobot.kind === "group-robot") {
  assert.equal(addRobot.action, "add");
  assert.equal(addRobot.knownUsers[0]?.openid, "OP_MEMBER");
  assert.equal(addRobot.logMessage.includes("added"), true);
}

assert.equal(normalizeQQBotInboundEvent({
  eventType: "READY",
  accountId: "default",
  data: {},
}).kind, "unsupported");
assert.equal(normalizePlatformTimestampMs("not-a-number") <= Date.now(), true);

console.log("custom inbound event normalizer tests passed");
