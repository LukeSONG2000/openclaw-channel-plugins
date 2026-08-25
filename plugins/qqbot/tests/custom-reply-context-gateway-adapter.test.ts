import assert from "node:assert";
import type { QueuedMessage } from "../src/message-queue.js";
import {
  buildCustomGatewayReplyContext,
  resolveCustomReplyAnchorId,
} from "../src/custom/reply-context-gateway-adapter.js";

const account = {
  accountId: "default",
  appId: "APPID",
  clientSecret: "SECRET",
} as any;

const groupMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Luke",
  content: "hello",
  messageId: "MSG_ID",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

assert.equal(resolveCustomReplyAnchorId(groupMessage), "MSG_ID");
assert.equal(resolveCustomReplyAnchorId({
  ...groupMessage,
  _customUnreadSnapshotId: "snapshot-1",
}), undefined);

let guardCall: any = null;
const group = buildCustomGatewayReplyContext({
  event: groupMessage,
  account,
  cfg: { marker: true },
  log: { info: () => {}, error: () => {} },
  prepareUnanchoredTextSend: (params) => {
    guardCall = params;
    return { allowed: true };
  },
});

assert.equal(group.replyAnchorId, "MSG_ID");
assert.deepEqual(group.replyTarget, {
  type: "group",
  senderId: "MEMBER_OPENID",
  messageId: "MSG_ID",
  channelId: undefined,
  groupOpenid: "GROUP_OPENID",
});
assert.equal(group.replyContext.target, group.replyTarget);
assert.equal(group.replyContext.account, account);
assert.deepEqual(group.replyContext.cfg, { marker: true });
assert.equal(group.replyContext.prepareUnanchoredTextSend?.({
  targetType: "group",
  targetId: "GROUP_OPENID",
  text: "hi",
})?.allowed, true);
assert.deepEqual(guardCall, {
  targetType: "group",
  targetId: "GROUP_OPENID",
  text: "hi",
});

const synthetic = buildCustomGatewayReplyContext({
  event: {
    ...groupMessage,
    _customUnreadSnapshotId: "snapshot-1",
  },
  account,
  cfg: {},
});
assert.equal(synthetic.replyAnchorId, undefined);
assert.equal(synthetic.replyTarget.messageId, "");
assert.equal(synthetic.replyContext.target.messageId, "");

const c2c = buildCustomGatewayReplyContext({
  event: {
    type: "c2c",
    senderId: "USER_OPENID",
    content: "private",
    messageId: "C2C_MSG",
    timestamp: "2026-06-22T00:00:00.000Z",
  },
  account,
  cfg: {},
});
assert.deepEqual(c2c.replyTarget, {
  type: "c2c",
  senderId: "USER_OPENID",
  messageId: "C2C_MSG",
  channelId: undefined,
  groupOpenid: undefined,
});

console.log("custom reply context gateway adapter tests passed");
