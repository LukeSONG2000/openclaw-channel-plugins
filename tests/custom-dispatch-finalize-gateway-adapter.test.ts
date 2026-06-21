import assert from "node:assert";
import { CustomFallbackDispatchState } from "../src/custom/fallback-dispatch-state.js";
import { finalizeCustomDispatchGateway } from "../src/custom/dispatch-finalize-gateway-adapter.js";
import type { CustomDispatchFallbackRecordParams } from "../src/custom/fallback-record-gateway-adapter.js";
import type { CustomStreamingGatewayController } from "../src/custom/streaming-gateway-adapter.js";
import type { CustomToolOnlyTimerHandle } from "../src/custom/tool-deliver-gateway-adapter.js";

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
      },
      persisted: true,
    };
  };
}

class MockStreamingController implements CustomStreamingGatewayController {
  isTerminalPhase = false;
  shouldFallbackToStatic = false;
  currentPhase = "init";
  sentChunkCount_debug = 0;
  completeCalls = 0;
  idleCalls = 0;
  abortCalls = 0;
  async onDeliver(): Promise<void> {}
  async onError(): Promise<void> {}
  async onPartialReply(): Promise<void> {}
  markFullyComplete(): void {
    this.completeCalls += 1;
    this.isTerminalPhase = true;
  }
  async onIdle(): Promise<void> {
    this.idleCalls += 1;
  }
  async abortStreaming(): Promise<void> {
    this.abortCalls += 1;
  }
}

const records: CustomDispatchFallbackRecordParams[] = [];
const state = new CustomFallbackDispatchState();
state.observeToolDeliver({ text: "tool output" });
let timer: CustomToolOnlyTimerHandle | null = makeTimer("timer-1");
const clearedTimers: CustomToolOnlyTimerHandle[] = [];
let fallbackSends = 0;
let debouncerDisposed = 0;
let debouncer: any = {
  dispose: async () => { debouncerDisposed += 1; },
};
const streaming = new MockStreamingController();
const result = await finalizeCustomDispatchGateway({
  accountId: "default",
  toolOnlyTimer: timer,
  setToolOnlyTimer: (next) => { timer = next; },
  fallbackState: state,
  recordFallbackEvent: makeRecorder(records),
  sendToolFallback: async () => { fallbackSends += 1; },
  debouncer,
  setDebouncer: (next) => { debouncer = next; },
  streamingController: streaming,
  clearTimer: (handle) => { clearedTimers.push(handle); },
});
assert.equal(result.toolTimerCleared, true);
assert.equal(timer, null);
assert.equal(clearedTimers.length, 1);
assert.equal(result.toolCompletionFallback, "sent");
assert.equal(records[0]?.kind, "tool-only-complete-no-block");
assert.equal(fallbackSends, 1);
assert.equal(result.debouncerDisposed, true);
assert.equal(debouncerDisposed, 1);
assert.equal(debouncer, null);
assert.equal(result.streaming.kind, "finalized");
assert.equal(streaming.completeCalls, 1);
assert.equal(streaming.idleCalls, 1);

const skippedState = new CustomFallbackDispatchState();
let skippedDebouncer: any = null;
const skippedResult = await finalizeCustomDispatchGateway({
  accountId: "default",
  toolOnlyTimer: null,
  setToolOnlyTimer: () => {
    throw new Error("no timer should not mutate");
  },
  fallbackState: skippedState,
  recordFallbackEvent: makeRecorder(records),
  sendToolFallback: async () => {
    throw new Error("no tool delivers should not fallback");
  },
  debouncer: null,
  setDebouncer: (next) => { skippedDebouncer = next; },
  streamingController: null,
});
assert.equal(skippedResult.toolTimerCleared, false);
assert.equal(skippedResult.toolCompletionFallback, "skipped");
assert.equal(skippedResult.debouncerDisposed, false);
assert.equal(skippedResult.streaming.kind, "no-controller");
assert.equal(skippedDebouncer, null);

console.log("custom dispatch finalize gateway adapter tests passed");
