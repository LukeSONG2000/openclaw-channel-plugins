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

console.log("message queue tests passed");
