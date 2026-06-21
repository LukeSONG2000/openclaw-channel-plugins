import assert from "node:assert";
import { handleCustomDispatchErrorCallbackGateway } from "../src/custom/dispatch-error-callback-gateway-adapter.js";
import type { CustomStreamingErrorResult } from "../src/custom/streaming-gateway-adapter.js";

function makeSession() {
  const records: unknown[] = [];
  return {
    state: {
      markResponseCalls: 0,
      markResponse() {
        this.markResponseCalls += 1;
      },
    },
    clearCalls: 0,
    clearResponseTimeout() {
      this.clearCalls += 1;
    },
    records,
    recordFallbackEvent(record: unknown) {
      records.push(record);
      return {
        event: {
          type: "custom-fallback" as const,
          kind: "context-too-long" as const,
          accountId: "default",
          at: 1,
        },
        persisted: true,
      };
    },
  };
}

{
  const session = makeSession();
  const errors: string[] = [];
  let failureCalled = 0;
  const result = await handleCustomDispatchErrorCallbackGateway({
    accountId: "default",
    err: new Error("stream handled"),
    fallbackSession: session,
    streamingController: {} as any,
    sendErrorMessage: async () => {
      throw new Error("streaming handled should not send fallback");
    },
    log: {
      error: (msg) => errors.push(msg),
    },
    handleStreamingError: async (): Promise<CustomStreamingErrorResult> => ({ kind: "handled" }),
    handleDispatchCallbackFailure: async () => {
      failureCalled += 1;
      return { kind: "logged", failureKind: "other", category: "process" };
    },
  });

  assert.equal(result.kind, "streaming-handled");
  assert.equal(session.state.markResponseCalls, 1);
  assert.equal(session.clearCalls, 1);
  assert.equal(failureCalled, 0);
  assert.equal(errors.some((line) => line.includes("Dispatch error")), true);
}

{
  const session = makeSession();
  const sentTexts: string[] = [];
  let streamingErr: unknown = null;
  let fallbackErr: unknown = null;
  const result = await handleCustomDispatchErrorCallbackGateway({
    accountId: "default",
    err: "maximum context length exceeded",
    fallbackSession: session,
    streamingController: null,
    sendErrorMessage: async (text) => {
      sentTexts.push(text);
    },
    handleStreamingError: async (params): Promise<CustomStreamingErrorResult> => {
      streamingErr = params.err;
      return { kind: "no-controller" };
    },
    handleDispatchCallbackFailure: async (params) => {
      fallbackErr = params.err;
      await params.sendErrorMessage("fallback text");
      params.recordFallbackEvent({ kind: "context-too-long" });
      return { kind: "context-too-long" };
    },
  });

  assert.equal(result.kind, "callback-failure");
  assert.equal(result.kind === "callback-failure" && result.streaming.kind, "no-controller");
  assert.equal(result.kind === "callback-failure" && result.failure.kind, "context-too-long");
  assert.equal(streamingErr, "maximum context length exceeded");
  assert.equal(fallbackErr, "maximum context length exceeded");
  assert.deepEqual(sentTexts, ["fallback text"]);
  assert.equal(session.records.length, 1);
  assert.equal(session.state.markResponseCalls, 1);
  assert.equal(session.clearCalls, 1);
}

console.log("custom dispatch error callback gateway adapter tests passed");
