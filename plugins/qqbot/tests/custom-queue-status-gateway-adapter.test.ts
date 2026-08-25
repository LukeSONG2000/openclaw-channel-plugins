import assert from "node:assert";
import {
  handleCustomQueueStatusCommand,
  parseCustomQueueStatusCommand,
} from "../src/custom/queue-status-gateway-adapter.js";
import type { QueueSnapshot } from "../src/slash-commands.js";

const snapshot: QueueSnapshot = {
  totalPending: 4,
  activeUsers: 2,
  maxConcurrentUsers: 5,
  senderPending: 1,
  senderActiveMs: 65_432,
  maxActiveMs: 125_000,
};

assert.deepEqual(parseCustomQueueStatusCommand("hello"), { matched: false });
assert.deepEqual(parseCustomQueueStatusCommand("/bot-queue"), {
  matched: true,
  command: { kind: "status" },
});
assert.deepEqual(parseCustomQueueStatusCommand("/bot-queue status"), {
  matched: true,
  command: { kind: "status" },
});
assert.deepEqual(parseCustomQueueStatusCommand("/bot-queue health"), {
  matched: true,
  command: { kind: "status" },
});
assert.deepEqual(parseCustomQueueStatusCommand("/bot-queue help"), {
  matched: true,
  command: { kind: "help" },
});
assert.deepEqual(parseCustomQueueStatusCommand("/bot-fallback"), { matched: false });

const unknown = parseCustomQueueStatusCommand("/bot-queue dump hidden cached message");
assert.equal(unknown.matched, true);
assert.equal(unknown.matched && unknown.error, "未知子命令：dump");

const status = handleCustomQueueStatusCommand({
  rawContent: "/bot-queue",
  peerId: "group:GROUP_OPENID",
  snapshot,
});
assert.equal(status.handled, true);
assert.equal(status.reply?.includes("当前队列状态"), true);
assert.equal(status.reply?.includes("当前会话：group:GROUP_OPENID"), true);
assert.equal(status.reply?.includes("本会话待处理：1"), true);
assert.equal(status.reply?.includes("全局待处理：4"), true);
assert.equal(status.reply?.includes("活跃用户：2/5"), true);
assert.equal(status.reply?.includes("本会话活跃：1分钟5秒"), true);
assert.equal(status.reply?.includes("最长活跃：2分钟5秒"), true);
assert.equal(status.reply?.includes(`<qqbot-cmd-input text="/compact" show="压缩上下文"/>`), true);
assert.equal(status.reply?.includes(`<qqbot-cmd-input text="/new" show="新会话"/>`), true);
assert.equal(status.reply?.includes("hidden cached message"), false);

const idle = handleCustomQueueStatusCommand({
  rawContent: "/bot-queue status",
  peerId: "dm:USER_OPENID",
  snapshot: {
    totalPending: 0,
    activeUsers: 0,
    maxConcurrentUsers: 5,
    senderPending: 0,
  },
});
assert.equal(idle.handled, true);
assert.equal(idle.reply?.includes("本会话活跃：-"), true);
assert.equal(idle.reply?.includes("恢复命令"), false);
assert.equal(idle.reply?.includes("qqbot-cmd-input"), false);

const activeOnly = handleCustomQueueStatusCommand({
  rawContent: "/bot-queue status",
  peerId: "group:GROUP_OPENID",
  snapshot: {
    totalPending: 0,
    activeUsers: 1,
    maxConcurrentUsers: 5,
    senderPending: 0,
    senderActiveMs: 999,
    maxActiveMs: 999,
  },
});
assert.equal(activeOnly.handled, true);
assert.equal(activeOnly.reply?.includes("本会话活跃：999毫秒"), true);
assert.equal(activeOnly.reply?.includes("qqbot-cmd-input text=\"/compact\""), true);

const missingSnapshot = handleCustomQueueStatusCommand({
  rawContent: "/bot-queue",
  peerId: "unknown",
});
assert.equal(missingSnapshot.handled, true);
assert.equal(missingSnapshot.reply?.includes("队列快照暂不可用"), true);

const help = handleCustomQueueStatusCommand({
  rawContent: "/bot-queue help",
  peerId: "group:GROUP_OPENID",
  snapshot,
});
assert.equal(help.handled, true);
assert.equal(help.reply?.includes("自定义队列状态命令"), true);
assert.equal(help.reply?.includes("/bot-queue status"), true);

const errorHelp = handleCustomQueueStatusCommand({
  rawContent: "/bot-queue dump hidden cached message",
  peerId: "group:GROUP_OPENID",
  snapshot,
});
assert.equal(errorHelp.handled, true);
assert.equal(errorHelp.reply?.includes("未知子命令：dump"), true);
assert.equal(errorHelp.reply?.includes("hidden cached message"), false);

console.log("custom queue status gateway adapter tests passed");
