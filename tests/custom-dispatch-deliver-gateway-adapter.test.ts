import assert from "node:assert";
import {
  handleCustomLateDispatchDeliver,
  prepareCustomBlockDeliver,
} from "../src/custom/dispatch-deliver-gateway-adapter.js";
import type { CustomDispatchFallbackRecordParams } from "../src/custom/fallback-record-gateway-adapter.js";

function makeRecorder(records: CustomDispatchFallbackRecordParams[]) {
  return (params: CustomDispatchFallbackRecordParams) => {
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
}

const logs: string[] = [];
const log = {
  info: (msg: string) => logs.push(msg),
  error: (msg: string) => logs.push(msg),
};

const lateRecords: CustomDispatchFallbackRecordParams[] = [];
const late = handleCustomLateDispatchDeliver({
  accountId: "default",
  dispatchTimedOut: true,
  payload: { text: "late text", mediaUrls: ["a", "b"], mediaUrl: "c" },
  info: { kind: "block" },
  recordFallbackEvent: makeRecorder(lateRecords),
  log,
});
assert.equal(late.kind, "late-ignored");
assert.equal(lateRecords[0]?.kind, "late-deliver-after-timeout");
assert.equal(lateRecords[0]?.details?.deliverKind, "block");
assert.equal(lateRecords[0]?.details?.textChars, "late text".length);
assert.equal(lateRecords[0]?.details?.mediaCount, 3);
assert.equal(logs.some((line) => line.includes("Late deliver ignored")), true);

const notLate = handleCustomLateDispatchDeliver({
  accountId: "default",
  dispatchTimedOut: false,
  payload: { text: "on time" },
  info: { kind: "block" },
  recordFallbackEvent: makeRecorder(lateRecords),
});
assert.equal(notLate.kind, "continue");
assert.equal(lateRecords.length, 1);

let blockMarked = false;
let typingStopped = false;
let responseTimeoutCleared = false;
let toolTimeoutCleared = false;
const ready = prepareCustomBlockDeliver({
  accountId: "default",
  payload: { text: "normal response" },
  event: { type: "group", senderId: "MEMBER", content: "hello" },
  state: {
    toolDeliverCount: 2,
    markBlockResponse: () => { blockMarked = true; },
  },
  stopTyping: () => { typingStopped = true; },
  clearResponseTimeout: () => { responseTimeoutCleared = true; },
  clearToolOnlyTimeout: () => { toolTimeoutCleared = true; },
  log,
});
assert.equal(ready.kind, "ready");
assert.equal(ready.toolDeliverCount, 2);
assert.equal(blockMarked, true);
assert.equal(typingStopped, true);
assert.equal(responseTimeoutCleared, true);
assert.equal(toolTimeoutCleared, true);
assert.equal(logs.some((line) => line.includes("Block deliver after 2 tool deliver")), true);

let skipBlockMarked = false;
let skipTypingStopped = false;
let modelSkipMarked = false;
const skipped = prepareCustomBlockDeliver({
  accountId: "default",
  payload: { text: "NO_REPLY" },
  event: { type: "group", senderId: "MEMBER", content: "quiet" },
  state: {
    toolDeliverCount: 0,
    markBlockResponse: () => { skipBlockMarked = true; },
    markModelSkipOutput: () => { modelSkipMarked = true; },
  },
  stopTyping: () => { skipTypingStopped = true; },
  clearResponseTimeout: () => {
    throw new Error("skip should not clear timers");
  },
  clearToolOnlyTimeout: () => {
    throw new Error("skip should not clear timers");
  },
  log,
});
assert.equal(skipped.kind, "model-skip");
assert.equal(skipped.token, "NO_REPLY");
assert.equal(skipBlockMarked, false);
assert.equal(skipTypingStopped, false);
assert.equal(modelSkipMarked, true);

let narrationSkipMarked = false;
const narrationSkipped = prepareCustomBlockDeliver({
  accountId: "default",
  payload: { text: "Vinty发照片那段我刚才已经回了，没啥新话题就先不重复了" },
  event: {
    type: "group",
    senderId: "__qqbot_digest__",
    content: "unread catch-up",
    customUnreadSnapshotId: "snapshot-1",
  },
  state: {
    toolDeliverCount: 0,
    markBlockResponse: () => {
      throw new Error("silent narration should not be marked as visible output");
    },
    markModelSkipOutput: () => { narrationSkipMarked = true; },
  },
  stopTyping: () => {},
  clearResponseTimeout: () => {},
  clearToolOnlyTimeout: () => {},
  log,
});
assert.equal(narrationSkipped.kind, "model-skip");
assert.equal(narrationSkipped.token, "CUSTOM_UNREAD_SILENT");
assert.equal(narrationSkipMarked, true);

const c2cSkipToken = prepareCustomBlockDeliver({
  accountId: "default",
  payload: { text: "NO_REPLY" },
  event: { type: "c2c", senderId: "USER", content: "private" },
  state: {
    toolDeliverCount: 0,
    markBlockResponse: () => {},
  },
  stopTyping: () => {},
  clearResponseTimeout: () => {},
  clearToolOnlyTimeout: () => {},
});
assert.equal(c2cSkipToken.kind, "ready");

console.log("custom dispatch deliver gateway adapter tests passed");
