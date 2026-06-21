import type { DeliverDebounceConfig } from "../types.js";
import type {
  DeliverDebouncer,
  DeliverExecutor,
  DeliverInfo,
  DeliverPayload,
} from "../deliver-debounce.js";
import type {
  DeliverAccountContext,
  DeliverEventContext,
  PlainReplyPayload,
  SendWithRetryFn,
} from "../outbound-deliver.js";
import type { ReplyContext } from "../reply-dispatcher.js";
import {
  handleCustomLateDispatchDeliver,
  prepareCustomBlockDeliver,
  type CustomDispatchBlockDeliverState,
} from "./dispatch-deliver-gateway-adapter.js";
import { dispatchCustomDebouncedDeliver, type CustomDeliverDebouncerFactory } from "./deliver-debounce-gateway-adapter.js";
import { applyCustomStaticDeliverGateway, type CustomStaticDeliverHandleStructuredPayload, type CustomStaticDeliverParseMediaTags, type CustomStaticDeliverSendPlainReply } from "./static-deliver-gateway-adapter.js";
import type { CustomFallbackDeliverPayload } from "./fallback-dispatch-state.js";
import type { CustomDispatchFallbackRecorder } from "./fallback-record-gateway-adapter.js";
import { handleCustomToolDeliverGateway, type CustomToolDeliverGatewayState, type CustomToolOnlyTimerClearer, type CustomToolOnlyTimerHandle } from "./tool-deliver-gateway-adapter.js";
import type { CustomToolFallbackLogger, CustomToolFallbackSendMedia } from "./tool-fallback-gateway-adapter.js";
import { handleCustomStreamingDeliver, type CustomStreamingGatewayController } from "./streaming-gateway-adapter.js";

export interface CustomDispatchDeliverCallbackState extends CustomToolDeliverGatewayState, CustomDispatchBlockDeliverState {
  readonly dispatchTimedOut: boolean;
  readonly toolMediaUrls: string[];
  markResponse(): void;
  recordBlockDeliveredMedia(payload: PlainReplyPayload): void;
}

export interface CustomDispatchDeliverCallbackFallbackSession {
  state: CustomDispatchDeliverCallbackState;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  getToolOnlyTimer: () => CustomToolOnlyTimerHandle | null;
  setToolOnlyTimer: (timer: CustomToolOnlyTimerHandle | null) => void;
  toolOnlyTimeoutMs: number;
  maxToolRenewals: number;
  clearResponseTimeout: () => void;
  sendToolFallback: () => Promise<void>;
}

export interface HandleCustomDispatchDeliverCallbackGatewayParams {
  accountId: string;
  message: {
    type: string;
    senderId?: string;
    content?: string;
    msgIdx?: string;
  };
  payload: CustomFallbackDeliverPayload;
  info: DeliverInfo;
  fallbackSession: CustomDispatchDeliverCallbackFallbackSession;
  stopTyping: () => void;
  streamingController: CustomStreamingGatewayController | null | undefined;
  replyContext: ReplyContext;
  deliverEvent: DeliverEventContext;
  deliverAccountContext: DeliverAccountContext;
  sendWithRetry: SendWithRetryFn;
  debouncer: DeliverDebouncer | null;
  setDebouncer: (debouncer: DeliverDebouncer | null) => void;
  debounceConfig: DeliverDebounceConfig | undefined;
  createDebouncer: CustomDeliverDebouncerFactory;
  sendGuardedMediaAuto: CustomToolFallbackSendMedia;
  recordOutboundActivity: () => void;
  parseAndSendMediaTags: CustomStaticDeliverParseMediaTags;
  handleStructuredPayload: CustomStaticDeliverHandleStructuredPayload;
  sendPlainReply: CustomStaticDeliverSendPlainReply;
  log?: CustomToolFallbackLogger & { debug?: (msg: string) => void };
  clearToolOnlyTimer?: CustomToolOnlyTimerClearer;
  handleLateDispatchDeliver?: typeof handleCustomLateDispatchDeliver;
  handleToolDeliver?: typeof handleCustomToolDeliverGateway;
  prepareBlockDeliver?: typeof prepareCustomBlockDeliver;
  handleStreamingDeliver?: typeof handleCustomStreamingDeliver;
  applyStaticDeliver?: typeof applyCustomStaticDeliverGateway;
  dispatchDebouncedDeliver?: typeof dispatchCustomDebouncedDeliver;
}

export type HandleCustomDispatchDeliverCallbackGatewayResult =
  | { kind: "late-ignored" }
  | { kind: "tool"; result: Awaited<ReturnType<typeof handleCustomToolDeliverGateway>> }
  | { kind: "model-skip"; token: string }
  | { kind: "streaming-handled" }
  | { kind: "static"; result: Awaited<ReturnType<typeof dispatchCustomDebouncedDeliver>> };

