import assert from "node:assert";
import {
  buildCustomInboundContextPayload,
} from "../src/custom/inbound-context-payload.js";

const groupPayload = buildCustomInboundContextPayload({
  event: {
    type: "group",
    senderId: "MEMBER_OPENID",
    senderName: "Luke",
    content: "hello",
    messageId: "MSG_ID",
    timestamp: "2026-06-22T00:00:00.000Z",
    groupOpenid: "GROUP_OPENID",
    channelId: undefined,
    guildId: undefined,
  },
  body: "body",
  agentBody: "agent body",
  fromAddress: "qqbot:group:GROUP_OPENID",
  toAddress: "qqbot:group:GROUP_OPENID",
  sessionKey: "qqbot:group:GROUP_OPENID",
  accountId: "default",
  isGroupChat: true,
  staticSystemPrompts: ["[QQBot]", ""],
  groupSystemPrompt: "group prompt",
  wasMentioned: true,
  senderLabel: "Luke (MEMBER_OPENID)",
  groupSubject: "Master Luke的图书馆",
  hasAsrReferFallback: true,
  voiceTranscriptSources: ["stt", "asr"],
  uniqueVoicePaths: ["/tmp/a.wav"],
  uniqueVoiceUrls: ["https://example.com/a.amr"],
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
});

assert.equal(groupPayload.Body, "body");
assert.equal(groupPayload.BodyForAgent, "agent body");
assert.equal(groupPayload.RawBody, "hello");
assert.equal(groupPayload.From, "qqbot:group:GROUP_OPENID");
assert.equal(groupPayload.To, "qqbot:group:GROUP_OPENID");
assert.equal(groupPayload.ChatType, "group");
assert.equal(groupPayload.GroupSystemPrompt, "[QQBot]\ngroup prompt");
assert.equal(groupPayload.WasMentioned, true);
assert.equal(groupPayload.SenderLabel, "Luke (MEMBER_OPENID)");
assert.equal(groupPayload.GroupSubject, "Master Luke的图书馆");
assert.equal(groupPayload.Provider, "qqbot");
assert.equal(groupPayload.Surface, "qqbot");
assert.equal(groupPayload.MessageSid, "MSG_ID");
assert.equal(groupPayload.Timestamp, 1782086400000);
assert.equal(groupPayload.QQGroupOpenid, "GROUP_OPENID");
assert.equal(groupPayload.QQVoiceAsrReferAvailable, true);
assert.deepEqual(groupPayload.QQVoiceTranscriptSources, ["stt", "asr"]);
assert.deepEqual(groupPayload.MediaPaths, ["/tmp/a.png"]);
assert.equal(groupPayload.MediaPath, "/tmp/a.png");
assert.deepEqual(groupPayload.MediaUrls, ["https://example.com/b.png"]);
assert.equal(groupPayload.ReplyToId, "REF_ID");
assert.equal(groupPayload.CommandAuthorized, false);

const directPayload = buildCustomInboundContextPayload({
  event: {
    type: "c2c",
    senderId: "USER_OPENID",
    content: "private",
    messageId: "C2C_MSG",
    timestamp: "bad timestamp",
  },
  body: "body",
  agentBody: "private",
  fromAddress: "qqbot:c2c:USER_OPENID",
  toAddress: "qqbot:c2c:USER_OPENID",
  sessionKey: "qqbot:c2c:USER_OPENID",
  accountId: "default",
  isGroupChat: false,
  staticSystemPrompts: [],
  groupSystemPrompt: "",
  wasMentioned: true,
  senderLabel: "should not surface",
  groupSubject: "should not surface",
  hasAsrReferFallback: false,
  commandAuthorized: true,
  media: {
    localMediaPaths: [],
    localMediaTypes: [],
    remoteMediaUrls: [],
  },
  quote: {},
});

assert.equal(directPayload.ChatType, "direct");
assert.equal(directPayload.GroupSystemPrompt, undefined);
assert.equal(directPayload.WasMentioned, undefined);
assert.equal(directPayload.SenderLabel, undefined);
assert.equal(directPayload.GroupSubject, undefined);
assert.equal("MediaPaths" in directPayload, false);
assert.equal("MediaUrls" in directPayload, false);
assert.equal("ReplyToId" in directPayload, false);
assert.equal(Number.isNaN(directPayload.Timestamp as number), true);

console.log("custom inbound context payload tests passed");
