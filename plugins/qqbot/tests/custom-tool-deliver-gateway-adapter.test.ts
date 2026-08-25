import assert from "node:assert";
import { CustomFallbackDispatchState } from "../src/custom/fallback-dispatch-state.js";
import {
  handleCustomToolDeliverGateway,
  handleCustomToolOnlyCompletionFallback,
  type CustomToolOnlyTimerHandle,
} from "../src/custom/tool-deliver-gateway-adapter.js";
import type { CustomDispatchFallbackRecordParams } from "../src/custom/fallback-record-gateway-adapter.js";

function makeTimer(id: string): CustomToolOnlyTimerHandle {
  return { id } as unknown as CustomToolOnlyTimerHandle;
}

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

const records: CustomDispatchFallbackRecordParams[] = [];
let currentTimer: CustomToolOnlyTimerHandle | null = null;
const scheduled: Array<{ callback: () => void; delayMs: number; timer: CustomToolOnlyTimerHandle }> = [];
const state = new CustomFallbackDispatchState();
let fallbackSendCount = 0;
const timerStarted = await handleCustomToolDeliverGateway({
  accountId: "default",
  payload: { text: " tool progress " },
  state,
  currentTimer,
  setTimer: (timer) => { currentTimer = timer; },
  toolOnlyTimeoutMs: 90_000,
  maxToolRenewals: 3,
  recordFallbackEvent: makeRecorder(records),
  sendGuardedMediaAuto: async () => ({ channel: "qqbot" }),
  sendToolFallback: async () => { fallbackSendCount += 1; },
  log,
  scheduleTimer: (callback, delayMs) => {
    const timer = makeTimer(`timer-${scheduled.length + 1}`);
    scheduled.push({ callback, delayMs, timer });
    return timer;
  },
});
assert.equal(timerStarted.kind, "timer-started");
assert.equal(timerStarted.renewed, false);
assert.equal(scheduled[0]?.delayMs, 90_000);
assert.equal(currentTimer, scheduled[0]?.timer);
assert.equal(state.snapshot().toolDeliverCount, 1);

scheduled[0]!.callback();
await Promise.resolve();
assert.equal(state.toolFallbackSent, true);
assert.equal(records[0]?.kind, "tool-only-timeout");
assert.equal(records[0]?.timeoutMs, 90_000);
assert.equal(fallbackSendCount, 1);
assert.equal(errors.some((line) => line.includes("Tool-only timeout")), true);

const renewalState = new CustomFallbackDispatchState();
let renewalTimer: CustomToolOnlyTimerHandle | null = null;
const renewalScheduled: CustomToolOnlyTimerHandle[] = [];
const cleared: CustomToolOnlyTimerHandle[] = [];
await handleCustomToolDeliverGateway({
  accountId: "default",
  payload: { text: "first" },
  state: renewalState,
  currentTimer: renewalTimer,
  setTimer: (timer) => { renewalTimer = timer; },
  toolOnlyTimeoutMs: 10,
  maxToolRenewals: 3,
  recordFallbackEvent: makeRecorder([]),
  sendGuardedMediaAuto: async () => ({ channel: "qqbot" }),
  sendToolFallback: async () => {},
  scheduleTimer: () => {
    const timer = makeTimer(`renewal-${renewalScheduled.length + 1}`);
    renewalScheduled.push(timer);
    return timer;
  },
});
const firstRenewalTimer = renewalTimer;
const renewed = await handleCustomToolDeliverGateway({
  accountId: "default",
  payload: { text: "second" },
  state: renewalState,
  currentTimer: renewalTimer,
  setTimer: (timer) => { renewalTimer = timer; },
  toolOnlyTimeoutMs: 10,
  maxToolRenewals: 3,
  recordFallbackEvent: makeRecorder([]),
  sendGuardedMediaAuto: async () => ({ channel: "qqbot" }),
  sendToolFallback: async () => {},
  log,
  scheduleTimer: () => {
    const timer = makeTimer(`renewal-${renewalScheduled.length + 1}`);
    renewalScheduled.push(timer);
    return timer;
  },
  clearTimer: (timer) => { cleared.push(timer); },
});
assert.equal(renewed.kind, "timer-started");
assert.equal(renewed.renewed, true);
assert.equal(renewed.renewalCount, 1);
assert.equal(cleared[0], firstRenewalTimer);
assert.equal(renewalTimer, renewalScheduled[1]);

