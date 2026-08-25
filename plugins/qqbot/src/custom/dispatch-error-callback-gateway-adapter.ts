import {
  handleCustomDispatchCallbackFailure,
  type HandleCustomDispatchCallbackFailureResult,
} from "./dispatch-failure-gateway-adapter.js";
import type { CustomDispatchFallbackRecorder } from "./fallback-record-gateway-adapter.js";
import {
  handleCustomStreamingError,
  type CustomStreamingErrorResult,
  type CustomStreamingGatewayController,
  type CustomStreamingGatewayLogger,
} from "./streaming-gateway-adapter.js";

export interface CustomDispatchErrorCallbackState {
  markResponse(): void;
}

export interface CustomDispatchErrorCallbackFallbackSession {
  state: CustomDispatchErrorCallbackState;
  clearResponseTimeout: () => void;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
}

export type CustomDispatchErrorCallbackSendText = (text: string) => Promise<void>;

export interface HandleCustomDispatchErrorCallbackGatewayParams {
  accountId: string;
  err: unknown;
  fallbackSession: CustomDispatchErrorCallbackFallbackSession;
  streamingController: CustomStreamingGatewayController | null | undefined;
  sendErrorMessage: CustomDispatchErrorCallbackSendText;
  log?: CustomStreamingGatewayLogger;
  handleStreamingError?: typeof handleCustomStreamingError;
  handleDispatchCallbackFailure?: typeof handleCustomDispatchCallbackFailure;
}

export type HandleCustomDispatchErrorCallbackGatewayResult =
  | {
      kind: "streaming-handled";
      streaming: Extract<CustomStreamingErrorResult, { kind: "handled" }>;
    }
  | {
      kind: "callback-failure";
      streaming: Exclude<CustomStreamingErrorResult, { kind: "handled" }>;
      failure: HandleCustomDispatchCallbackFailureResult;
    };

export async function handleCustomDispatchErrorCallbackGateway(
  params: HandleCustomDispatchErrorCallbackGatewayParams,
): Promise<HandleCustomDispatchErrorCallbackGatewayResult> {
  params.log?.error?.(`[qqbot:${params.accountId}] Dispatch error: ${params.err}`);
  params.fallbackSession.state.markResponse();
  params.fallbackSession.clearResponseTimeout();

  const streaming = await (params.handleStreamingError ?? handleCustomStreamingError)({
    accountId: params.accountId,
    controller: params.streamingController,
    err: params.err,
    log: params.log,
  });
  if (streaming.kind === "handled") {
    return { kind: "streaming-handled", streaming };
  }

  const failure = await (params.handleDispatchCallbackFailure ?? handleCustomDispatchCallbackFailure)({
    accountId: params.accountId,
    err: params.err,
    recordFallbackEvent: params.fallbackSession.recordFallbackEvent,
    sendErrorMessage: params.sendErrorMessage,
    log: params.log,
  });
  return {
    kind: "callback-failure",
    streaming,
    failure,
  };
}
