import assert from "node:assert";
import type { QueuedMessage } from "../src/message-queue.js";
import type { QueueSnapshot } from "../src/slash-commands.js";
import { buildCustomFallbackRecordInput } from "../src/custom/fallback-record-context.js";
import type { CustomFallbackDispatchStateSnapshot } from "../src/custom/fallback-dispatch-state.js";

const queueSnapshot: QueueSnapshot = {
  totalPending: 4,
  activeUsers: 1,
  maxConcurrentUsers: 10,
  senderPending: 2,
  senderActiveMs: 123,
  maxActiveMs: 456,
};

const dispatchSnapshot: CustomFallbackDispatchStateSnapshot = {
  hasResponse: true,
  hasBlockResponse: false,
  hasModelBlockOutput: false,
  dispatchTimedOut: true,
  toolDeliverCount: 3,
  toolTextCount: 2,
  toolMediaCount: 1,
  toolFallbackSent: false,
  toolRenewalCount: 1,
};

const groupMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "hello",
  messageId: "MSG_GROUP",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

const groupRecord = buildCustomFallbackRecordInput({
  kind: "response-timeout",
  message: groupMessage,
  sessionKey: "qqbot:session",
  queueSnapshot,
  dispatchSnapshot,
  reason: "Response timeout",
  timeoutMs: 300_000,
  details: { custom: "value" },
});

assert.equal(groupRecord.kind, "response-timeout");
assert.deepEqual(groupRecord.peer, { kind: "group", id: "GROUP_OPENID", label: undefined });
assert.deepEqual(groupRecord.actor, { id: "MEMBER_OPENID", label: "Member", isBot: undefined });
assert.equal(groupRecord.sessionKey, "qqbot:session");
assert.equal(groupRecord.runId, "MSG_GROUP");
assert.equal(groupRecord.messageId, "MSG_GROUP");
assert.equal(groupRecord.timeoutMs, 300_000);
assert.equal(groupRecord.toolDeliverCount, 3);
assert.equal(groupRecord.toolTextCount, 2);
assert.equal(groupRecord.toolMediaCount, 1);
assert.equal(groupRecord.hasResponse, true);
assert.equal(groupRecord.hasBlockResponse, false);
assert.equal(groupRecord.details?.custom, "value");
assert.equal(groupRecord.details?.queueTotalPending, 4);
assert.equal(groupRecord.details?.queueSenderActiveMs, 123);
assert.equal(groupRecord.details?.queueMaxActiveMs, 456);

const c2cRecord = buildCustomFallbackRecordInput({
  kind: "tool-fallback-text",
  message: {
    ...groupMessage,
    type: "c2c",
    groupOpenid: undefined,
    senderId: "USER_OPENID",
    senderName: "Luke",
    messageId: "MSG_C2C",
  },
  queueSnapshot,
  dispatchSnapshot,
});

assert.deepEqual(c2cRecord.peer, { kind: "c2c", id: "USER_OPENID", label: "Luke" });
assert.deepEqual(c2cRecord.actor, { id: "USER_OPENID", label: "Luke", isBot: undefined });
assert.equal(c2cRecord.details?.queueActiveUsers, 1);

const guildRecord = buildCustomFallbackRecordInput({
  kind: "context-too-long",
  message: {
    ...groupMessage,
    type: "guild",
    groupOpenid: undefined,
    channelId: "CHANNEL_ID",
    guildId: "GUILD_ID",
    messageId: "MSG_GUILD",
  },
  queueSnapshot,
  dispatchSnapshot,
});

assert.deepEqual(guildRecord.peer, { kind: "channel", id: "CHANNEL_ID", label: undefined });

console.log("custom fallback record context tests passed");
