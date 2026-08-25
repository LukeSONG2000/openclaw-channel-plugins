import type { DeliverDebouncer } from "../deliver-debounce.js";
import type {
  CustomStreamingFinalizeResult,
  CustomStreamingGatewayController,
  CustomStreamingGatewayLogger,
} from "./streaming-gateway-adapter.js";
import { finalizeCustomStreamingController } from "./streaming-gateway-adapter.js";
import type { CustomDispatchFallbackRecorder } from "./fallback-record-gateway-adapter.js";
import type {
  CustomToolOnlyCompletionFallbackState,
  CustomToolOnlyTimerClearer,
  CustomToolOnlyTimerHandle,
} from "./tool-deliver-gateway-adapter.js";
import { handleCustomToolOnlyCompletionFallback } from "./tool-deliver-gateway-adapter.js";

export interface FinalizeCustomDispatchGatewayParams {
  accountId: string;
  toolOnlyTimer: CustomToolOnlyTimerHandle | null;
  setToolOnlyTimer: (timer: CustomToolOnlyTimerHandle | null) => void;
  fallbackState: CustomToolOnlyCompletionFallbackState;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  sendToolFallback: () => Promise<void>;
  debouncer: DeliverDebouncer | null;
  setDebouncer: (debouncer: DeliverDebouncer | null) => void;
  streamingController: CustomStreamingGatewayController | null | undefined;
  log?: CustomStreamingGatewayLogger;
  clearTimer?: CustomToolOnlyTimerClearer;
}

export interface FinalizeCustomDispatchGatewayResult {
  toolTimerCleared: boolean;
  debouncerDisposed: boolean;
  toolCompletionFallback: "sent" | "skipped";
  streaming: CustomStreamingFinalizeResult;
}

export async function finalizeCustomDispatchGateway(
  params: FinalizeCustomDispatchGatewayParams,
): Promise<FinalizeCustomDispatchGatewayResult> {
  const clearTimer = params.clearTimer ?? clearTimeout;
  let toolTimerCleared = false;
  if (params.toolOnlyTimer) {
    clearTimer(params.toolOnlyTimer);
    params.setToolOnlyTimer(null);
    toolTimerCleared = true;
  }

  const toolCompletion = await handleCustomToolOnlyCompletionFallback({
    accountId: params.accountId,
    state: params.fallbackState,
    recordFallbackEvent: params.recordFallbackEvent,
    sendToolFallback: params.sendToolFallback,
    log: params.log,
  });

  let debouncerDisposed = false;
  if (params.debouncer) {
    await params.debouncer.dispose();
    params.setDebouncer(null);
    debouncerDisposed = true;
  }

  const streaming = await finalizeCustomStreamingController({
    accountId: params.accountId,
    controller: params.streamingController,
    log: params.log,
  });

  return {
    toolTimerCleared,
    debouncerDisposed,
    toolCompletionFallback: toolCompletion.kind === "sent" ? "sent" : "skipped",
    streaming,
  };
}
