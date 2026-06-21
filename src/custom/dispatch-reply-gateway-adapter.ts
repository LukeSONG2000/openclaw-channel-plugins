import type {
  DeliverDebouncer,
  DeliverInfo,
  DeliverPayload,
} from "../deliver-debounce.js";
import type { QueuedMessage } from "../message-queue.js";
import type {
  DeliverAccountContext,
  DeliverEventContext,
  SendWithRetryFn,
} from "../outbound-deliver.js";
import type { ReplyContext } from "../reply-dispatcher.js";
import type { ResolvedQQBotAccount } from "../types.js";
import type { DeliverDebounceConfig } from "../types.js";
import {
  handleCustomDispatchDeliverCallbackGateway,
  type CustomDispatchDeliverCallbackFallbackSession,
} from "./dispatch-deliver-callback-gateway-adapter.js";
import {
  handleCustomDispatchErrorCallbackGateway,
  type CustomDispatchErrorCallbackFallbackSession,
} from "./dispatch-error-callback-gateway-adapter.js";
import {
  runCustomDispatchCompletionGateway,
  type CustomDispatchCompletionFallbackSession,
  type CustomDispatchCompletionSummary,
} from "./dispatch-completion-gateway-adapter.js";
import {
  handleCustomMessageProcessingFailure,
  type HandleCustomMessageProcessingFailureResult,
} from "./dispatch-failure-gateway-adapter.js";
import { setupCustomDispatchStreamingGateway } from "./dispatch-streaming-setup-gateway-adapter.js";
import type { CustomDeliverDebouncerFactory } from "./deliver-debounce-gateway-adapter.js";
import type { CustomStaticDeliverHandleStructuredPayload, CustomStaticDeliverParseMediaTags, CustomStaticDeliverSendPlainReply } from "./static-deliver-gateway-adapter.js";
import {
  handleCustomStreamingPartialReply,
  type CustomStreamingGatewayController,
  type CustomStreamingGatewayLogger,
} from "./streaming-gateway-adapter.js";
import type { CustomToolFallbackSendMedia } from "./tool-fallback-gateway-adapter.js";

export type CustomDispatchReplyFallbackSession =
  & CustomDispatchDeliverCallbackFallbackSession
  & CustomDispatchErrorCallbackFallbackSession
  & CustomDispatchCompletionFallbackSession
  & {
      createResponseTimeoutPromise: () => Promise<unknown>;
    };

export interface CustomDispatchReplyMessagesConfig {
  responsePrefix?: string;
}

export interface CustomDispatchReplyDispatcherParams {
  ctx: unknown;
  cfg: unknown;
  dispatcherOptions: {
    responsePrefix?: string;
    deliver: (payload: DeliverPayload, info: DeliverInfo) => Promise<void>;
    onError: (err: unknown) => Promise<void>;
  };
  replyOptions: {
    runId: string;
    disableBlockStreaming: boolean;
    onPartialReply?: (payload: { text?: string }) => Promise<void>;
  };
}

export type CustomDispatchReplyDispatcher = (
  params: CustomDispatchReplyDispatcherParams,
) => Promise<unknown>;

export interface RunCustomDispatchReplyGatewayParams {
  account: ResolvedQQBotAccount;
  event: QueuedMessage;
  cfg: unknown;
  routeAgentId: string;
  ctxPayload: unknown;
  replyAnchorId?: string;
  fallbackSession: CustomDispatchReplyFallbackSession;
  sendErrorMessage: (text: string) => Promise<void>;
  replyContext: ReplyContext;
  deliverEvent: DeliverEventContext;
  deliverAccountContext: DeliverAccountContext;
  sendWithRetry: SendWithRetryFn;
  sendGuardedMediaAuto: CustomToolFallbackSendMedia;
  debounceConfig?: DeliverDebounceConfig;
  createDebouncer: CustomDeliverDebouncerFactory;
  recordOutboundActivity: () => void;
  parseAndSendMediaTags: CustomStaticDeliverParseMediaTags;
  handleStructuredPayload: CustomStaticDeliverHandleStructuredPayload;
  sendPlainReply: CustomStaticDeliverSendPlainReply;
  stopTyping: () => void;
  resolveEffectiveMessagesConfig: (cfg: unknown, agentId: string) => CustomDispatchReplyMessagesConfig;
  dispatchReply: CustomDispatchReplyDispatcher;
  onAfterFinalize?: (summary: CustomDispatchCompletionSummary) => void | Promise<void>;
  log?: CustomStreamingGatewayLogger;
  setupStreaming?: typeof setupCustomDispatchStreamingGateway;
  handleDeliverCallback?: typeof handleCustomDispatchDeliverCallbackGateway;
  handleErrorCallback?: typeof handleCustomDispatchErrorCallbackGateway;
  handlePartialReply?: typeof handleCustomStreamingPartialReply;
  runCompletion?: typeof runCustomDispatchCompletionGateway;
  handleProcessingFailure?: typeof handleCustomMessageProcessingFailure;
}

