import assert from "node:assert";
import {
  formatCustomMessageDeleteDiagnostics,
  inspectCustomMessageDeleteEvent,
  isCustomMessageDeleteEventType,
} from "../src/custom/message-delete-events.js";

const channelDelete = inspectCustomMessageDeleteEvent("MESSAGE_DELETE", {
  message: {
    id: "msg-1",
    channel_id: "channel-1",
    guild_id: "guild-1",
    timestamp: "2026-06-21T12:00:00+08:00",
    author: { id: "author-1" },
  },
  op_user_id: "operator-1",
});

assert.deepEqual(channelDelete, {
  eventType: "MESSAGE_DELETE",
  scope: "channel",
  messageId: "msg-1",
  channelId: "channel-1",
  guildId: "guild-1",
  authorId: "author-1",
  operatorId: "operator-1",
  timestamp: "2026-06-21T12:00:00+08:00",
  rawKeys: ["op_user_id", "message"],
});
assert.equal(
  formatCustomMessageDeleteDiagnostics(channelDelete!),
  "event=MESSAGE_DELETE scope=channel message=msg-1 channel=channel-1 guild=guild-1 author=author-1 operator=operator-1 timestamp=2026-06-21T12:00:00+08:00 rawKeys=op_user_id,message",
);

const publicDelete = inspectCustomMessageDeleteEvent("PUBLIC_MESSAGE_DELETE", {
  id: "msg-2",
  channel_id: "channel-2",
  guild_id: "guild-2",
  operator_id: 12345,
});
assert.equal(publicDelete?.scope, "channel");
assert.equal(publicDelete?.messageId, "msg-2");
assert.equal(publicDelete?.operatorId, "12345");

const dmDelete = inspectCustomMessageDeleteEvent("DIRECT_MESSAGE_DELETE", {
  message_id: "dm-msg-1",
  guild_id: "guild-dm",
  user: { id: "operator-dm" },
});
assert.equal(dmDelete?.scope, "channel-dm");
assert.equal(dmDelete?.messageId, "dm-msg-1");
assert.equal(dmDelete?.guildId, "guild-dm");
assert.equal(dmDelete?.operatorId, "operator-dm");

const sparseDelete = inspectCustomMessageDeleteEvent("DIRECT_MESSAGE_DELETE", null);
assert.deepEqual(sparseDelete, {
  eventType: "DIRECT_MESSAGE_DELETE",
  scope: "channel-dm",
  messageId: undefined,
  channelId: undefined,
  guildId: undefined,
  authorId: undefined,
  operatorId: undefined,
  timestamp: undefined,
  rawKeys: [],
});

assert.equal(inspectCustomMessageDeleteEvent("GROUP_MESSAGE_CREATE", { id: "msg" }), null);
assert.equal(isCustomMessageDeleteEventType("MESSAGE_DELETE"), true);
assert.equal(isCustomMessageDeleteEventType("GROUP_MSG_DELETE"), false);

console.log("custom message delete event tests passed");
