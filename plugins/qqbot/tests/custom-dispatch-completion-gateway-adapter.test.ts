import assert from "node:assert";
import { runCustomDispatchCompletionGateway } from "../src/custom/dispatch-completion-gateway-adapter.js";

function makeSession(overrides: Record<string, unknown> = {}) {
  let toolTimer: unknown = null;
  return {
    state: {
      hasResponse: false,
      hasBlockResponse: false,
      hasModelBlockOutput: false,
      dispatchTimedOut: false,
      toolFallbackSent: false,
      markDispatchTimedOut() {
        this.dispatchTimedOut = true;
      },
      markResponse() {
        this.hasResponse = true;
      },
      ...((overrides.state as Record<string, unknown> | undefined) ?? {}),
    },
    responseTimeoutMs: 300,
    records: [] as unknown[],
    clearCalls: 0,
    recordFallbackEvent(record: unknown) {
      this.records.push(record);
      return {
        event: {
          type: "custom-fallback" as const,
          kind: "response-timeout" as const,
          accountId: "default",
          at: 1,
        },
        persisted: true,
      };
    },
    clearResponseTimeout() {
      this.clearCalls += 1;
    },
    getToolOnlyTimer: () => toolTimer as any,
    setToolOnlyTimer: (timer: unknown) => {
      toolTimer = timer;
    },
    sendToolFallback: async () => {},
    ...overrides,
  } as any;
}

{
  const session = makeSession({
    state: { hasModelBlockOutput: true },
  });
  let finalized = 0;
  let afterFinalize: unknown = null;
  const result = await runCustomDispatchCompletionGateway({
    accountId: "default",
    dispatchPromise: Promise.resolve("ok"),
    timeoutPromise: new Promise(() => {}),
    fallbackSession: session,
    sendErrorMessage: async () => {},
    debouncer: null,
    setDebouncer: () => {},
    streamingController: null,
    finalizeDispatch: async (params) => {
      finalized += 1;
      assert.equal(params.fallbackState, session.state);
      return {
        toolTimerCleared: false,
        debouncerDisposed: false,
        toolCompletionFallback: "skipped",
        streaming: { kind: "no-controller" },
      };
    },
    onAfterFinalize: (summary) => {
      afterFinalize = summary;
    },
  });

  assert.equal(result.raceFailure, undefined);
  assert.equal(result.finalize?.streaming.kind, "no-controller");
  assert.equal(result.afterFinalizeCalled, true);
  assert.deepEqual(afterFinalize, { hasModelBlockOutput: true });
  assert.equal(finalized, 1);
  assert.equal(session.clearCalls, 1);
}

{
  const session = makeSession();
  const sentTexts: string[] = [];
  let raceErr: unknown = null;
  const result = await runCustomDispatchCompletionGateway({
    accountId: "default",
    dispatchPromise: Promise.reject(new Error("Response timeout")),
    timeoutPromise: new Promise(() => {}),
    fallbackSession: session,
    sendErrorMessage: async (text) => {
      sentTexts.push(text);
    },
    debouncer: null,
    setDebouncer: () => {},
    streamingController: null,
    handleRaceFailure: async (params) => {
      raceErr = params.err;
      assert.equal(params.responseTimeoutMs, 300);
      assert.equal(params.state, session.state);
      await params.sendErrorMessage("timeout notice");
      return { kind: "notice-sent", failureKind: "response-timeout" };
    },
    finalizeDispatch: async () => ({
      toolTimerCleared: false,
      debouncerDisposed: false,
      toolCompletionFallback: "skipped",
      streaming: { kind: "no-controller" },
    }),
  });

  assert.equal(result.raceFailure?.kind, "notice-sent");
  assert.equal((raceErr as Error).message, "Response timeout");
  assert.deepEqual(sentTexts, ["timeout notice"]);
  assert.equal(session.clearCalls, 2);
  assert.equal(result.afterFinalizeCalled, false);
}

console.log("custom dispatch completion gateway adapter tests passed");
