import assert from "node:assert";
import type { QueuedMessage } from "../src/message-queue.js";
import {
  resolveCustomGatewayMessageReplyTarget,
  resolveCustomGatewayMessageRouteContext,
} from "../src/custom/gateway-message-routing.js";

const base = {
  senderId: "USER_OPENID",
  senderName: "User",
  content: "hello",
  messageId: "MSG_ID",
  timestamp: "2026-06-21T00:00:00.000Z",
} satisfies Omit<QueuedMessage, "type">;

const c2c = resolveCustomGatewayMessageRouteContext({
  ...base,
  type: "c2c",
});
assert.equal(c2c.isGroupChat, false);
assert.equal(c2c.peerId, "USER_OPENID");
assert.deepEqual(c2c.routePeer, { kind: "direct", id: "USER_OPENID" });
assert.deepEqual(c2c.customScenePeer, { kind: "c2c", id: "USER_OPENID" });
assert.equal(c2c.fromAddress, "qqbot:c2c:USER_OPENID");
assert.equal(c2c.toAddress, "qqbot:c2c:USER_OPENID");
assert.equal(c2c.requestTarget, "qqbot:c2c:USER_OPENID");

const groupEvent: QueuedMessage = {
  ...base,
  type: "group",
  groupOpenid: "GROUP_OPENID",
};
const group = resolveCustomGatewayMessageRouteContext(groupEvent);
assert.equal(group.isGroupChat, true);
assert.equal(group.peerId, "GROUP_OPENID");
assert.deepEqual(group.routePeer, { kind: "group", id: "GROUP_OPENID" });
assert.deepEqual(group.customScenePeer, { kind: "group", id: "GROUP_OPENID" });
assert.equal(group.fromAddress, "qqbot:group:GROUP_OPENID");
assert.equal(group.requestTarget, "qqbot:group:GROUP_OPENID");

const guild = resolveCustomGatewayMessageRouteContext({
  ...base,
  type: "guild",
  channelId: "CHANNEL_ID",
  guildId: "GUILD_ID",
});
assert.equal(guild.isGroupChat, true);
assert.equal(guild.peerId, "CHANNEL_ID");
assert.deepEqual(guild.routePeer, { kind: "group", id: "CHANNEL_ID" });
assert.deepEqual(guild.customScenePeer, { kind: "channel", id: "CHANNEL_ID" });
assert.equal(guild.fromAddress, "qqbot:channel:CHANNEL_ID");
assert.equal(guild.requestTarget, "qqbot:group:undefined");

const dm = resolveCustomGatewayMessageRouteContext({
  ...base,
  type: "dm",
  guildId: "GUILD_DM_ID",
});
assert.equal(dm.isGroupChat, false);
assert.equal(dm.peerId, "USER_OPENID");
assert.deepEqual(dm.routePeer, { kind: "direct", id: "USER_OPENID" });
assert.deepEqual(dm.customScenePeer, { kind: "dm", id: "USER_OPENID" });
assert.equal(dm.fromAddress, "qqbot:c2c:USER_OPENID");
assert.equal(dm.requestTarget, "qqbot:c2c:USER_OPENID");

assert.deepEqual(resolveCustomGatewayMessageReplyTarget(groupEvent, ""), {
  type: "group",
  senderId: "USER_OPENID",
  messageId: "",
  channelId: undefined,
  groupOpenid: "GROUP_OPENID",
});

console.log("custom gateway message routing tests passed");
