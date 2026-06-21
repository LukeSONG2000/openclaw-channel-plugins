import assert from "node:assert";
import { applyCustomAgentContextGateway } from "../src/custom/agent-context-gateway-adapter.js";
import type { HistoryEntry } from "../src/group-history.js";
import type { QueuedMessage } from "../src/message-queue.js";

const groupEvent: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "hello",
  messageId: "MSG_ID",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

const history: HistoryEntry[] = [{
  sender: "Alice (MEMBER_A)",
  body: "previous",
  timestamp: 1_000,
  messageId: "OLD_MSG",
}];

{
  const logs: string[] = [];
  const result = applyCustomAgentContextGateway({
    accountId: "default",
    event: groupEvent,
    body: "visible body",
    userContent: "hello",
    quotePart: "[引用]\nquoted\n",
    dynamicContext: "[ctx]\n",
    wasMentioned: true,
    groupHistories: new Map([["GROUP_OPENID", history]]),
    historyLimit: 10,
    formatSubMessageContent: (message) => message.content,
    formatMergedEnvelope: (input) => `[merged ${input.sender}] ${input.body}`,
    formatHistoryEnvelope: (entry) => `[history ${entry.sender}] ${entry.body}`,
    finalizeInboundContext: (payload) => ({ finalized: true, payload }),
    fromAddress: "qqbot:group:GROUP_OPENID",
    toAddress: "qqbot:group:GROUP_OPENID",
    sessionKey: "qqbot:group:GROUP_OPENID",
    routeAccountId: "default",
    isGroupChat: true,
    staticSystemPrompts: ["account prompt"],
    groupSystemPrompt: "group prompt",
    senderLabel: "Member (MEMBER_OPENID)",
    groupSubject: "Master Luke的图书馆",
    hasAsrReferFallback: true,
    voiceTranscriptSources: ["asr"],
    uniqueVoicePaths: ["/tmp/v.wav"],
    uniqueVoiceUrls: ["https://example.com/v.amr"],
    uniqueVoiceAsrReferTexts: ["asr text"],
    commandAuthorized: false,
    media: {
      localMediaPaths: ["/tmp/a.png"],
      localMediaTypes: ["image/png"],
      remoteMediaUrls: ["https://example.com/b.png"],
    },
    quote: {
      replyToId: "REF_ID",
      replyToBody: "quoted",
      replyToSender: "Alice",
      replyToIsQuote: true,
    },
    log: { info: (msg) => logs.push(msg) },
  });

  assert.equal(result.historyApplied, true);
  assert.equal(result.historySource, "legacy");
  assert.equal(result.agentBody.includes("[上次回复后的聊天消息 - 作为上下文]"), true);
  assert.equal(result.agentBody.includes("[history Alice (MEMBER_A)] previous"), true);
  assert.equal(result.agentBody.includes("[Member (MEMBER_OPENID)] [引用]\nquoted\nhello (@你)"), true);
  assert.equal(logs.some((line) => line.includes("agentBody length")), true);
  const payload = (result.ctxPayload as any).payload;
  assert.equal(payload.Body, "visible body");
  assert.equal(payload.BodyForAgent, result.agentBody);
  assert.equal(payload.GroupSystemPrompt, "account prompt\ngroup prompt");
  assert.equal(payload.WasMentioned, true);
  assert.equal(payload.CommandAuthorized, false);
  assert.equal(payload.MediaPath, "/tmp/a.png");
  assert.equal(payload.MediaUrl, "https://example.com/b.png");
  assert.equal(payload.ReplyToId, "REF_ID");
}

{
  const event: QueuedMessage = {
    ...groupEvent,
    type: "c2c",
    groupOpenid: undefined,
    content: "/new",
  };
  const result = applyCustomAgentContextGateway({
    accountId: "default",
    event,
    body: "visible slash",
    userContent: "/new",
    quotePart: "[引用] ",
    dynamicContext: "[ctx]\n",
    wasMentioned: false,
    groupHistories: new Map([["GROUP_OPENID", history]]),
    mentionHistory: [{ sender: "Mention", body: "mention" }],
    historyLimit: 10,
    formatSubMessageContent: (message) => message.content,
    formatMergedEnvelope: (input) => `[merged ${input.sender}] ${input.body}`,
    formatHistoryEnvelope: () => { throw new Error("direct messages should not format history"); },
    finalizeInboundContext: (payload) => payload,
    fromAddress: "qqbot:c2c:MEMBER_OPENID",
    toAddress: "qqbot:c2c:MEMBER_OPENID",
    sessionKey: "qqbot:c2c:MEMBER_OPENID",
    routeAccountId: "default",
    isGroupChat: false,
    staticSystemPrompts: [],
    groupSystemPrompt: "",
    senderLabel: "",
    groupSubject: "",
    hasAsrReferFallback: false,
    voiceTranscriptSources: [],
    uniqueVoicePaths: [],
    uniqueVoiceUrls: [],
    uniqueVoiceAsrReferTexts: [],
    commandAuthorized: true,
    media: { localMediaPaths: [], localMediaTypes: [], remoteMediaUrls: [] },
    quote: {},
  });

  assert.equal(result.historyApplied, false);
  assert.equal(result.agentBody, "/new");
  assert.equal((result.ctxPayload as any).ChatType, "direct");
  assert.equal((result.ctxPayload as any).WasMentioned, undefined);
}

console.log("custom agent context gateway adapter tests passed");
