import assert from "node:assert";
import { handleCustomDispatchDeliverCallbackGateway } from "../src/custom/dispatch-deliver-callback-gateway-adapter.js";

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    dispatchTimedOut: false,
    hasBlockResponse: false,
    toolMediaUrls: ["tool-media"],
    toolFallbackSent: false,
    toolDeliverCount: 0,
    markResponseCalls: 0,
    markBlockResponseCalls: 0,
    recordedBlockPayloads: [] as unknown[],
    markResponse() {
      this.markResponseCalls += 1;
    },
    markBlockResponse() {
      this.markBlockResponseCalls += 1;
    },
    recordBlockDeliveredMedia(payload: unknown) {
      this.recordedBlockPayloads.push(payload);
    },
    observeToolDeliver: () => ({
      toolDeliverCount: 1,
      toolTextChars: 4,
      toolMediaCount: 0,
    }),
    consumeToolMediaForImmediateForward: () => ({ urlsToSend: [], skippedCount: 0 }),
    shouldRenewToolOnlyTimer: () => ({ renew: true, renewalCount: 1 }),
    markToolFallbackSent: () => {},
    ...overrides,
  } as any;
}

function makeSession(state = makeState()) {
  let timer: unknown = null;
  const records: unknown[] = [];
  return {
    state,
    records,
    recordFallbackEvent: (record: unknown) => {
      records.push(record);
      return { event: { type: "custom-fallback", kind: "test", accountId: "default", at: 1 }, persisted: true } as any;
    },
    getToolOnlyTimer: () => timer as any,
    setToolOnlyTimer: (next: unknown) => {
      timer = next;
    },
    toolOnlyTimeoutMs: 90,
    maxToolRenewals: 3,
    clearResponseTimeout: () => {},
    sendToolFallback: async () => {},
  };
}

const baseParams = {
  accountId: "default",
  message: {
    type: "group",
    senderId: "MEMBER_OPENID",
    content: "hello",
    msgIdx: "QUOTE_REF",
  },
  payload: { text: "reply" },
  info: { kind: "block" },
  stopTyping: () => {},
  streamingController: null,
  replyContext: {
    target: { type: "group", senderId: "MEMBER_OPENID", messageId: "MSG", groupOpenid: "GROUP" },
    account: { accountId: "default", appId: "APP", clientSecret: "SECRET" },
    cfg: {},
  } as any,
  deliverEvent: { type: "group", senderId: "MEMBER_OPENID", messageId: "MSG", groupOpenid: "GROUP" } as any,
  deliverAccountContext: {
    account: { accountId: "default", appId: "APP", clientSecret: "SECRET" },
    qualifiedTarget: "qqbot:group:GROUP",
  } as any,
  sendWithRetry: (async <T>(sendFn: (token: string) => Promise<T>) => sendFn("TOKEN")) as any,
  debouncer: null,
  setDebouncer: () => {},
  debounceConfig: undefined,
  createDebouncer: () => null,
  sendGuardedMediaAuto: async () => ({ channel: "qqbot" }),
  recordOutboundActivity: () => {},
  parseAndSendMediaTags: (async () => ({ handled: false, normalizedText: "reply" })) as any,
  handleStructuredPayload: (async () => false) as any,
  sendPlainReply: (async () => {}) as any,
};

{
  const state = makeState({ dispatchTimedOut: true });
  const session = makeSession(state);
  const result = await handleCustomDispatchDeliverCallbackGateway({
    ...baseParams,
    fallbackSession: session,
  });

  assert.equal(result.kind, "late-ignored");
  assert.equal(state.markResponseCalls, 0);
  assert.equal(session.records.length, 1);
}

{
  const state = makeState();
  const session = makeSession(state);
  let toolCalled = 0;
  const result = await handleCustomDispatchDeliverCallbackGateway({
    ...baseParams,
    info: { kind: "tool" },
    payload: { text: "tool" },
    fallbackSession: session,
    handleToolDeliver: async (params) => {
      toolCalled += 1;
      assert.equal(params.currentTimer, null);
      assert.equal(params.toolOnlyTimeoutMs, 90);
      assert.equal(params.maxToolRenewals, 3);
      return {
        kind: "timer-started",
        observation: {
          toolDeliverCount: 1,
          toolTextChars: 4,
          toolMediaCount: 0,
        },
        timer: { id: "timer" } as any,
        renewed: false,
        renewalCount: 0,
      };
    },
  });

  assert.equal(result.kind, "tool");
  assert.equal(toolCalled, 1);
  assert.equal(state.markResponseCalls, 1);
}

{
  const state = makeState();
  const session = makeSession(state);
  let streamingCalled = 0;
  const result = await handleCustomDispatchDeliverCallbackGateway({
    ...baseParams,
    fallbackSession: session,
    prepareBlockDeliver: () => ({ kind: "model-skip", token: "NO_REPLY" }),
    handleStreamingDeliver: async () => {
      streamingCalled += 1;
      return { kind: "no-controller" } as any;
    },
  });

  assert.equal(result.kind, "model-skip");
  assert.equal(result.kind === "model-skip" && result.token, "NO_REPLY");
  assert.equal(streamingCalled, 0);
  assert.equal(state.markResponseCalls, 1);
}

{
  const state = makeState();
  const session = makeSession(state);
  let debouncerSet: unknown = undefined;
  let staticCalled = 0;
  let outboundActivity = 0;
  const result = await handleCustomDispatchDeliverCallbackGateway({
    ...baseParams,
    fallbackSession: session,
    setDebouncer: (next) => {
      debouncerSet = next;
    },
    recordOutboundActivity: () => {
      outboundActivity += 1;
    },
    handleStreamingDeliver: async () => ({ kind: "no-controller" } as any),
    applyStaticDeliver: async (params) => {
      staticCalled += 1;
      assert.equal(params.quoteRef, "QUOTE_REF");
      assert.deepEqual(params.toolMediaUrls, ["tool-media"]);
      params.recordBlockDeliveredMedia(params.deliverPayload);
      params.recordOutboundActivity();
      return { kind: "plain" };
    },
  });

  assert.equal(result.kind, "static");
  assert.equal(result.kind === "static" && result.result.kind, "direct");
  assert.equal(staticCalled, 1);
  assert.equal(outboundActivity, 1);
  assert.equal(debouncerSet, null);
  assert.equal(state.recordedBlockPayloads.length, 1);
}

console.log("custom dispatch deliver callback gateway adapter tests passed");
