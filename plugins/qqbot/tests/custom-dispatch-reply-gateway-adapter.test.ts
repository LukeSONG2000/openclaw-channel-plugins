import assert from "node:assert";
import { runCustomDispatchReplyGateway } from "../src/custom/dispatch-reply-gateway-adapter.js";

function makeSession() {
  return {
    state: {
      hasResponse: false,
      hasBlockResponse: false,
      hasModelBlockOutput: true,
      dispatchTimedOut: false,
      toolFallbackSent: false,
      toolDeliverCount: 0,
      toolMediaUrls: [],
      markDispatchTimedOut() {},
      markResponse() {
        this.hasResponse = true;
      },
      markBlockResponse() {
        this.hasBlockResponse = true;
      },
      recordBlockDeliveredMedia() {},
      observeToolDeliver: () => ({ toolDeliverCount: 1, toolTextChars: 0, toolMediaCount: 0 }),
      consumeToolMediaForImmediateForward: () => ({ urlsToSend: [], skippedCount: 0 }),
      shouldRenewToolOnlyTimer: () => ({ renew: true, renewalCount: 1 }),
      shouldSendToolFallbackOnComplete: () => false,
      markToolFallbackSent() {},
    },
    responseTimeoutMs: 300,
    recordFallbackEvent: () => ({
      event: { type: "custom-fallback" as const, kind: "response-timeout" as const, accountId: "default", at: 1 },
      persisted: true,
    }),
    clearResponseTimeout: () => {},
    getToolOnlyTimer: () => null,
    setToolOnlyTimer: () => {},
    sendToolFallback: async () => {},
    createResponseTimeoutPromise: () => new Promise(() => {}),
  } as any;
}

const baseParams = {
  account: {
    accountId: "default",
    appId: "APP",
    clientSecret: "SECRET",
    enabled: true,
    config: { streaming: true },
  } as any,
  event: {
    type: "c2c",
    senderId: "USER_OPENID",
    content: "hello",
    messageId: "MSG_ID",
    timestamp: "2026-06-22T00:00:00.000Z",
  } as any,
  cfg: { channels: { qqbot: {} } },
  routeAgentId: "main",
  ctxPayload: { body: "hello" },
  replyAnchorId: "MSG_ID",
  fallbackSession: makeSession(),
  sendErrorMessage: async () => {},
  replyContext: {
    target: { type: "c2c", senderId: "USER_OPENID", messageId: "MSG_ID" },
    account: { accountId: "default", appId: "APP", clientSecret: "SECRET" },
    cfg: {},
  } as any,
  deliverEvent: { type: "c2c", senderId: "USER_OPENID", messageId: "MSG_ID" } as any,
  deliverAccountContext: {
    account: { accountId: "default", appId: "APP", clientSecret: "SECRET" },
    qualifiedTarget: "qqbot:c2c:USER_OPENID",
  } as any,
  sendWithRetry: (async <T>(sendFn: (token: string) => Promise<T>) => sendFn("TOKEN")) as any,
  sendGuardedMediaAuto: async () => ({ channel: "qqbot" }),
  debounceConfig: { windowMs: 1 },
  createDebouncer: () => null,
  recordOutboundActivity: () => {},
  parseAndSendMediaTags: (async () => ({ handled: false, normalizedText: "reply" })) as any,
  handleStructuredPayload: (async () => false) as any,
  sendPlainReply: (async () => {}) as any,
};

{
  const logs: string[] = [];
  const fakeController = { id: "stream" } as any;
  const fakeDebouncer = { dispose: async () => {}, deliver: async () => {} } as any;
  let deliverCalled = 0;
  let partialCalled = 0;
  let completionCalled = 0;
  let stopCalls = 0;
  let afterFinalize: unknown = null;
  let capturedReplyOptions: any = null;

  const result = await runCustomDispatchReplyGateway({
    ...baseParams,
    stopTyping: () => {
      stopCalls += 1;
    },
    resolveEffectiveMessagesConfig: (_cfg, agentId) => {
      assert.equal(agentId, "main");
      return { responsePrefix: "PREFIX" };
    },
    setupStreaming: () => ({
      targetType: "c2c",
      useStreaming: true,
      streamingController: fakeController,
    }),
    dispatchReply: async (input) => {
      assert.equal(input.dispatcherOptions.responsePrefix, "PREFIX");
      capturedReplyOptions = input.replyOptions;
      await input.dispatcherOptions.deliver({ text: "block" }, { kind: "block" });
      await input.replyOptions.onPartialReply?.({ text: "partial" });
      return "dispatch-ok";
    },
    handleDeliverCallback: async (input) => {
      deliverCalled += 1;
      assert.equal(input.streamingController, fakeController);
      assert.equal(input.debouncer, null);
      input.setDebouncer(fakeDebouncer);
      return { kind: "static", result: { kind: "direct" } } as any;
    },
    handlePartialReply: async (input) => {
      partialCalled += 1;
      assert.equal(input.controller, fakeController);
      assert.equal(input.payload.text, "partial");
      return { kind: "handled" };
    },
    runCompletion: async (input) => {
      completionCalled += 1;
      assert.equal(input.debouncer, fakeDebouncer);
      assert.equal(input.streamingController, fakeController);
      await input.dispatchPromise;
      await input.onAfterFinalize?.({ hasModelBlockOutput: true });
      return {
        afterFinalizeCalled: true,
        finalize: {
          toolTimerCleared: false,
          debouncerDisposed: false,
          toolCompletionFallback: "skipped",
          streaming: { kind: "no-controller" },
        },
      };
    },
    onAfterFinalize: (summary) => {
      afterFinalize = summary;
    },
    log: {
      info: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    },
  });

  assert.equal(result.processingFailure, undefined);
  assert.equal(deliverCalled, 1);
  assert.equal(partialCalled, 1);
  assert.equal(completionCalled, 1);
  assert.equal(stopCalls, 1);
  assert.equal(capturedReplyOptions.runId, "MSG_ID");
  assert.equal(capturedReplyOptions.disableBlockStreaming, false);
  assert.deepEqual(afterFinalize, { hasModelBlockOutput: true });
  assert.equal(logs.some((line) => line.includes("Dispatching with runId")), true);
}

{
  let stopCalls = 0;
  let processingErr: unknown = null;
  const result = await runCustomDispatchReplyGateway({
    ...baseParams,
    stopTyping: () => {
      stopCalls += 1;
    },
    resolveEffectiveMessagesConfig: () => ({ responsePrefix: undefined }),
    setupStreaming: () => ({
      targetType: "c2c",
      useStreaming: false,
      streamingController: null,
    }),
    dispatchReply: (() => {
      throw new Error("dispatch setup failed");
    }) as any,
    handleProcessingFailure: async (input) => {
      processingErr = input.err;
      return { kind: "ignored", failureKind: "other" };
    },
  });

  assert.equal(result.processingFailure?.kind, "ignored");
  assert.equal((processingErr as Error).message, "dispatch setup failed");
  assert.equal(stopCalls, 1);
}

console.log("custom dispatch reply gateway adapter tests passed");
