import type { DeliverDebouncer } from "../deliver-debounce.js";
import {
  finalizeCustomDispatchGateway,
  type FinalizeCustomDispatchGatewayResult,
} from "./dispatch-finalize-gateway-adapter.js";
import {
  handleCustomDispatchRaceFailure,
  type CustomDispatchFailureSendErrorMessage,
  type CustomDispatchFailureState,
  type HandleCustomDispatchRaceFailureResult,
} from "./dispatch-failure-gateway-adapter.js";
import type { CustomDispatchFallbackRecorder } from "./fallback-record-gateway-adapter.js";
import type {
  CustomStreamingGatewayController,
  CustomStreamingGatewayLogger,
} from "./streaming-gateway-adapter.js";
import type {
  CustomToolOnlyCompletionFallbackState,
  CustomToolOnlyTimerHandle,
} from "./tool-deliver-gateway-adapter.js";

export interface CustomDispatchCompletionState extends CustomDispatchFailureState, CustomToolOnlyCompletionFallbackState {
  readonly hasModelBlockOutput: boolean;
  readonly hasModelSkipOutput?: boolean;
}

export interface CustomDispatchCompletionFallbackSession {
  state: CustomDispatchCompletionState;
  responseTimeoutMs: number;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  clearResponseTimeout: () => void;
  getToolOnlyTimer: () => CustomToolOnlyTimerHandle | null;
  setToolOnlyTimer: (timer: CustomToolOnlyTimerHandle | null) => void;
  sendToolFallback: () => Promise<void>;
}

export interface CustomDispatchCompletionSummary {
  hasModelBlockOutput: boolean;
  hasModelSkipOutput?: boolean;
}

export interface RunCustomDispatchCompletionGatewayParams {
  accountId: string;
  dispatchPromise: Promise<unknown>;
  timeoutPromise: Promise<unknown>;
  fallbackSession: CustomDispatchCompletionFallbackSession;
  sendErrorMessage: CustomDispatchFailureSendErrorMessage;
  debouncer: DeliverDebouncer | null;
  setDebouncer: (debouncer: DeliverDebouncer | null) => void;
  streamingController: CustomStreamingGatewayController | null | undefined;
  log?: CustomStreamingGatewayLogger;
  onAfterFinalize?: (summary: CustomDispatchCompletionSummary) => void | Promise<void>;
  handleRaceFailure?: typeof handleCustomDispatchRaceFailure;
  finalizeDispatch?: typeof finalizeCustomDispatchGateway;
}

export interface RunCustomDispatchCompletionGatewayResult {
  raceFailure?: HandleCustomDispatchRaceFailureResult;
  finalize?: FinalizeCustomDispatchGatewayResult;
  afterFinalizeCalled: boolean;
}

export async function runCustomDispatchCompletionGateway(
  params: RunCustomDispatchCompletionGatewayParams,
): Promise<RunCustomDispatchCompletionGatewayResult> {
  const result: RunCustomDispatchCompletionGatewayResult = {
    afterFinalizeCalled: false,
  };
  const fallbackSession = params.fallbackSession;

  try {
    await Promise.race([params.dispatchPromise, params.timeoutPromise]);
  } catch (err) {
    fallbackSession.clearResponseTimeout();
    result.raceFailure = await (params.handleRaceFailure ?? handleCustomDispatchRaceFailure)({
      accountId: params.accountId,
      err,
      responseTimeoutMs: fallbackSession.responseTimeoutMs,
      state: fallbackSession.state,
      recordFallbackEvent: fallbackSession.recordFallbackEvent,
      sendErrorMessage: params.sendErrorMessage,
      log: params.log,
    });
  } finally {
    fallbackSession.clearResponseTimeout();
    result.finalize = await (params.finalizeDispatch ?? finalizeCustomDispatchGateway)({
      accountId: params.accountId,
      toolOnlyTimer: fallbackSession.getToolOnlyTimer(),
      setToolOnlyTimer: fallbackSession.setToolOnlyTimer,
      fallbackState: fallbackSession.state,
      recordFallbackEvent: fallbackSession.recordFallbackEvent,
      sendToolFallback: fallbackSession.sendToolFallback,
      debouncer: params.debouncer,
      setDebouncer: params.setDebouncer,
      streamingController: params.streamingController,
      log: params.log,
    });

    if (params.onAfterFinalize) {
      const completionSummary: CustomDispatchCompletionSummary = {
        hasModelBlockOutput: fallbackSession.state.hasModelBlockOutput,
      };
      if (fallbackSession.state.hasModelSkipOutput === true) {
        completionSummary.hasModelSkipOutput = true;
      }
      await params.onAfterFinalize(completionSummary);
      result.afterFinalizeCalled = true;
    }
  }

  return result;
}
