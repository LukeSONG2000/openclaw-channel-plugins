import assert from "node:assert";
import { createMessageQueue, type QueuedMessage } from "../src/message-queue.js";

const processed: QueuedMessage[] = [];
let releaseFirst: (() => void) | undefined;

const queue = createMessageQueue({
  accountId: "default",
  isAborted: () => false,
});

function groupMessage(id: string, overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    type: "group",
    senderId: "USER_OPENID",
    content: id,
    messageId: id,
    timestamp: "2026-06-21T00:00:00.000Z",
    groupOpenid: "GROUP_OPENID",
    ...overrides,
  };
}

queue.startProcessor(async (msg) => {
  processed.push(msg);
  if (msg.messageId === "blocking") {
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  }
});

queue.enqueue(groupMessage("blocking"));
await new Promise((resolve) => setTimeout(resolve, 0));

queue.enqueue(groupMessage("normal-1"));
queue.enqueue(groupMessage("digest", {
  senderId: "__qqbot_digest__",
  senderName: "未读群聊",
  senderIsBot: true,
  _customUnreadSnapshotId: "snapshot-1",
  _customUnreadSnapshot: [{ sender: "Luke", body: "hello", timestamp: 1_000, messageId: "hist-1" }],
  _noMerge: true,
}));
queue.enqueue(groupMessage("normal-2"));

releaseFirst?.();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(processed.length, 4);
assert.equal(processed[0]!.messageId, "blocking");
assert.equal(processed[1]!.messageId, "normal-1");
assert.equal(processed[2]!._customUnreadSnapshotId, "snapshot-1");
assert.equal(processed[2]!._noMerge, true);
assert.equal(processed[3]!.messageId, "normal-2");

const exactProcessed: QueuedMessage[] = [];
let releaseExactBlocker: (() => void) | undefined;
const exactQueue = createMessageQueue({
  accountId: "default",
  isAborted: () => false,
});
exactQueue.startProcessor(async (msg) => {
  exactProcessed.push(msg);
  if (msg.messageId === "exact-blocker") {
    await new Promise<void>((resolve) => {
      releaseExactBlocker = resolve;
    });
  }
});
exactQueue.enqueue(groupMessage("exact-blocker"));
await new Promise((resolve) => setTimeout(resolve, 0));
exactQueue.enqueue(groupMessage("exact-first", {
  senderId: "FIRST_USER",
  senderName: "First",
  content: "first body",
}));
exactQueue.enqueue(groupMessage("exact-second", {
  senderId: "SECOND_USER",
  senderName: "Second",
  content: "second body",
  attachments: [{ content_type: "image/png", url: "https://example.com/second.png" }],
}));
releaseExactBlocker?.();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));

assert.deepEqual(exactProcessed.map((msg) => msg.messageId), [
  "exact-blocker",
  "exact-first",
  "exact-second",
]);
assert.equal(exactProcessed[1]!.senderId, "FIRST_USER");
assert.equal(exactProcessed[1]!.content, "first body");
assert.equal(exactProcessed[2]!.senderId, "SECOND_USER");
assert.equal(exactProcessed[2]!.content, "second body");
assert.equal(exactProcessed[2]!.attachments?.[0]?.url, "https://example.com/second.png");
assert.equal(exactProcessed[1]!._mergedCount, undefined);
assert.equal(exactProcessed[2]!._mergedCount, undefined);

const immediateProcessed: QueuedMessage[] = [];
const immediateQueue = createMessageQueue({
  accountId: "default",
  isAborted: () => false,
});

