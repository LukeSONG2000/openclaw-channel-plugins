import assert from "node:assert";
import { startCustomC2CInputNotifyKeepAlive } from "../src/custom/typing-keepalive-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const groupMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  content: "hello",
  messageId: "MSG_GROUP",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};
let groupTouched = false;
const groupTyping = startCustomC2CInputNotifyKeepAlive({
  accountId: "default",
  message: groupMessage,
  getToken: async () => { groupTouched = true; return "TOKEN"; },
  clearTokenCache: () => { groupTouched = true; },
  sendInputNotify: async () => { groupTouched = true; return {}; },
});
assert.equal(await groupTyping.inputNotifyRefIdx, undefined);
groupTyping.stop();
assert.equal(groupTouched, false);

const c2cMessage: QueuedMessage = {
  type: "c2c",
  senderId: "USER_OPENID",
  content: "hello",
  messageId: "MSG_C2C",
  timestamp: "2026-06-21T00:00:00.000Z",
};
const sent: Array<{ token: string; openid: string; msgId?: string; inputSecond: number }> = [];
const infoLogs: string[] = [];
let tokenCalls = 0;
let started = 0;
let stopped = 0;
const c2cTyping = startCustomC2CInputNotifyKeepAlive({
  accountId: "default",
  message: c2cMessage,
  getToken: async () => `TOKEN_${++tokenCalls}`,
  clearTokenCache: () => {},
  sendInputNotify: async (token, openid, msgId, inputSecond) => {
    sent.push({ token, openid, msgId, inputSecond });
    return { refIdx: "REF_1" };
  },
  createKeepAlive: ({ openid, msgId, logPrefix }) => {
    assert.equal(openid, "USER_OPENID");
    assert.equal(msgId, "MSG_C2C");
    assert.equal(logPrefix, "[qqbot:default]");
    return {
      start: () => { started += 1; },
      stop: () => { stopped += 1; },
    };
  },
  log: { info: (message) => { infoLogs.push(message); } },
});
assert.equal(await c2cTyping.inputNotifyRefIdx, "REF_1");
assert.deepEqual(sent, [{ token: "TOKEN_1", openid: "USER_OPENID", msgId: "MSG_C2C", inputSecond: 60 }]);
assert.equal(started, 1);
c2cTyping.stop();
assert.equal(stopped, 1);
assert.equal(infoLogs.some((line) => line.includes("Sent input notify to USER_OPENID, got refIdx=REF_1")), true);

const retryLogs: string[] = [];
let retryTokenCalls = 0;
let clearCalls = 0;
let retrySendCalls = 0;
const retryTyping = startCustomC2CInputNotifyKeepAlive({
  accountId: "default",
  message: c2cMessage,
  getToken: async () => `RETRY_TOKEN_${++retryTokenCalls}`,
  clearTokenCache: () => { clearCalls += 1; },
  sendInputNotify: async () => {
    retrySendCalls += 1;
    if (retrySendCalls === 1) throw new Error("401 token expired");
    return { refIdx: "REF_RETRY" };
  },
  createKeepAlive: () => ({ start: () => {}, stop: () => {} }),
  log: { info: (message) => { retryLogs.push(message); } },
});
assert.equal(await retryTyping.inputNotifyRefIdx, "REF_RETRY");
assert.equal(retryTokenCalls, 2);
assert.equal(clearCalls, 1);
assert.equal(retrySendCalls, 2);
assert.equal(retryLogs.some((line) => line.includes("InputNotify token expired")), true);

const errorLogs: string[] = [];
let nonTokenStarted = false;
const failedTyping = startCustomC2CInputNotifyKeepAlive({
  accountId: "default",
  message: c2cMessage,
  getToken: async () => "TOKEN",
  clearTokenCache: () => {},
  sendInputNotify: async () => { throw new Error("network down"); },
  createKeepAlive: () => ({ start: () => { nonTokenStarted = true; }, stop: () => {} }),
  log: { error: (message) => { errorLogs.push(message); } },
});
assert.equal(await failedTyping.inputNotifyRefIdx, undefined);
assert.equal(nonTokenStarted, false);
assert.equal(errorLogs.some((line) => line.includes("sendC2CInputNotify error")), true);

console.log("custom typing keepalive gateway adapter tests passed");
