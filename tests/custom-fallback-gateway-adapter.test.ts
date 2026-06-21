import assert from "node:assert";
import {
  handleCustomFallbackCommand,
  parseCustomFallbackCommand,
} from "../src/custom/fallback-gateway-adapter.js";
import { buildCustomFallbackEvent } from "../src/custom/fallbacks.js";
import type { QueuedMessage } from "../src/message-queue.js";

const message: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/bot-fallback",
  messageId: "MSG_ID",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

assert.deepEqual(parseCustomFallbackCommand("/bot-fallback"), {
  matched: true,
  command: { kind: "list", limit: 5 },
});
assert.deepEqual(parseCustomFallbackCommand("/bot-fallback status 3"), {
  matched: true,
  command: { kind: "list", limit: 3 },
});
assert.deepEqual(parseCustomFallbackCommand("/bot-fallback 2"), {
  matched: true,
  command: { kind: "list", limit: 2 },
});
assert.deepEqual(parseCustomFallbackCommand("/bot-fallback list 99"), {
  matched: true,
  error: "数量需要是 1 到 20 的整数",
});
assert.deepEqual(parseCustomFallbackCommand("/bot-fallback clear"), {
  matched: true,
  command: { kind: "clear", force: false },
});
assert.deepEqual(parseCustomFallbackCommand("/bot-fallback clear --force"), {
  matched: true,
  command: { kind: "clear", force: true },
});
assert.deepEqual(parseCustomFallbackCommand("/bot-ping"), { matched: false });

let loadedLimit = 0;
const event = buildCustomFallbackEvent({
  kind: "response-timeout",
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "MEMBER_OPENID", label: "Member" },
  sessionKey: "agent:main:qqbot:default:group:group_openid",
  runId: "RUN_ID",
  messageId: "MSG_ID",
  reason: "Response timeout after 300s",
  at: Date.UTC(2026, 5, 21, 0, 0, 0),
  timeoutMs: 300_000,
  toolDeliverCount: 1,
  toolTextCount: 0,
  toolMediaCount: 0,
  hasResponse: false,
  hasBlockResponse: false,
});

const result = handleCustomFallbackCommand({
  accountId: "default",
  message,
  rawContent: "/bot-fallback list 3",
  store: {
    loadEvents: (_accountId, limit) => {
      loadedLimit = limit;
      return [event];
    },
  },
});
assert.equal(result.handled, true);
assert.equal(loadedLimit, 3);
assert.equal(result.reply?.includes("最近兜底事件"), true);
assert.equal(result.reply?.includes("response-timeout"), true);
assert.equal(result.reply?.includes("group:GROUP_OPENID"), true);
assert.equal(result.reply?.includes("RUN_ID"), true);

const empty = handleCustomFallbackCommand({
  accountId: "default",
  message,
  rawContent: "/bot-fallback",
  store: {
    loadEvents: () => [],
  },
});
assert.equal(empty.handled, true);
assert.equal(empty.reply?.includes("暂无记录"), true);

let clearCount = 0;
const clearPrompt = handleCustomFallbackCommand({
  accountId: "default",
  message,
  rawContent: "/bot-fallback clear",
  store: {
    loadEvents: () => [],
    clearEvents: () => {
      clearCount += 1;
      return true;
    },
  },
});
assert.equal(clearPrompt.handled, true);
assert.equal(clearPrompt.reply?.includes("--force"), true);
assert.equal(clearCount, 0);

const cleared = handleCustomFallbackCommand({
  accountId: "default",
  message,
  rawContent: "/bot-fallback clear --force",
  store: {
    loadEvents: () => [],
    clearEvents: () => {
      clearCount += 1;
      return true;
    },
  },
});
assert.equal(cleared.handled, true);
assert.equal(cleared.reply?.includes("已清空"), true);
assert.equal(clearCount, 1);

console.log("custom fallback gateway adapter tests passed");
