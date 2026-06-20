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

console.log("message queue tests passed");
