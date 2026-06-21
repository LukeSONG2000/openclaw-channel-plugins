import assert from "node:assert";
import { CustomFallbackDispatchState } from "../src/custom/fallback-dispatch-state.js";
import { handleCustomDispatchRaceFailure } from "../src/custom/dispatch-failure-gateway-adapter.js";
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
        timeoutMs: params.timeoutMs,
      },
      persisted: true,
    };
  };
}

const logs: string[] = [];
const errors: string[] = [];
const log = {
  info: (msg: string) => logs.push(msg),
  error: (msg: string) => errors.push(msg),
};

const timeoutRecords: CustomDispatchFallbackRecordParams[] = [];
const timeoutState = new CustomFallbackDispatchState();
const timeoutTexts: string[] = [];
const timeoutResult = await handleCustomDispatchRaceFailure({
  accountId: "default",
  err: new Error("Response timeout"),
  responseTimeoutMs: 300_000,
  state: timeoutState,
  recordFallbackEvent: makeRecorder(timeoutRecords),
  sendErrorMessage: async (text) => { timeoutTexts.push(text); },
  log,
});
assert.equal(timeoutResult.kind, "notice-sent");
assert.equal(timeoutResult.kind === "notice-sent" && timeoutResult.failureKind, "response-timeout");
assert.equal(timeoutState.dispatchTimedOut, true);
assert.equal(timeoutState.hasResponse, true);
assert.equal(timeoutRecords[0]?.kind, "response-timeout");
assert.equal(timeoutRecords[0]?.timeoutMs, 300_000);
assert.equal(timeoutTexts[0]?.includes("/new"), true);
assert.equal(errors.some((line) => line.includes("Dispatch failed")), true);

const contextRecords: CustomDispatchFallbackRecordParams[] = [];
const contextState = new CustomFallbackDispatchState();
const contextTexts: string[] = [];
const contextResult = await handleCustomDispatchRaceFailure({
  accountId: "default",
  err: "maximum context length is 128000 tokens",
  responseTimeoutMs: 300_000,
  state: contextState,
  recordFallbackEvent: makeRecorder(contextRecords),
  sendErrorMessage: async (text) => { contextTexts.push(text); },
  log,
});
assert.equal(contextResult.kind, "notice-sent");
assert.equal(contextResult.kind === "notice-sent" && contextResult.failureKind, "context-too-long");
assert.equal(contextState.hasResponse, true);
assert.equal(contextRecords[0]?.kind, "context-too-long");
assert.equal(contextTexts[0]?.includes("/compact"), true);

const blockedRecords: CustomDispatchFallbackRecordParams[] = [];
const blockedState = new CustomFallbackDispatchState();
blockedState.markBlockResponse();
const blockedResult = await handleCustomDispatchRaceFailure({
  accountId: "default",
  err: new Error("Response timeout"),
  responseTimeoutMs: 300_000,
  state: blockedState,
  recordFallbackEvent: makeRecorder(blockedRecords),
  sendErrorMessage: async () => {
    throw new Error("notice should not be sent after block");
  },
});
assert.equal(blockedResult.kind, "skipped");
assert.equal(blockedResult.kind === "skipped" && blockedResult.reason, "block-response");
assert.equal(blockedRecords.length, 0);

const toolFallbackRecords: CustomDispatchFallbackRecordParams[] = [];
const toolFallbackState = new CustomFallbackDispatchState();
toolFallbackState.markToolFallbackSent();
const toolFallbackResult = await handleCustomDispatchRaceFailure({
  accountId: "default",
  err: "context_length_exceeded",
  responseTimeoutMs: 300_000,
  state: toolFallbackState,
  recordFallbackEvent: makeRecorder(toolFallbackRecords),
  sendErrorMessage: async () => {
    throw new Error("notice should not be sent after tool fallback");
  },
});
assert.equal(toolFallbackResult.kind, "skipped");
assert.equal(toolFallbackResult.kind === "skipped" && toolFallbackResult.reason, "tool-fallback-sent");
assert.equal(toolFallbackRecords.length, 0);

const failedRecords: CustomDispatchFallbackRecordParams[] = [];
const failedState = new CustomFallbackDispatchState();
const failedResult = await handleCustomDispatchRaceFailure({
  accountId: "default",
  err: "input is too long",
  responseTimeoutMs: 300_000,
  state: failedState,
  recordFallbackEvent: makeRecorder(failedRecords),
  sendErrorMessage: async () => {
    throw new Error("send failed");
  },
  log,
});
assert.equal(failedResult.kind, "notice-failed");
assert.equal(failedState.hasResponse, false);
assert.equal(failedRecords[0]?.kind, "context-too-long");
assert.equal(errors.some((line) => line.includes("Failed to send context-too-long notice")), true);

const otherRecords: CustomDispatchFallbackRecordParams[] = [];
const otherResult = await handleCustomDispatchRaceFailure({
  accountId: "default",
  err: new Error("provider failed"),
  responseTimeoutMs: 300_000,
  state: new CustomFallbackDispatchState(),
  recordFallbackEvent: makeRecorder(otherRecords),
  sendErrorMessage: async () => {
    throw new Error("other failure should not send fallback notice");
  },
});
assert.equal(otherResult.kind, "ignored");
assert.equal(otherRecords.length, 0);

console.log("custom dispatch failure gateway adapter tests passed");
