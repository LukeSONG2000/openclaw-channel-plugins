import assert from "node:assert";
import {
  finalizeCustomStreamingController,
  handleCustomStreamingDeliver,
  handleCustomStreamingError,
  handleCustomStreamingPartialReply,
  type CustomStreamingGatewayController,
} from "../src/custom/streaming-gateway-adapter.js";

class MockStreamingController implements CustomStreamingGatewayController {
  isTerminalPhase = false;
  shouldFallbackToStatic = false;
  currentPhase = "init";
  sentChunkCount_debug = 0;
  deliverCalls = 0;
  errorCalls = 0;
  partialCalls = 0;
  completeCalls = 0;
  idleCalls = 0;
  abortCalls = 0;
  failDeliver = false;
  failError = false;
  failPartial = false;
  failIdle = false;

  async onDeliver(): Promise<void> {
    this.deliverCalls += 1;
    if (this.failDeliver) throw new Error("deliver failed");
    this.currentPhase = "deliver";
  }

  async onError(): Promise<void> {
    this.errorCalls += 1;
    if (this.failError) throw new Error("stream error failed");
  }

  async onPartialReply(): Promise<void> {
    this.partialCalls += 1;
    if (this.failPartial) throw new Error("partial failed");
    this.currentPhase = "partial";
  }

  markFullyComplete(): void {
    this.completeCalls += 1;
    this.isTerminalPhase = true;
  }

  async onIdle(): Promise<void> {
    this.idleCalls += 1;
    if (this.failIdle) throw new Error("idle failed");
  }

  async abortStreaming(): Promise<void> {
    this.abortCalls += 1;
    this.isTerminalPhase = true;
  }
}

const debug: string[] = [];
const info: string[] = [];
const errors: string[] = [];
const log = {
  debug: (msg: string) => debug.push(msg),
  info: (msg: string) => info.push(msg),
  error: (msg: string) => errors.push(msg),
};

let activityCount = 0;
const deliverController = new MockStreamingController();
const deliverHandled = await handleCustomStreamingDeliver({
  accountId: "default",
  controller: deliverController,
  payload: { text: "hello streaming" },
  recordOutboundActivity: () => { activityCount += 1; },
  log,
});
assert.equal(deliverHandled.kind, "handled");
assert.equal(deliverController.deliverCalls, 1);
assert.equal(activityCount, 1);
assert.equal(debug.some((line) => line.includes("Streaming deliver entry")), true);

const fallbackController = new MockStreamingController();
fallbackController.shouldFallbackToStatic = true;
const fallbackDeliver = await handleCustomStreamingDeliver({
  accountId: "default",
  controller: fallbackController,
  payload: { text: "fallback" },
  recordOutboundActivity: () => { activityCount += 1; },
  log,
});
assert.equal(fallbackDeliver.kind, "fallback-static");
assert.equal(activityCount, 1);
assert.equal(info.some((line) => line.includes("falling back to static")), true);

const failedDeliverController = new MockStreamingController();
failedDeliverController.failDeliver = true;
const failedDeliver = await handleCustomStreamingDeliver({
  accountId: "default",
  controller: failedDeliverController,
  payload: { text: "bad" },
  recordOutboundActivity: () => { activityCount += 1; },
  log,
});
assert.equal(failedDeliver.kind, "handled");
assert.equal(errors.some((line) => line.includes("Streaming deliver error")), true);

const terminalController = new MockStreamingController();
terminalController.isTerminalPhase = true;
const terminalDeliver = await handleCustomStreamingDeliver({
  accountId: "default",
  controller: terminalController,
  payload: { text: "terminal" },
  recordOutboundActivity: () => { throw new Error("terminal should not record activity"); },
});
assert.equal(terminalDeliver.kind, "no-controller");

const errorController = new MockStreamingController();
const handledError = await handleCustomStreamingError({
  accountId: "default",
  controller: errorController,
  err: new Error("dispatch failed"),
  log,
});
assert.equal(handledError.kind, "handled");
assert.equal(errorController.errorCalls, 1);

const fallbackErrorController = new MockStreamingController();
fallbackErrorController.shouldFallbackToStatic = true;
const fallbackError = await handleCustomStreamingError({
  accountId: "default",
  controller: fallbackErrorController,
  err: new Error("dispatch failed"),
  log,
});
assert.equal(fallbackError.kind, "fallback-static");
assert.equal(info.some((line) => line.includes("Streaming onError")), true);

const failedErrorController = new MockStreamingController();
failedErrorController.failError = true;
const failedError = await handleCustomStreamingError({
  accountId: "default",
  controller: failedErrorController,
  err: new Error("dispatch failed"),
  log,
});
assert.equal(failedError.kind, "handled");
assert.equal(errors.some((line) => line.includes("Streaming onError failed")), true);

const partialController = new MockStreamingController();
const partial = await handleCustomStreamingPartialReply({
  accountId: "default",
  controller: partialController,
  payload: { text: "partial text" },
  log,
});
assert.equal(partial.kind, "handled");
assert.equal(partialController.partialCalls, 1);
assert.equal(debug.some((line) => line.includes("onPartialReply called")), true);

const failedPartialController = new MockStreamingController();
failedPartialController.failPartial = true;
const failedPartial = await handleCustomStreamingPartialReply({
  accountId: "default",
  controller: failedPartialController,
  payload: { text: "bad partial" },
  log,
});
assert.equal(failedPartial.kind, "handled");
assert.equal(errors.some((line) => line.includes("Streaming onPartialReply error")), true);

const finalizeController = new MockStreamingController();
const finalized = await finalizeCustomStreamingController({
  accountId: "default",
  controller: finalizeController,
  log,
});
assert.equal(finalized.kind, "finalized");
assert.equal(finalizeController.completeCalls, 1);
assert.equal(finalizeController.idleCalls, 1);
assert.equal(finalizeController.abortCalls, 0);

const failedFinalizeController = new MockStreamingController();
failedFinalizeController.failIdle = true;
const failedFinalize = await finalizeCustomStreamingController({
  accountId: "default",
  controller: failedFinalizeController,
  log,
});
assert.equal(failedFinalize.kind, "finalized");
assert.equal(failedFinalizeController.abortCalls, 1);
assert.equal(errors.some((line) => line.includes("Streaming finalization error")), true);

const alreadyTerminalController = new MockStreamingController();
alreadyTerminalController.isTerminalPhase = true;
alreadyTerminalController.shouldFallbackToStatic = true;
const alreadyTerminal = await finalizeCustomStreamingController({
  accountId: "default",
  controller: alreadyTerminalController,
  log,
});
assert.equal(alreadyTerminal.kind, "already-terminal");
assert.equal(alreadyTerminal.fallbackToStatic, true);
assert.equal(debug.some((line) => line.includes("degraded to static")), true);

console.log("custom streaming gateway adapter tests passed");