immediateQueue.executeImmediate(groupMessage("urgent-before-start", {
  content: "/new",
}));
assert.equal(immediateProcessed.length, 0);
immediateQueue.startProcessor(async (msg) => {
  immediateProcessed.push(msg);
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(immediateProcessed.length, 1);
assert.equal(immediateProcessed[0]!.messageId, "urgent-before-start");

const blockedPeerProcessed: QueuedMessage[] = [];
let releaseBlockedPeer: (() => void) | undefined;
const blockedPeerQueue = createMessageQueue({
  accountId: "default",
  isAborted: () => false,
});

blockedPeerQueue.startProcessor(async (msg) => {
  blockedPeerProcessed.push(msg);
  if (msg.messageId === "blocking-peer") {
    await new Promise<void>((resolve) => {
      releaseBlockedPeer = resolve;
    });
  }
});

blockedPeerQueue.enqueue(groupMessage("blocking-peer"));
await new Promise((resolve) => setTimeout(resolve, 0));

const queuedNormal = groupMessage("queued-normal");
blockedPeerQueue.enqueue(queuedNormal);
const blockedPeerId = blockedPeerQueue.getMessagePeerId(queuedNormal);
const activeSnapshot = blockedPeerQueue.getSnapshot(blockedPeerId);
assert.equal(activeSnapshot.activeUsers, 1);
assert.equal(typeof activeSnapshot.senderActiveMs, "number");
assert.equal(typeof activeSnapshot.maxActiveMs, "number");
assert.ok(activeSnapshot.senderActiveMs! >= 0);
assert.ok(activeSnapshot.maxActiveMs! >= 0);
assert.equal(blockedPeerQueue.clearUserQueue(blockedPeerId), 1);

blockedPeerQueue.executeImmediate(groupMessage("urgent-while-peer-blocked", {
  content: "/compact",
}));
await new Promise((resolve) => setTimeout(resolve, 0));

assert.deepEqual(blockedPeerProcessed.map((msg) => msg.messageId), [
  "blocking-peer",
  "urgent-while-peer-blocked",
]);

releaseBlockedPeer?.();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(blockedPeerProcessed.map((msg) => msg.messageId), [
  "blocking-peer",
  "urgent-while-peer-blocked",
]);

const priorityProcessed: QueuedMessage[] = [];
let releasePriorityBlocker: (() => void) | undefined;
const priorityQueue = createMessageQueue({
  accountId: "default",
  isAborted: () => false,
});
priorityQueue.startProcessor(async (msg) => {
  priorityProcessed.push(msg);
  if (msg.messageId === "priority-blocker") {
    await new Promise<void>((resolve) => {
      releasePriorityBlocker = resolve;
    });
  }
});
priorityQueue.enqueue(groupMessage("priority-blocker"));
await new Promise((resolve) => setTimeout(resolve, 0));
priorityQueue.enqueue(groupMessage("background", {
  _queuePriority: "background",
  _customUnreadSnapshotId: "snapshot-background",
  _noMerge: true,
}));
priorityQueue.enqueue(groupMessage("mention", {
  eventType: "GROUP_AT_MESSAGE_CREATE",
  mentions: [{ is_you: true }],
}));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(priorityProcessed.map((msg) => msg.messageId), [
  "priority-blocker",
  "mention",
]);
assert.equal(priorityProcessed[1]!._queueIsolatedSession, true);
releasePriorityBlocker?.();
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(priorityProcessed.map((msg) => msg.messageId), [
  "priority-blocker",
  "mention",
  "background",
]);

const fifoProcessed: QueuedMessage[] = [];
let releaseFifoBlocker: (() => void) | undefined;
const fifoQueue = createMessageQueue({
  accountId: "default",
  isAborted: () => false,
  maxConcurrentUsers: 1,
});
fifoQueue.startProcessor(async (msg) => {
  fifoProcessed.push(msg);
  if (msg.messageId === "fifo-blocker") {
    await new Promise<void>((resolve) => {
      releaseFifoBlocker = resolve;
    });
  }
});
fifoQueue.enqueue(groupMessage("fifo-blocker"));
await new Promise((resolve) => setTimeout(resolve, 0));
fifoQueue.enqueue(groupMessage("mention-first", { eventType: "GROUP_AT_MESSAGE_CREATE" }));
fifoQueue.enqueue(groupMessage("mention-second", { eventType: "GROUP_AT_MESSAGE_CREATE" }));
releaseFifoBlocker?.();
await new Promise((resolve) => setTimeout(resolve, 0));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(fifoProcessed.map((msg) => msg.messageId), [
  "fifo-blocker",
  "mention-first",
  "mention-second",
]);

let preemptCalls = 0;
let releaseBackground: (() => void) | undefined;
const preemptProcessed: QueuedMessage[] = [];
const preemptQueue = createMessageQueue({
  accountId: "default",
  isAborted: () => false,
  abortActiveBackground: () => {
    preemptCalls += 1;
    releaseBackground?.();
    return true;
  },
});
preemptQueue.startProcessor(async (msg) => {
  preemptProcessed.push(msg);
  if (msg.messageId === "active-background") {
    await new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
  }
});
preemptQueue.enqueue(groupMessage("active-background", { _queuePriority: "background" }));
await new Promise((resolve) => setTimeout(resolve, 0));
preemptQueue.enqueue(groupMessage("preempting-mention", { eventType: "GROUP_AT_MESSAGE_CREATE" }));
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(preemptCalls, 1);
assert.equal(preemptProcessed.some((msg) => msg.messageId === "preempting-mention"), true);

console.log("message queue tests passed");
