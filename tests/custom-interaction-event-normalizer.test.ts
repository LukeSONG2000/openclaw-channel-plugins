import assert from "node:assert";
import {
  normalizeQQBotInteractionEvent,
  parseLegacyApprovalInteractionButton,
  resolveCustomInteractionReplyTarget,
  resolveCustomInteractionSourcePeer,
} from "../src/custom/interaction-event-normalizer.js";
import type { InteractionEvent } from "../src/types.js";

const groupEvent: InteractionEvent = {
  id: "interaction-1",
  type: 11,
  scene: "group",
  chat_type: 1,
  group_openid: "GROUP_OPENID",
  group_member_openid: "MEMBER_OPENID",
  version: 1,
  data: {
    type: 1,
    resolved: {
      button_id: "approve",
      button_data: "custom-auth:authreq-1:allow-once",
    },
  },
};

const group = normalizeQQBotInteractionEvent(groupEvent);
assert.equal(group.id, "interaction-1");
assert.equal(group.dataType, 1);
assert.equal(group.sceneDesc, "group");
assert.equal(group.buttonId, "approve");
assert.equal(group.buttonData, "custom-auth:authreq-1:allow-once");
assert.equal(group.actorId, "MEMBER_OPENID");
assert.deepEqual(group.sourcePeer, { kind: "group", id: "GROUP_OPENID" });
assert.deepEqual(group.replyTarget, { kind: "group", groupOpenid: "GROUP_OPENID" });

const c2cEvent: InteractionEvent = {
  id: "interaction-2",
  type: 11,
  chat_type: 2,
  user_openid: "USER_OPENID",
  version: 1,
  data: {
    type: 1,
    resolved: {
      button_data: "custom-poll:poll-1:vote:2",
    },
  },
};
const c2c = normalizeQQBotInteractionEvent(c2cEvent);
assert.equal(c2c.sceneDesc, "c2c");
assert.equal(c2c.actorId, "USER_OPENID");
assert.deepEqual(c2c.sourcePeer, { kind: "c2c", id: "USER_OPENID" });
assert.deepEqual(c2c.replyTarget, { kind: "c2c", userOpenid: "USER_OPENID" });

const channelEvent: InteractionEvent = {
  id: "interaction-3",
  type: 11,
  chat_type: 0,
  guild_id: "GUILD_ID",
  channel_id: "CHANNEL_ID",
  version: 1,
  data: {
    type: 1,
    resolved: {
      button_data: "custom-game:guess-1:guess:3",
      user_id: "CHANNEL_USER",
    },
  },
};
const channel = normalizeQQBotInteractionEvent(channelEvent);
assert.equal(channel.sceneDesc, "guild");
assert.equal(channel.actorId, "CHANNEL_USER");
assert.deepEqual(channel.sourcePeer, { kind: "channel", id: "CHANNEL_ID" });
assert.deepEqual(channel.replyTarget, { kind: "channel", channelId: "CHANNEL_ID" });

const dmFallback = normalizeQQBotInteractionEvent({
  id: "interaction-4",
  type: 11,
  guild_id: "GUILD_ID",
  version: 1,
  data: { type: 1, resolved: {} },
});
assert.deepEqual(dmFallback.sourcePeer, { kind: "dm", id: "GUILD_ID" });
assert.equal(dmFallback.replyTarget, undefined);
assert.equal(dmFallback.actorId, "unknown");

assert.deepEqual(resolveCustomInteractionSourcePeer({ groupOpenid: "GROUP_OPENID" }), {
  kind: "group",
  id: "GROUP_OPENID",
});
assert.deepEqual(resolveCustomInteractionSourcePeer({ userOpenid: "USER_OPENID" }), {
  kind: "c2c",
  id: "USER_OPENID",
});
assert.deepEqual(resolveCustomInteractionSourcePeer({ channelId: "CHANNEL_ID", guildId: "GUILD_ID" }), {
  kind: "channel",
  id: "CHANNEL_ID",
});
assert.deepEqual(resolveCustomInteractionSourcePeer({ guildId: "GUILD_ID" }), {
  kind: "dm",
  id: "GUILD_ID",
});
assert.equal(resolveCustomInteractionSourcePeer({}), undefined);
assert.deepEqual(resolveCustomInteractionReplyTarget(groupEvent), {
  kind: "group",
  groupOpenid: "GROUP_OPENID",
});

assert.deepEqual(parseLegacyApprovalInteractionButton("approve:exec:123e4567-e89b-12d3-a456-426614174000:allow-once"), {
  approvalId: "exec:123e4567-e89b-12d3-a456-426614174000",
  decision: "allow-once",
});
assert.deepEqual(parseLegacyApprovalInteractionButton("approve:plugin:123e4567-e89b-12d3-a456-426614174000:deny"), {
  approvalId: "plugin:123e4567-e89b-12d3-a456-426614174000",
  decision: "deny",
});
assert.deepEqual(parseLegacyApprovalInteractionButton("approve:123e4567-e89b-12d3-a456-426614174000:allow-always"), {
  approvalId: "123e4567-e89b-12d3-a456-426614174000",
  decision: "allow-always",
});
assert.equal(parseLegacyApprovalInteractionButton("custom-auth:authreq-1:deny"), null);

console.log("custom interaction event normalizer tests passed");
