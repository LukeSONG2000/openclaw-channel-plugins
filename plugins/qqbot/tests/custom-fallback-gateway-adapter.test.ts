import assert from "node:assert";
import {
  handleCustomFallbackCommand,
  parseCustomFallbackCommand,
} from "../src/custom/fallback-gateway-adapter.js";
import { parseCustomFallbackCommand as parseCustomFallbackCommandDirect } from "../src/custom/fallback-command-parser.js";
import {
  formatCustomFallbackList,
  formatCustomFallbackSummary,
} from "../src/custom/fallback-presentation.js";
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
assert.deepEqual(parseCustomFallbackCommand("/bot-fallback summary"), {
  matched: true,
  command: { kind: "summary", limit: 20 },
});
assert.deepEqual(parseCustomFallbackCommandDirect("/bot-fallback summary 2"), {
  matched: true,
  command: { kind: "summary", limit: 2 },
});
assert.deepEqual(parseCustomFallbackCommand("/bot-fallback summary 2"), parseCustomFallbackCommandDirect("/bot-fallback summary 2"));
assert.deepEqual(parseCustomFallbackCommand("/bot-fallback stats 50"), {
  matched: true,
  command: { kind: "summary", limit: 50 },
});
assert.deepEqual(parseCustomFallbackCommand("/bot-fallback list 99"), {
  matched: true,
  error: "数量需要是 1 到 20 的整数",
});
assert.deepEqual(parseCustomFallbackCommand("/bot-fallback summary 101"), {
  matched: true,
  error: "统计数量需要是 1 到 100 的整数",
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
  details: {
    queueTotalPending: 4,
    queueActiveUsers: 1,
    queueMaxConcurrentUsers: 2,
    queueSenderPending: 3,
  },
});
const contextEvent = buildCustomFallbackEvent({
  kind: "context-too-long",
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "MEMBER_OPENID", label: "Member" },
  sessionKey: "agent:main:qqbot:default:group:group_openid",
  runId: "RUN_CONTEXT",
  messageId: "MSG_CONTEXT",
  reason: "maximum context length is 128000 tokens",
  at: Date.UTC(2026, 5, 21, 0, 1, 0),
  toolDeliverCount: 0,
  toolTextCount: 0,
  toolMediaCount: 0,
  hasResponse: false,
  hasBlockResponse: false,
  details: {
    queueTotalPending: 1,
    queueActiveUsers: 1,
    queueMaxConcurrentUsers: 2,
    queueSenderPending: 0,
  },
});
const toolTextEvent = buildCustomFallbackEvent({
  kind: "tool-fallback-text",
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "MEMBER_OPENID", label: "Member" },
  sessionKey: "agent:main:qqbot:default:group:group_openid",
  runId: "RUN_TOOL",
  messageId: "MSG_TOOL",
  at: Date.UTC(2026, 5, 21, 0, 2, 0),
  toolDeliverCount: 2,
  toolTextCount: 1,
  toolMediaCount: 0,
  hasResponse: false,
  hasBlockResponse: false,
  details: {
    queueTotalPending: 6,
    queueActiveUsers: 2,
    queueMaxConcurrentUsers: 3,
    queueSenderPending: 5,
  },
});
const urgentEvent = buildCustomFallbackEvent({
  kind: "urgent-queue-bypass",
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "MEMBER_OPENID", label: "Member" },
  runId: "RUN_URGENT",
  messageId: "MSG_URGENT",
  reason: "urgent command /compact bypassed peer queue; dropped 2 queued message(s)",
  at: Date.UTC(2026, 5, 21, 0, 3, 0),
  details: {
    command: "/compact",
    queuePeerId: "group:GROUP_OPENID",
    droppedQueuedMessages: 2,
    queueTotalPending: 8,
    queueActiveUsers: 2,
    queueMaxConcurrentUsers: 3,
    queueSenderPending: 2,
    queueSenderActiveMs: 120_000,
    queueMaxActiveMs: 180_000,
    queueAfterTotalPending: 6,
    queueAfterSenderPending: 0,
    queueAfterSenderActiveMs: 121_000,
  },
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
assert.equal(result.reply?.includes("队列：待处理=4, 活跃=1/2, 当前会话待处理=3"), true);
assert.equal(result.reply?.includes(`<qqbot-cmd-input text="/compact" show="压缩上下文"/>`), true);
assert.equal(result.reply?.includes(`<qqbot-cmd-input text="/new" show="新会话"/>`), true);
assert.equal(formatCustomFallbackList([event], 1).includes("response-timeout"), true);

const urgentList = handleCustomFallbackCommand({
  accountId: "default",
  message,
  rawContent: "/bot-fallback list 1",
  store: {
    loadEvents: () => [urgentEvent],
  },
});
assert.equal(urgentList.handled, true);
assert.equal(urgentList.reply?.includes("urgent-queue-bypass"), true);
assert.equal(urgentList.reply?.includes("队列：待处理=8, 活跃=2/3, 当前会话待处理=2, 活跃时长=2分钟/3分钟"), true);
assert.equal(urgentList.reply?.includes(`紧急绕行：命令=<qqbot-cmd-input text="/compact" show="/compact"/>, 丢弃排队=2, 队列会话=group:GROUP_OPENID, 绕行后待处理=6, 绕行后当前会话待处理=0, 绕行后活跃=2分钟1秒`), true);

let summaryLimit = 0;
const summary = handleCustomFallbackCommand({
  accountId: "default",
  message,
  rawContent: "/bot-fallback summary 50",
  store: {
    loadEvents: (_accountId, limit) => {
      summaryLimit = limit;
      return [event, contextEvent, toolTextEvent, urgentEvent];
    },
  },
});
assert.equal(summary.handled, true);
assert.equal(summaryLimit, 50);
assert.equal(summary.reply?.includes("兜底事件摘要"), true);
assert.equal(summary.reply?.includes("统计：4/50"), true);
assert.equal(summary.reply?.includes("响应超时：1"), true);
assert.equal(summary.reply?.includes("上下文过长：1"), true);
assert.equal(summary.reply?.includes("紧急绕行：1"), true);
assert.equal(summary.reply?.includes("工具兜底：1"), true);
assert.equal(summary.reply?.includes("最大队列：待处理=8, 活跃=2/3, 当前会话待处理=5"), true);
assert.equal(summary.reply?.includes("最长活跃：当前会话=2分钟, 全局=3分钟"), true);
assert.equal(summary.reply?.includes("响应超时（response-timeout）：1"), true);
assert.equal(summary.reply?.includes("上下文过长（context-too-long）：1"), true);
assert.equal(summary.reply?.includes("工具文本兜底（tool-fallback-text）：1"), true);
assert.equal(summary.reply?.includes("紧急队列绕行（urgent-queue-bypass）：1"), true);
assert.equal(summary.reply?.includes("最新：2026-06-21T00:03:00.000Z 紧急队列绕行（urgent-queue-bypass）"), true);
assert.equal(summary.reply?.includes(`<qqbot-cmd-input text="/compact" show="压缩上下文"/>`), true);
assert.equal(summary.reply?.includes(`<qqbot-cmd-input text="/new" show="新会话"/>`), true);
assert.equal(formatCustomFallbackSummary([event, contextEvent, toolTextEvent, urgentEvent], 50).includes("最长活跃：当前会话=2分钟, 全局=3分钟"), true);

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