const limitState = new CustomFallbackDispatchState();
let limitTimer: CustomToolOnlyTimerHandle | null = makeTimer("limit-existing");
const existingLimitTimer = limitTimer;
const limitResult = await handleCustomToolDeliverGateway({
  accountId: "default",
  payload: { text: "limit" },
  state: limitState,
  currentTimer: limitTimer,
  setTimer: (timer) => { limitTimer = timer; },
  toolOnlyTimeoutMs: 10,
  maxToolRenewals: 0,
  recordFallbackEvent: makeRecorder([]),
  sendGuardedMediaAuto: async () => ({ channel: "qqbot" }),
  sendToolFallback: async () => {},
  log,
  scheduleTimer: () => {
    throw new Error("timer should not be renewed past limit");
  },
});
assert.equal(limitResult.kind, "timer-renewal-limit");
assert.equal(limitTimer, existingLimitTimer);
assert.equal(logs.some((line) => line.includes("renewal limit reached")), true);

const mediaState = new CustomFallbackDispatchState();
mediaState.markBlockResponse();
const mediaSends: string[] = [];
const mediaResult = await handleCustomToolDeliverGateway({
  accountId: "default",
  payload: { mediaUrls: ["https://example.test/a.png", "https://example.test/b.png"] },
  state: mediaState,
  currentTimer: null,
  setTimer: () => {},
  toolOnlyTimeoutMs: 10,
  maxToolRenewals: 3,
  recordFallbackEvent: makeRecorder([]),
  sendGuardedMediaAuto: async (mediaUrl) => {
    mediaSends.push(mediaUrl);
    return mediaUrl.endsWith("b.png") ? { channel: "qqbot", error: "blocked" } : { channel: "qqbot" };
  },
  sendToolFallback: async () => {},
  log,
});
assert.equal(mediaResult.kind, "immediate-media-forward");
assert.deepEqual(mediaSends, ["https://example.test/a.png", "https://example.test/b.png"]);
assert.equal(errors.some((line) => line.includes("Tool media immediate forward error: blocked")), true);

const skippedState = new CustomFallbackDispatchState();
skippedState.markBlockResponse();
skippedState.recordBlockDeliveredMedia({ mediaUrl: "https://example.test/already.png" });
const skippedResult = await handleCustomToolDeliverGateway({
  accountId: "default",
  payload: { mediaUrl: "https://example.test/already.png" },
  state: skippedState,
  currentTimer: null,
  setTimer: () => {},
  toolOnlyTimeoutMs: 10,
  maxToolRenewals: 3,
  recordFallbackEvent: makeRecorder([]),
  sendGuardedMediaAuto: async () => {
    throw new Error("deduped media should not be sent");
  },
  sendToolFallback: async () => {},
  log,
});
assert.equal(skippedResult.kind, "immediate-media-skipped");
assert.equal(skippedResult.skippedCount, 1);

const sentState = new CustomFallbackDispatchState();
sentState.markToolFallbackSent();
const sentResult = await handleCustomToolDeliverGateway({
  accountId: "default",
  payload: { text: "after fallback" },
  state: sentState,
  currentTimer: null,
  setTimer: () => {
    throw new Error("timer should not be set after fallback");
  },
  toolOnlyTimeoutMs: 10,
  maxToolRenewals: 3,
  recordFallbackEvent: makeRecorder([]),
  sendGuardedMediaAuto: async () => ({ channel: "qqbot" }),
  sendToolFallback: async () => {},
});
assert.equal(sentResult.kind, "fallback-already-sent");

const completionState = new CustomFallbackDispatchState();
completionState.observeToolDeliver({ text: "done without block" });
const completionRecords: CustomDispatchFallbackRecordParams[] = [];
let completionFallbackSends = 0;
const completionResult = await handleCustomToolOnlyCompletionFallback({
  accountId: "default",
  state: completionState,
  recordFallbackEvent: makeRecorder(completionRecords),
  sendToolFallback: async () => { completionFallbackSends += 1; },
  log,
});
assert.equal(completionResult.kind, "sent");
assert.equal(completionResult.kind === "sent" && completionResult.toolDeliverCount, 1);
assert.equal(completionState.toolFallbackSent, true);
assert.equal(completionFallbackSends, 1);
assert.equal(completionRecords[0]?.kind, "tool-only-complete-no-block");

const completionSkipped = await handleCustomToolOnlyCompletionFallback({
  accountId: "default",
  state: completionState,
  recordFallbackEvent: makeRecorder(completionRecords),
  sendToolFallback: async () => { completionFallbackSends += 1; },
});
assert.equal(completionSkipped.kind, "skipped");
assert.equal(completionFallbackSends, 1);

console.log("custom tool deliver gateway adapter tests passed");
