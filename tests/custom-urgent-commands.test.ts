import assert from "node:assert";
import {
  CUSTOM_URGENT_QUEUE_BYPASS_COMMANDS,
  buildCustomUrgentQueueBypassEvent,
  isCustomUrgentQueueBypassCommand,
  resolveCustomUrgentQueueBypassCommand,
  resolveCustomUrgentQueuePeer,
} from "../src/custom/urgent-commands.js";

assert.deepEqual(CUSTOM_URGENT_QUEUE_BYPASS_COMMANDS, [
  "/stop",
  "/approve",
  "/new",
  "/compact",
]);

assert.equal(isCustomUrgentQueueBypassCommand("/new"), true);
assert.equal(isCustomUrgentQueueBypassCommand(" /NEW  "), true);
assert.equal(isCustomUrgentQueueBypassCommand("/new reset session"), true);
assert.equal(isCustomUrgentQueueBypassCommand("/compact"), true);
assert.equal(isCustomUrgentQueueBypassCommand("/compact now"), true);
assert.equal(isCustomUrgentQueueBypassCommand("/stop"), true);
assert.equal(isCustomUrgentQueueBypassCommand("/approve abc"), true);

assert.equal(isCustomUrgentQueueBypassCommand("hello /new"), false);
assert.equal(isCustomUrgentQueueBypassCommand("/newspaper"), false);
assert.equal(isCustomUrgentQueueBypassCommand("/compaction"), false);
assert.equal(isCustomUrgentQueueBypassCommand("/approved"), false);
assert.equal(isCustomUrgentQueueBypassCommand("/bot-new"), false);
assert.equal(isCustomUrgentQueueBypassCommand(""), false);
assert.equal(isCustomUrgentQueueBypassCommand(undefined), false);

assert.equal(resolveCustomUrgentQueueBypassCommand("/compact now"), "/compact");
assert.equal(resolveCustomUrgentQueueBypassCommand("/compaction"), null);

assert.deepEqual(resolveCustomUrgentQueuePeer({
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/compact",
  messageId: "MSG_GROUP",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
}, "group:GROUP_OPENID"), {
  kind: "group",
  id: "GROUP_OPENID",
});
assert.deepEqual(resolveCustomUrgentQueuePeer({
  type: "c2c",
  senderId: "USER_OPENID",
  senderName: "User",
  content: "/new",
  messageId: "MSG_C2C",
  timestamp: "2026-06-21T00:00:00.000Z",
}, "dm:USER_OPENID"), {
  kind: "c2c",
  id: "USER_OPENID",
  label: "User",
});

const event = buildCustomUrgentQueueBypassEvent({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "MEMBER_OPENID", label: "Member" },
  messageId: "MSG_URGENT",
  command: "/compact",
  queuePeerId: "group:GROUP_OPENID",
  droppedQueuedMessages: 2,
  queueBefore: {
    totalPending: 4,
    activeUsers: 1,
    maxConcurrentUsers: 10,
    senderPending: 2,
    senderActiveMs: 123,
    maxActiveMs: 456,
  },
  queueAfter: {
    totalPending: 2,
    activeUsers: 1,
    maxConcurrentUsers: 10,
    senderPending: 0,
    senderActiveMs: 124,
    maxActiveMs: 457,
  },
});
assert.equal(event.kind, "urgent-queue-bypass");
assert.equal(event.reason, "urgent command /compact bypassed peer queue; dropped 2 queued message(s)");
assert.equal(event.details?.command, "/compact");
assert.equal(event.details?.queuePeerId, "group:GROUP_OPENID");
assert.equal(event.details?.droppedQueuedMessages, 2);
assert.equal(event.details?.queueSenderPending, 2);
assert.equal(event.details?.queueSenderActiveMs, 123);
assert.equal(event.details?.queueMaxActiveMs, 456);
assert.equal(event.details?.queueAfterSenderPending, 0);
assert.equal(event.details?.queueAfterSenderActiveMs, 124);
assert.equal(event.details?.queueAfterMaxActiveMs, 457);

console.log("custom urgent command tests passed");