export async function handleCustomDispatchDeliverCallbackGateway(
  params: HandleCustomDispatchDeliverCallbackGatewayParams,
): Promise<HandleCustomDispatchDeliverCallbackGatewayResult> {
  const fallbackState = params.fallbackSession.state;
  const lateDeliver = (params.handleLateDispatchDeliver ?? handleCustomLateDispatchDeliver)({
    accountId: params.accountId,
    dispatchTimedOut: fallbackState.dispatchTimedOut,
    payload: params.payload,
    info: params.info,
    recordFallbackEvent: params.fallbackSession.recordFallbackEvent,
    log: params.log,
  });
  if (lateDeliver.kind === "late-ignored") {
    return { kind: "late-ignored" };
  }

  fallbackState.markResponse();
  params.log?.info?.(`[qqbot:${params.accountId}] deliver called, kind: ${params.info.kind}, payload keys: ${Object.keys(params.payload).join(", ")}`);

  if (params.info.kind === "tool") {
    const result = await (params.handleToolDeliver ?? handleCustomToolDeliverGateway)({
      accountId: params.accountId,
      payload: params.payload,
      state: fallbackState,
      currentTimer: params.fallbackSession.getToolOnlyTimer(),
      setTimer: params.fallbackSession.setToolOnlyTimer,
      toolOnlyTimeoutMs: params.fallbackSession.toolOnlyTimeoutMs,
      maxToolRenewals: params.fallbackSession.maxToolRenewals,
      recordFallbackEvent: params.fallbackSession.recordFallbackEvent,
      sendGuardedMediaAuto: params.sendGuardedMediaAuto,
      sendToolFallback: params.fallbackSession.sendToolFallback,
      log: params.log,
    });
    return { kind: "tool", result };
  }

  const blockDeliver = (params.prepareBlockDeliver ?? prepareCustomBlockDeliver)({
    accountId: params.accountId,
    payload: params.payload,
    event: {
      type: params.message.type,
      senderId: params.message.senderId,
      content: params.message.content,
    },
    state: fallbackState,
    stopTyping: params.stopTyping,
    clearResponseTimeout: params.fallbackSession.clearResponseTimeout,
    clearToolOnlyTimeout: () => {
      const timer = params.fallbackSession.getToolOnlyTimer();
      if (!timer) return;
      (params.clearToolOnlyTimer ?? clearTimeout)(timer);
      params.fallbackSession.setToolOnlyTimer(null);
    },
    log: params.log,
  });
  if (blockDeliver.kind === "model-skip") {
    return { kind: "model-skip", token: blockDeliver.token };
  }

  const streamingDeliver = await (params.handleStreamingDeliver ?? handleCustomStreamingDeliver)({
    accountId: params.accountId,
    controller: params.streamingController,
    payload: params.payload,
    recordOutboundActivity: params.recordOutboundActivity,
    log: params.log,
  });
  if (streamingDeliver.kind === "handled") {
    return { kind: "streaming-handled" };
  }

  const executeDeliver: DeliverExecutor = async (deliverPayload: DeliverPayload, _deliverInfo: DeliverInfo) => {
    await (params.applyStaticDeliver ?? applyCustomStaticDeliverGateway)({
      deliverPayload,
      replyContext: params.replyContext,
      deliverEvent: params.deliverEvent,
      deliverAccountContext: params.deliverAccountContext,
      sendWithRetry: params.sendWithRetry,
      quoteRef: params.message.msgIdx,
      toolMediaUrls: fallbackState.toolMediaUrls,
      recordBlockDeliveredMedia: (payloadToRecord) => fallbackState.recordBlockDeliveredMedia(payloadToRecord),
      recordOutboundActivity: params.recordOutboundActivity,
      parseAndSendMediaTags: params.parseAndSendMediaTags,
      handleStructuredPayload: params.handleStructuredPayload,
      sendPlainReply: params.sendPlainReply,
    });
  };

  const result = await (params.dispatchDebouncedDeliver ?? dispatchCustomDebouncedDeliver)({
    accountId: params.accountId,
    payload: params.payload,
    info: params.info,
    currentDebouncer: params.debouncer,
    setDebouncer: params.setDebouncer,
    debounceConfig: params.debounceConfig,
    executeDeliver,
    createDebouncer: params.createDebouncer,
    log: params.log as Parameters<typeof dispatchCustomDebouncedDeliver>[0]["log"],
  });
  return { kind: "static", result };
}
