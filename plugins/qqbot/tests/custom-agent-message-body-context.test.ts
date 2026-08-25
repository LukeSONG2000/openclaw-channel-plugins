import assert from "node:assert";
import type { QueuedMessage } from "../src/message-queue.js";
import {
  buildCustomAgentMessageBodyContext,
  formatMergedSenderLabel,
  formatSingleSenderLabel,
} from "../src/custom/agent-message-body-context.js";

const base: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Luke",
  content: "hello",
  messageId: "MSG",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

assert.equal(formatSingleSenderLabel({ senderId: "MEMBER", senderName: "Luke" }), "Luke (MEMBER)");
assert.equal(formatSingleSenderLabel({ senderId: "MEMBER" }), "MEMBER");
assert.equal(formatMergedSenderLabel({ senderId: "MEMBER", senderName: "Luke" }), "Luke (MEMBER)");
assert.equal(formatMergedSenderLabel({ senderId: "MEMBER", senderName: "Luke (MEMBER)" }), "Luke (MEMBER)");

const singleGroup = buildCustomAgentMessageBodyContext({
  event: base,
  userContent: "hello",
  quotePart: "[引用] ",
  dynamicContext: "[动态]\n",
  wasMentioned: true,
  formatSubMessageContent: (message) => message.content,
  formatMergedEnvelope: (input) => `${input.sender}:${input.body}`,
});
assert.equal(singleGroup.senderPrefix, "[Luke (MEMBER_OPENID)] ");
assert.equal(singleGroup.mentionTag, " (@你)");
assert.equal(singleGroup.userMessage, "[Luke (MEMBER_OPENID)] [引用] hello (@你)");
assert.equal(singleGroup.agentBody, "[动态]\n[Luke (MEMBER_OPENID)] [引用] hello (@你)");

const slashCommand = buildCustomAgentMessageBodyContext({
  event: base,
  userContent: "/new",
  quotePart: "[引用] ",
  dynamicContext: "[动态]\n",
  wasMentioned: true,
  formatSubMessageContent: (message) => message.content,
  formatMergedEnvelope: (input) => `${input.sender}:${input.body}`,
});
assert.equal(slashCommand.userMessage, "[Luke (MEMBER_OPENID)] [引用] /new (@你)");
assert.equal(slashCommand.agentBody, "/new");

const c2c = buildCustomAgentMessageBodyContext({
  event: { ...base, type: "c2c", groupOpenid: undefined },
  userContent: "private hello",
  quotePart: "[引用] ",
  dynamicContext: "",
  wasMentioned: false,
  formatSubMessageContent: (message) => message.content,
  formatMergedEnvelope: (input) => `${input.sender}:${input.body}`,
});
assert.equal(c2c.senderPrefix, "");
assert.equal(c2c.mentionTag, "");
assert.equal(c2c.userMessage, "[引用] private hello");
assert.equal(c2c.agentBody, "[引用] private hello");

const mergedMessages: QueuedMessage[] = [
  {
    ...base,
    senderId: "MEMBER_A",
    senderName: "Alice",
    content: "first",
    timestamp: "2026-06-22T00:00:01.000Z",
  },
  {
    ...base,
    senderId: "MEMBER_B",
    senderName: "Bob (MEMBER_B)",
    content: "second",
    timestamp: "2026-06-22T00:00:02.000Z",
  },
];

const merged = buildCustomAgentMessageBodyContext({
  event: {
    ...base,
    _mergedCount: 2,
    _mergedMessages: mergedMessages,
  },
  userContent: "merged body",
  quotePart: "[引用] ",
  dynamicContext: "[动态]\n",
  wasMentioned: true,
  formatSubMessageContent: (message) => `content=${message.content}`,
  formatMergedEnvelope: (input) => `[${input.sender}|${input.timestampMs}] ${input.body}`,
});
assert.equal(merged.isMergedMessage, true);
assert.equal(merged.senderPrefix, "");
assert.equal(merged.userMessage, [
  "[以下是合并消息 - 作为上下文]",
  "[Alice (MEMBER_A)|1782086401000] content=first",
  "[当前消息 - 结合上下文回复]",
  "[Bob (MEMBER_B)] content=second (@你)",
].join("\n"));
assert.equal(merged.agentBody, `[动态]\n${merged.userMessage}`);

const missingMergedPayload = buildCustomAgentMessageBodyContext({
  event: {
    ...base,
    _mergedCount: 2,
  },
  userContent: "fallback",
  quotePart: "[引用] ",
  dynamicContext: "",
  wasMentioned: true,
  formatSubMessageContent: (message) => message.content,
  formatMergedEnvelope: (input) => `${input.sender}:${input.body}`,
});
assert.equal(missingMergedPayload.isMergedMessage, true);
assert.equal(missingMergedPayload.senderPrefix, "");
assert.equal(missingMergedPayload.userMessage, "[引用] fallback");

console.log("custom agent message body context tests passed");
