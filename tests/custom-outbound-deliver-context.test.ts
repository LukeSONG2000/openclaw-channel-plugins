import assert from "node:assert";
import type { QueuedMessage } from "../src/message-queue.js";
import {
  buildCustomOutboundDeliverContext,
  buildCustomOutboundDeliverEvent,
  buildCustomOutboundProactiveSource,
} from "../src/custom/outbound-deliver-context.js";

const groupMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Luke",
  senderIsBot: false,
  content: "hello",
  messageId: "MSG_ID",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
  msgIdx: "MSG_IDX",
};

assert.deepEqual(buildCustomOutboundDeliverEvent(groupMessage, "MSG_ID"), {
  type: "group",
  senderId: "MEMBER_OPENID",
  messageId: "MSG_ID",
  replyToId: "MSG_ID",
  channelId: undefined,
  groupOpenid: "GROUP_OPENID",
  msgIdx: "MSG_IDX",
  customUnreadSnapshotId: undefined,
});

assert.equal(buildCustomOutboundDeliverEvent({
  ...groupMessage,
  _customUnreadSnapshotId: "snapshot-1",
}, undefined).customUnreadSnapshotId, "snapshot-1");

const account = {
  accountId: "default",
  appId: "APPID",
  clientSecret: "SECRET",
} as any;
const guard = () => ({ allowed: true as const });
const log = { info: () => {}, error: () => {} };
const context = buildCustomOutboundDeliverContext({
  event: groupMessage,
  replyAnchorId: undefined,
  account,
  qualifiedTarget: "qqbot:group:GROUP_OPENID",
  log,
  proactiveGuard: guard,
});
assert.equal(context.deliverEvent.replyToId, undefined);
assert.equal(context.deliverAccountContext.account, account);
assert.equal(context.deliverAccountContext.qualifiedTarget, "qqbot:group:GROUP_OPENID");
assert.equal(context.deliverAccountContext.log, log);
assert.equal(context.deliverAccountContext.proactiveGuard, guard);

assert.deepEqual(buildCustomOutboundProactiveSource(groupMessage), {
  actor: {
    id: "MEMBER_OPENID",
    label: "Luke",
    isBot: false,
  },
  messageId: "MSG_ID",
  timestamp: 1782086400000,
});

const guildMessage: QueuedMessage = {
  ...groupMessage,
  type: "guild",
  channelId: "CHANNEL_ID",
  groupOpenid: undefined,
};
assert.deepEqual(buildCustomOutboundDeliverEvent(guildMessage, "GUILD_MSG"), {
  type: "guild",
  senderId: "MEMBER_OPENID",
  messageId: "MSG_ID",
  replyToId: "GUILD_MSG",
  channelId: "CHANNEL_ID",
  groupOpenid: undefined,
  msgIdx: "MSG_IDX",
  customUnreadSnapshotId: undefined,
});

console.log("custom outbound deliver context tests passed");
