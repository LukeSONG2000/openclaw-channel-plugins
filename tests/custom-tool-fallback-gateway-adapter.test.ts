import assert from "node:assert";
import { sendCustomToolFallback } from "../src/custom/tool-fallback-gateway-adapter.js";
import type { CustomDispatchFallbackRecordParams } from "../src/custom/fallback-record-gateway-adapter.js";

const records: CustomDispatchFallbackRecordParams[] = [];
const logs: string[] = [];
const errors: string[] = [];

const recordFallbackEvent = (params: CustomDispatchFallbackRecordParams) => {
  records.push(params);
  return {
    event: {
      type: "custom-fallback" as const,
      kind: params.kind,
      accountId: "default",
      at: 1,
      reason: params.reason,
      details: params.details as any,
    },
    persisted: true,
  };
};

const log = {
  info: (msg: string) => logs.push(msg),
  error: (msg: string) => errors.push(msg),
};

const mediaSends: Array<{ mediaUrl: string; label: string }> = [];
const mediaResult = await sendCustomToolFallback({
  accountId: "default",
  state: {
    toolMediaUrls: ["https://example.test/a.png", "https://example.test/b.png"],
    toolTexts: ["fallback text should not be sent"],
    toolDeliverCount: 2,
  },
  recordFallbackEvent,
  sendGuardedMediaAuto: async (mediaUrl, label) => {
    mediaSends.push({ mediaUrl, label });
    return mediaUrl.endsWith("b.png")
      ? { channel: "qqbot", error: "blocked" }
      : { channel: "qqbot" };
  },
  sendErrorMessage: async () => {
    throw new Error("text fallback should not run for media");
  },
  log,
});
assert.equal(mediaResult.kind, "media");
assert.equal(mediaResult.mediaCount, 2);
assert.equal(mediaResult.mediaResults[1]?.error, "blocked");
assert.deepEqual(mediaSends.map((send) => send.label), ["Tool fallback media", "Tool fallback media"]);
assert.equal(records[0]?.kind, "tool-fallback-media");
assert.equal(errors.some((line) => line.includes("blocked")), true);

const timeoutResult = await sendCustomToolFallback({
  accountId: "default",
  state: {
    toolMediaUrls: ["https://example.test/slow.png"],
    toolTexts: [],
    toolDeliverCount: 1,
  },
  recordFallbackEvent,
  sendGuardedMediaAuto: async () => new Promise(() => {}),
  sendErrorMessage: async () => {
    throw new Error("text fallback should not run for timed-out media");
  },
  log,
  mediaTimeoutMs: 1,
});
assert.equal(timeoutResult.kind, "media");
assert.equal(timeoutResult.mediaResults[0]?.error?.includes("timeout"), true);

const sentTexts: string[] = [];
const textResult = await sendCustomToolFallback({
  accountId: "default",
  state: {
    toolMediaUrls: [],
    toolTexts: ["", " first ", "second"],
    toolDeliverCount: 2,
  },
  recordFallbackEvent,
  sendGuardedMediaAuto: async () => ({ channel: "qqbot" }),
  sendErrorMessage: async (text) => {
    sentTexts.push(text);
  },
  log,
});
assert.equal(textResult.kind, "text");
assert.equal(sentTexts[0], "first\n---\nsecond");
assert.equal(records.find((record) => record.kind === "tool-fallback-text")?.details?.fallbackTextChars, sentTexts[0].length);

const noOutputResult = await sendCustomToolFallback({
  accountId: "default",
  state: {
    toolMediaUrls: [],
    toolTexts: ["  "],
    toolDeliverCount: 3,
  },
  recordFallbackEvent,
  sendGuardedMediaAuto: async () => ({ channel: "qqbot" }),
  sendErrorMessage: async (text) => {
    sentTexts.push(text);
  },
  log,
});
assert.equal(noOutputResult.kind, "no-output");
assert.equal(records.at(-1)?.kind, "tool-fallback-no-output");
assert.equal(sentTexts.at(-1)?.includes("/compact"), true);
assert.equal(logs.some((line) => line.includes("3 tool deliver")), true);

console.log("custom tool fallback gateway adapter tests passed");
