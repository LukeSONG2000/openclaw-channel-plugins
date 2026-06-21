import assert from "node:assert";
import {
  buildCustomInboundMediaContext,
  formatCustomInboundVoiceSummary,
} from "../src/custom/inbound-media-context.js";

const ctx = buildCustomInboundMediaContext({
  imageUrls: ["/tmp/a.png", "https://example.com/b.jpg", "/tmp/c.gif"],
  imageMediaTypes: ["image/png", "image/jpeg"],
  voiceAttachmentPaths: ["/tmp/v1.wav", "/tmp/v1.wav", "/tmp/v2.wav"],
  voiceAttachmentUrls: ["https://example.com/v.amr", "https://example.com/v.amr"],
  voiceAsrReferTexts: ["你好", "", "你好", "很长".repeat(30)],
  voiceTranscriptSources: ["stt", "asr", "asr", "fallback"],
});

assert.deepEqual(ctx.uniqueVoicePaths, ["/tmp/v1.wav", "/tmp/v2.wav"]);
assert.deepEqual(ctx.uniqueVoiceUrls, ["https://example.com/v.amr"]);
assert.equal(ctx.uniqueVoiceAsrReferTexts.length, 2);
assert.equal(ctx.sttTranscriptCount, 1);
assert.equal(ctx.asrFallbackCount, 2);
assert.equal(ctx.fallbackCount, 1);
assert.equal(ctx.hasAsrReferFallback, true);
assert.deepEqual(ctx.localMediaPaths, ["/tmp/a.png", "/tmp/c.gif"]);
assert.deepEqual(ctx.localMediaTypes, ["image/png", "image/png"]);
assert.deepEqual(ctx.remoteMediaUrls, ["https://example.com/b.jpg"]);
assert.deepEqual(ctx.remoteMediaTypes, ["image/jpeg"]);
assert.equal(ctx.dynamicContext.includes("- 图片: /tmp/a.png, https://example.com/b.jpg, /tmp/c.gif"), true);
assert.equal(ctx.dynamicContext.includes("- 语音: /tmp/v1.wav, /tmp/v2.wav, https://example.com/v.amr"), true);
assert.equal(ctx.dynamicContext.includes("- ASR: 你好 | 很长"), true);
assert.equal(ctx.dynamicContext.endsWith("\n\n"), true);

const summary = formatCustomInboundVoiceSummary({
  media: ctx,
  voiceAttachmentPaths: ["/tmp/v1.wav"],
  voiceAttachmentUrls: [],
  voiceTranscriptCount: 4,
});
assert.equal(summary?.includes("local=2, remote=1"), true);
assert.equal(summary?.includes("asrReferTexts=2, transcripts=4"), true);
assert.equal(summary?.includes("source(stt/asr/fallback)=1/2/1"), true);
assert.equal(summary?.includes("asr_preview=\"你好\""), true);

const textOnly = buildCustomInboundMediaContext({});
assert.deepEqual(textOnly.localMediaPaths, []);
assert.equal(textOnly.dynamicContext, "");
assert.equal(formatCustomInboundVoiceSummary({
  media: textOnly,
  voiceAttachmentPaths: [],
  voiceAttachmentUrls: [],
  voiceTranscriptCount: 0,
}), null);

console.log("custom inbound media context tests passed");
