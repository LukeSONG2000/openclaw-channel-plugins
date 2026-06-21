import assert from "node:assert";
import {
  normalizeCustomInboundUserContent,
  prepareCustomInboundMessageGateway,
} from "../src/custom/inbound-preparation-gateway-adapter.js";
import type { ProcessedAttachments } from "../src/inbound-attachments.js";
import type { QueuedMessage } from "../src/message-queue.js";
import type { RefIndexEntry } from "../src/ref-index-store.js";

const emptyProcessed: ProcessedAttachments = {
  attachmentInfo: "",
  imageUrls: [],
  imageMediaTypes: [],
  voiceAttachmentPaths: [],
  voiceAttachmentUrls: [],
  voiceAsrReferTexts: [],
  voiceTranscripts: [],
  voiceTranscriptSources: [],
  attachmentLocalPaths: [],
};

function event(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    type: "group",
    senderId: "MEMBER_OPENID",
    senderName: "Member",
    content: "<@BOT> hi <faceType=1>",
    messageId: "msg-1",
    timestamp: "2026-06-21T00:00:00.000Z",
    groupOpenid: "GROUP_OPENID",
    mentions: [{ member_openid: "BOT", username: "Bot", is_you: true }],
    refMsgIdx: "REF_IDX",
    msgIdx: "MSG_IDX",
    attachments: [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" }],
    ...overrides,
  };
}

assert.equal(normalizeCustomInboundUserContent({
  event: event(),
  parsedContent: "<@BOT> hi",
  attachmentInfo: "\n[附件: /tmp/file.txt]",
  voiceText: "voice text",
  stripMentionText: (text) => text.replace("<@BOT> ", ""),
}), "hi\nvoice text\n[附件: /tmp/file.txt]");

assert.equal(normalizeCustomInboundUserContent({
  event: event({ type: "c2c", groupOpenid: undefined, content: "hello <@MEMBER>", mentions: [{ member_openid: "MEMBER", username: "Alice" }] }),
  parsedContent: "hello <@MEMBER>",
  attachmentInfo: "",
  voiceText: "",
  stripMentionText: (text) => text,
}), "hello @Alice");

{
  const cachedRef: RefIndexEntry = {
    content: "cached quote",
    senderId: "OTHER_MEMBER",
    senderName: "Alice",
    timestamp: 1_000,
  };
  const written = new Map<string, RefIndexEntry>();
  const logs: string[] = [];
  const processed: ProcessedAttachments = {
    ...emptyProcessed,
    attachmentInfo: "\n[附件: /tmp/file.txt]",
    imageUrls: ["/tmp/a.png"],
    imageMediaTypes: ["image/png"],
    voiceAttachmentPaths: ["/tmp/v.wav"],
    voiceAttachmentUrls: ["https://example.com/v.amr"],
    voiceAsrReferTexts: ["ASR 原文"],
    voiceTranscripts: ["voice text"],
    voiceTranscriptSources: ["asr"],
    attachmentLocalPaths: ["/tmp/a.png", "/tmp/v.wav"],
  };

  const result = await prepareCustomInboundMessageGateway({
    cfg: {} as any,
    account: { accountId: "default", appId: "APPID" },
    event: event({
      attachments: [
        { content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" },
        { content_type: "voice", url: "https://example.com/v.amr", filename: "v.amr" },
      ],
    }),
    peerId: "GROUP_OPENID",
    isGroupChat: true,
    envelopeOptions: { style: "test" },
    inputNotifyRefIdx: Promise.resolve("INPUT_REF"),
    processAttachments: async () => processed,
    formatVoiceText: (texts) => texts.join("\n"),
    parseFaceTags: (content) => content.replace("<faceType=1>", "[微笑]"),
    stripMentionText: (text) => text.replace("<@BOT> ", ""),
    getRefEntry: () => cachedRef,
    setRefEntry: (idx, entry) => { written.set(idx, entry); },
    formatRefEntry: (entry) => `ref:${entry.content}`,
    formatMessageReference: async () => "unused",
    formatInboundEnvelope: (input) => `${input.chatType}:${input.from}:${input.body}:${input.imageUrls?.join(",") ?? ""}`,
    log: { info: (msg) => logs.push(msg) },
  });

  assert.equal(result.parsedContent, "<@BOT> hi [微笑]");
  assert.equal(result.userContent, "hi [微笑]\nvoice text\n[附件: /tmp/file.txt]");
  assert.equal(result.body, "group:Member:hi [微笑]\nvoice text\n[附件: /tmp/file.txt]:/tmp/a.png");
  assert.equal(result.quoteRef.replyToBody, "ref:cached quote");
  assert.equal(result.quoteRef.quotePart.includes("ref:cached quote"), true);
  assert.equal(result.currentRefRecord?.refIdx, "MSG_IDX");
  assert.equal(written.get("MSG_IDX")?.content, "<@BOT> hi [微笑]");
  assert.equal(written.get("MSG_IDX")?.attachments?.[1]?.transcript, "voice text");
  assert.equal(result.inboundMedia.dynamicContext.includes("- 图片: /tmp/a.png"), true);
  assert.equal(result.inboundMedia.dynamicContext.includes("- 语音: /tmp/v.wav, https://example.com/v.amr"), true);
  assert.equal(result.inboundMedia.hasAsrReferFallback, true);
  assert.equal(result.voiceSummary?.includes("local=1, remote=1"), true);
  assert.equal(logs.some((line) => line.includes("Quote detected via refMsgIdx cache")), true);
  assert.equal(logs.some((line) => line.includes("Cached msgIdx=MSG_IDX")), true);
  assert.equal(logs.some((line) => line.includes("Voice input summary")), true);
}

{
  const written = new Map<string, RefIndexEntry>();
  const result = await prepareCustomInboundMessageGateway({
    cfg: {} as any,
    account: { accountId: "default", appId: "APPID" },
    event: event({ type: "c2c", groupOpenid: undefined, msgIdx: undefined, refMsgIdx: undefined, content: "hello", mentions: undefined }),
    peerId: "USER_OPENID",
    isGroupChat: false,
    envelopeOptions: {},
    inputNotifyRefIdx: Promise.resolve("INPUT_REF"),
    processAttachments: async () => emptyProcessed,
    formatVoiceText: () => "",
    parseFaceTags: (content) => content,
    stripMentionText: (text) => text,
    getRefEntry: () => null,
    setRefEntry: (idx, entry) => { written.set(idx, entry); },
    formatRefEntry: (entry) => entry.content,
    formatMessageReference: async () => "unused",
    formatInboundEnvelope: (input) => `${input.chatType}:${input.body}`,
  });
  assert.equal(result.body, "direct:hello");
  assert.equal(result.currentRefRecord?.refIdx, "INPUT_REF");
  assert.equal(written.get("INPUT_REF")?.senderId, "MEMBER_OPENID");
}

console.log("custom inbound preparation gateway adapter tests passed");
