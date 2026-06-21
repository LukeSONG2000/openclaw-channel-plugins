import assert from "node:assert";
import { applyCustomUrgentQueueBypass } from "../src/custom/urgent-queue-bypass-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";
import type { QueueSnapshot } from "../src/slash-commands.js";

const message: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/compact now",
  messageId: "MSG_URGENT",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

const before: QueueSnapshot = {
  totalPending: 4,
  activeUsers: 1,
  maxConcurrentUsers: 10,
  senderPending: 2,
  senderActiveMs: 123,
  maxActiveMs: 456,
};
const after: QueueSnapshot = {
  totalPending: 2,
  activeUsers: 1,
  maxConcurrentUsers: 10,
  senderPending: 0,
  senderActiveMs: 124,
  maxActiveMs: 457,
};

let clearCalls = 0;
const executed: QueuedMessage[] = [];
const events: unknown[] = [];
const infoLogs: string[] = [];
let snapshotCall = 0;

const handled = applyCustomUrgentQueueBypass({
  accountId: "default",
  content: " /COMPACT now ",
  message,
  queue: {
    getMessagePeerId: () => "group:GROUP_OPENID",
    getSnapshot: () => (snapshotCall++ === 0 ? before : after),
    clearUserQueue: (peerId) => {
      assert.equal(peerId, "group:GROUP_OPENID");
      clearCalls += 1;
      return 2;
    },
    executeImmediate: (msg) => { executed.push(msg); },
  },
  recordFallbackEvent: (event) => { events.push(event); },
  log: { info: (message) => infoLogs.push(message) },
});

assert.equal(handled.handled, true);
if (!handled.handled) throw new Error("expected urgent bypass");
assert.equal(handled.command, "/compact");
assert.equal(handled.peerId, "group:GROUP_OPENID");
assert.equal(handled.droppedQueuedMessages, 2);
assert.equal(handled.event.kind, "urgent-queue-bypass");
assert.equal(handled.event.details?.queueSenderPending, 2);
assert.equal(handled.event.details?.queueAfterSenderPending, 0);
assert.equal(clearCalls, 1);
assert.deepEqual(executed, [message]);
assert.equal(events[0], handled.event);
assert.equal(infoLogs.some((line) => line.includes("Urgent command detected")), true);
assert.equal(infoLogs.some((line) => line.includes("Dropped 2 queued messages")), true);

let nonUrgentTouched = false;
const nonUrgent = applyCustomUrgentQueueBypass({
  accountId: "default",
  content: "/newspaper",
  message,
  queue: {
    getMessagePeerId: () => { nonUrgentTouched = true; return "group:GROUP_OPENID"; },
    getSnapshot: () => before,
    clearUserQueue: () => 0,
    executeImmediate: () => { nonUrgentTouched = true; },
  },
});
assert.deepEqual(nonUrgent, { handled: false });
assert.equal(nonUrgentTouched, false);

const c2cMessage: QueuedMessage = {
  type: "c2c",
  senderId: "USER_OPENID",
  senderName: "User",
  content: "/new",
  messageId: "MSG_C2C",
  timestamp: "2026-06-21T00:00:00.000Z",
};
const c2cEvents: any[] = [];
const c2c = applyCustomUrgentQueueBypass({
  accountId: "default",
  content: "/new",
  message: c2cMessage,
  queue: {
    getMessagePeerId: () => "dm:USER_OPENID",
    getSnapshot: () => ({ ...before, senderPending: 0 }),
    clearUserQueue: () => 0,
    executeImmediate: () => {},
  },
  recordFallbackEvent: (event) => { c2cEvents.push(event); },
});
assert.equal(c2c.handled, true);
assert.equal(c2cEvents[0].peer.kind, "c2c");
assert.equal(c2cEvents[0].peer.label, "User");
assert.equal(c2cEvents[0].details.droppedQueuedMessages, 0);

console.log("custom urgent queue bypass gateway adapter tests passed");
