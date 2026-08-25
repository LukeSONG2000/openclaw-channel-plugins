import assert from "node:assert";
import type { QueuedMessage } from "../src/message-queue.js";
import {
  stripQueuePeerPrefix,
  toCustomActorFromQueuedMessage,
  toCustomPeerFromQueuedMessage,
} from "../src/custom/queued-message-context.js";

const base = {
  senderId: "USER_OPENID",
  senderName: "User",
  content: "hello",
  messageId: "MSG_ID",
  timestamp: "2026-06-21T00:00:00.000Z",
} satisfies Omit<QueuedMessage, "type">;

assert.deepEqual(toCustomPeerFromQueuedMessage({
  ...base,
  type: "c2c",
}), {
  kind: "c2c",
  id: "USER_OPENID",
});

assert.deepEqual(toCustomPeerFromQueuedMessage({
  ...base,
  type: "group",
  groupOpenid: "GROUP_OPENID",
}), {
  kind: "group",
  id: "GROUP_OPENID",
});

assert.deepEqual(toCustomPeerFromQueuedMessage({
  ...base,
  type: "group",
}, { queuePeerId: "group:FALLBACK_GROUP" }), {
  kind: "group",
  id: "FALLBACK_GROUP",
});

assert.deepEqual(toCustomPeerFromQueuedMessage({
  ...base,
  type: "guild",
  channelId: "CHANNEL_ID",
}), {
  kind: "channel",
  id: "CHANNEL_ID",
});

assert.deepEqual(toCustomPeerFromQueuedMessage({
  ...base,
  type: "guild",
}, { queuePeerId: "guild:FALLBACK_CHANNEL" }), {
  kind: "channel",
  id: "FALLBACK_CHANNEL",
});

assert.deepEqual(toCustomPeerFromQueuedMessage({
  ...base,
  type: "dm",
  guildId: "GUILD_DM_ID",
}), {
  kind: "dm",
  id: "USER_OPENID",
});

assert.deepEqual(toCustomActorFromQueuedMessage({
  ...base,
  type: "group",
  senderIsBot: false,
}), {
  id: "USER_OPENID",
  label: "User",
  isBot: false,
});

assert.equal(stripQueuePeerPrefix("group:GROUP_OPENID"), "GROUP_OPENID");
assert.equal(stripQueuePeerPrefix("USER_OPENID"), "USER_OPENID");
assert.equal(stripQueuePeerPrefix(undefined), undefined);

console.log("custom queued message context tests passed");