export interface RunCustomDispatchReplyGatewayResult {
  processingFailure?: HandleCustomMessageProcessingFailureResult;
}

export async function runCustomDispatchReplyGateway(
  params: RunCustomDispatchReplyGatewayParams,
): Promise<RunCustomDispatchReplyGatewayResult> {
  const result: RunCustomDispatchReplyGatewayResult = {};
  let debouncer: DeliverDebouncer | null = null;

  try {
    const messagesConfig = params.resolveEffectiveMessagesConfig(params.cfg, params.routeAgentId);
    const timeoutPromise = params.fallbackSession.createResponseTimeoutPromise();
    const {
      useStreaming,
      streamingController,
    } = (params.setupStreaming ?? setupCustomDispatchStreamingGateway)({
      account: params.account,
      event: params.event,
      replyAnchorId: params.replyAnchorId,
      log: params.log as Parameters<typeof setupCustomDispatchStreamingGateway>[0]["log"],
    });

    params.log?.info?.(`[qqbot:${params.account.accountId}] Dispatching with runId: ${params.event.messageId}`);
    const dispatchPromise = params.dispatchReply({
      ctx: params.ctxPayload,
      cfg: params.cfg,
      dispatcherOptions: {
        responsePrefix: messagesConfig.responsePrefix,
        deliver: async (payload, info) => {
          await (params.handleDeliverCallback ?? handleCustomDispatchDeliverCallbackGateway)({
            accountId: params.account.accountId,
            message: params.event,
            payload,
            info,
            fallbackSession: params.fallbackSession,
            stopTyping: params.stopTyping,
            streamingController: streamingController as CustomStreamingGatewayController | null | undefined,
            replyContext: params.replyContext,
            deliverEvent: params.deliverEvent,
            deliverAccountContext: params.deliverAccountContext,
            sendWithRetry: params.sendWithRetry,
            debouncer,
            setDebouncer: (nextDebouncer) => { debouncer = nextDebouncer; },
            debounceConfig: params.debounceConfig,
            createDebouncer: params.createDebouncer,
            sendGuardedMediaAuto: params.sendGuardedMediaAuto,
            recordOutboundActivity: params.recordOutboundActivity,
            parseAndSendMediaTags: params.parseAndSendMediaTags,
            handleStructuredPayload: params.handleStructuredPayload,
            sendPlainReply: params.sendPlainReply,
            log: params.log,
          });
        },
        onError: async (err) => {
          await (params.handleErrorCallback ?? handleCustomDispatchErrorCallbackGateway)({
            accountId: params.account.accountId,
            err,
            fallbackSession: params.fallbackSession,
            streamingController: streamingController as CustomStreamingGatewayController | null | undefined,
            sendErrorMessage: params.sendErrorMessage,
            log: params.log,
          });
        },
      },
      replyOptions: {
        runId: params.event.messageId,
        disableBlockStreaming: !useStreaming,
        ...(streamingController ? {
          onPartialReply: async (payload: { text?: string }) => {
            await (params.handlePartialReply ?? handleCustomStreamingPartialReply)({
              accountId: params.account.accountId,
              controller: streamingController as CustomStreamingGatewayController,
              payload,
              log: params.log,
            });
          },
        } : {}),
      },
    });

    await (params.runCompletion ?? runCustomDispatchCompletionGateway)({
      accountId: params.account.accountId,
      dispatchPromise,
      timeoutPromise,
      fallbackSession: params.fallbackSession,
      sendErrorMessage: params.sendErrorMessage,
      debouncer,
      setDebouncer: (nextDebouncer) => { debouncer = nextDebouncer; },
      streamingController: streamingController as CustomStreamingGatewayController | null | undefined,
      log: params.log,
      onAfterFinalize: params.onAfterFinalize,
    });
  } catch (err) {
    result.processingFailure = await (params.handleProcessingFailure ?? handleCustomMessageProcessingFailure)({
      accountId: params.account.accountId,
      err,
      recordFallbackEvent: params.fallbackSession.recordFallbackEvent,
      sendErrorMessage: params.sendErrorMessage,
      log: params.log,
    });
  } finally {
    params.stopTyping();
  }

  return result;
}
