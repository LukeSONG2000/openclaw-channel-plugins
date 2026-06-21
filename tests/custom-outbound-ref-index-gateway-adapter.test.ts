import assert from "node:assert";
import {
  buildCustomOutboundRefAttachments,
  registerCustomOutboundRefIndexGateway,
} from "../src/custom/outbound-ref-index-gateway-adapter.js";
import type { OutboundMeta } from "../src/api.js";
import type { RefIndexEntry } from "../src/ref-index-store.js";

{
  const logs: string[] = [];
  const voiceAttachments = buildCustomOutboundRefAttachments({
    mediaType: "voice",
    mediaLocalPath: "/tmp/voice/reply.silk",
    ttsText: "这是一段语音回复",
  }, { info: (msg) => logs.push(msg) }, "default");

  assert.deepEqual(voiceAttachments, [{
    type: "voice",
    localPath: "/tmp/voice/reply.silk",
    filename: "reply.silk",
    transcript: "这是一段语音回复",
    transcriptSource: "tts",
  }]);
  assert.equal(logs.some((line) => line.includes("Saving voice transcript")), true);
}

assert.deepEqual(buildCustomOutboundRefAttachments({
  mediaType: "image",
  mediaUrl: "https://example.test/a.png",
}), [{
  type: "image",
  url: "https://example.test/a.png",
}]);

assert.deepEqual(buildCustomOutboundRefAttachments({ text: "plain" }), []);

{
  let registered: ((refIdx: string, meta: OutboundMeta) => void) | null = null;
  const entries = new Map<string, RefIndexEntry>();
  const logs: string[] = [];

  registerCustomOutboundRefIndexGateway({
    accountId: "bot-account",
    onMessageSent: (callback) => { registered = callback; },
    setRefEntry: (refIdx, entry) => { entries.set(refIdx, entry); },
    now: () => 123456,
    log: { info: (msg) => logs.push(msg) },
  });

  assert.equal(typeof registered, "function");
  registered?.("REFIDX_1", {
    text: "hello",
    mediaType: "file",
    mediaLocalPath: "/tmp/report.txt",
    mediaUrl: "https://example.test/report.txt",
  });

  assert.deepEqual(entries.get("REFIDX_1"), {
    content: "hello",
    senderId: "bot-account",
    senderName: "bot-account",
    timestamp: 123456,
    isBot: true,
    attachments: [{
      type: "file",
      localPath: "/tmp/report.txt",
      filename: "report.txt",
      url: "https://example.test/report.txt",
    }],
  });
  assert.equal(logs.some((line) => line.includes("Cached outbound refIdx: REFIDX_1")), true);
}

console.log("custom outbound ref index gateway adapter tests passed");
