import assert from "node:assert";
import { MSG_TYPE_QUOTE } from "../src/types.js";
import {
  buildCustomCurrentRefIndexRecord,
  resolveCustomQuoteReferenceContext,
} from "../src/custom/message-reference-context.js";

const cached = await resolveCustomQuoteReferenceContext({
  event: { refMsgIdx: "REF_CACHED" },
  getRefEntry: () => ({
    content: "cached body",
    senderId: "MEMBER_OPENID",
    senderName: "Member",
    timestamp: 1_000,
  }),
  formatRefEntry: (entry) => `formatted:${entry.content}`,
  formatMessageReference: async () => "unused",
});
assert.equal(cached.replyToId, "REF_CACHED");
assert.equal(cached.replyToBody, "formatted:cached body");
assert.equal(cached.replyToSender, "Member");
assert.equal(cached.replyToIsQuote, true);
assert.equal(cached.quotePart, "[引用消息开始]\nformatted:cached body\n[引用消息结束]\n");
assert.equal(cached.logs[0]?.includes("refMsgIdx cache"), true);

const miss = await resolveCustomQuoteReferenceContext({
  event: {
    refMsgIdx: "REF_MISS",
    msgType: MSG_TYPE_QUOTE,
    msgElements: [{ content: "quoted", attachments: [{ content_type: "image/png", url: "https://example.com/a.png" }] }],
  },
  getRefEntry: () => undefined,
  formatRefEntry: () => "unused",
  formatMessageReference: async (ref) => `element:${ref.content}:${ref.attachments?.[0]?.content_type}`,
});
assert.equal(miss.replyToBody, "element:quoted:image/png");
assert.equal(miss.quotePart.includes("element:quoted:image/png"), true);
assert.equal(miss.logs[0]?.includes("msg_elements[0]"), true);

const noElements = await resolveCustomQuoteReferenceContext({
  event: { refMsgIdx: "REF_EMPTY", msgType: MSG_TYPE_QUOTE, msgElements: [] },
  getRefEntry: () => undefined,
  formatRefEntry: () => "unused",
  formatMessageReference: async () => "unused",
});
assert.equal(noElements.replyToBody, undefined);
assert.equal(noElements.quotePart, "[引用消息开始]\n原始内容不可用\n[引用消息结束]\n");
assert.equal(noElements.logs[0]?.includes("no msg_elements"), true);

const notQuote = await resolveCustomQuoteReferenceContext({
  event: { refMsgIdx: "REF_TEXT", msgType: 0 },
  getRefEntry: () => undefined,
  formatRefEntry: () => "unused",
  formatMessageReference: async () => "unused",
});
assert.equal(notQuote.replyToId, "REF_TEXT");
assert.equal(notQuote.replyToBody, undefined);
assert.equal(notQuote.logs[0]?.includes("not quote"), true);

const none = await resolveCustomQuoteReferenceContext({
  event: {},
  getRefEntry: () => undefined,
  formatRefEntry: () => "unused",
  formatMessageReference: async () => "unused",
});
assert.deepEqual(none, { replyToIsQuote: false, quotePart: "", logs: [] });

const current = buildCustomCurrentRefIndexRecord({
  event: {
    msgIdx: "MSG_IDX",
    senderId: "MEMBER_OPENID",
    senderName: "Member",
    timestamp: "2026-06-21T00:00:00.000Z",
    attachments: [
      { content_type: "voice", url: "https://example.com/a.amr", filename: "a.amr" },
      { content_type: "image/png", url: "https://example.com/a.png" },
    ],
  },
  parsedContent: "hello",
  attachmentLocalPaths: ["/tmp/a.wav", "/tmp/a.png"],
  voiceTranscripts: ["voice text"],
  voiceTranscriptSources: ["asr"],
});
assert.equal(current?.refIdx, "MSG_IDX");
assert.equal(current?.source, "message_scene.ext");
assert.equal(current?.entry.content, "hello");
assert.equal(current?.entry.senderName, "Member");
assert.equal(current?.entry.attachments?.[0]?.type, "voice");
assert.equal(current?.entry.attachments?.[0]?.transcript, "voice text");
assert.equal(current?.entry.attachments?.[0]?.transcriptSource, "asr");
assert.equal(current?.entry.attachments?.[1]?.localPath, "/tmp/a.png");

const inputNotify = buildCustomCurrentRefIndexRecord({
  event: {
    senderId: "USER_OPENID",
    timestamp: "2026-06-21T00:00:00.000Z",
  },
  inputNotifyRefIdx: "INPUT_REF",
  parsedContent: "c2c",
});
assert.equal(inputNotify?.refIdx, "INPUT_REF");
assert.equal(inputNotify?.source, "InputNotify");
assert.equal(inputNotify?.entry.senderId, "USER_OPENID");

assert.equal(buildCustomCurrentRefIndexRecord({
  event: { senderId: "USER_OPENID", timestamp: "2026-06-21T00:00:00.000Z" },
  parsedContent: "no ref",
}), null);

console.log("custom message reference context tests passed");
