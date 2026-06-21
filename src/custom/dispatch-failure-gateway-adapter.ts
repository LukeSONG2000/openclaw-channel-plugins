import {
  classifyCustomDispatchFailure,
  formatCustomContextTooLongNotice,
  formatCustomResponseTimeoutNotice,
  type CustomDispatchFailureKind,
} from "./fallbacks.js";
import type { CustomDispatchFallbackRecorder } from "./fallback-record-gateway-adapter.js";
import type { CustomToolFallbackLogger } from "./tool-fallback-gateway-adapter.js";

export interface CustomDispatchFailureState {
  readonly hasResponse: boolean;
  readonly hasBlockResponse: boolean;
  readonly dispatchTimedOut: boolean;
  readonly toolFallbackSent: boolean;
  markDispatchTimedOut(): void;
  markResponse(): void;
}

export type CustomDispatchFailureSendErrorMessage = (text: string) => Promise<void>;

export interface HandleCustomDispatchRaceFailureParams {
  accountId: string;
  err: unknown;
  responseTimeoutMs: number;
  state: CustomDispatchFailureState;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  sendErrorMessage: CustomDispatchFailureSendErrorMessage;
  log?: CustomToolFallbackLogger;
}

export type HandleCustomDispatchRaceFailureResult =
  | {
      kind: "notice-sent";
      failureKind: "response-timeout" | "context-too-long";
    }
  | {
      kind: "notice-failed";
      failureKind: "response-timeout" | "context-too-long";
      error: unknown;
    }
  | {
      kind: "skipped";
      failureKind: CustomDispatchFailureKind;
      reason: "block-response" | "tool-fallback-sent" | "not-recoverable";
    }
  | {
      kind: "ignored";
      failureKind: "other";
    };

export async function handleCustomDispatchRaceFailure(
  params: HandleCustomDispatchRaceFailureParams,
): Promise<HandleCustomDispatchRaceFailureResult> {
  const failureKind = classifyCustomDispatchFailure(params.err);
  if (failureKind === "response-timeout") {
    params.state.markDispatchTimedOut();
  }

  params.log?.error?.(`[qqbot:${params.accountId}] Dispatch failed: ${params.err}${!params.state.hasResponse ? " (no response received)" : ""}`);

  if (failureKind === "response-timeout") {
    if (!params.state.dispatchTimedOut) {
      return { kind: "skipped", failureKind, reason: "not-recoverable" };
    }
    return sendRecoverableDispatchNotice({
      accountId: params.accountId,
      err: params.err,
      state: params.state,
      recordFallbackEvent: params.recordFallbackEvent,
      sendErrorMessage: params.sendErrorMessage,
      log: params.log,
      failureKind,
      eventKind: "response-timeout",
      notice: formatCustomResponseTimeoutNotice(),
      timeoutMs: params.responseTimeoutMs,
      failedLogLabel: "response-timeout",
    });
  }

  if (failureKind === "context-too-long") {
    return sendRecoverableDispatchNotice({
      accountId: params.accountId,
      err: params.err,
      state: params.state,
      recordFallbackEvent: params.recordFallbackEvent,
      sendErrorMessage: params.sendErrorMessage,
      log: params.log,
      failureKind,
      eventKind: "context-too-long",
      notice: formatCustomContextTooLongNotice(),
      failedLogLabel: "context-too-long",
    });
  }

  return { kind: "ignored", failureKind: "other" };
}

async function sendRecoverableDispatchNotice(params: {
  accountId: string;
  err: unknown;
  state: CustomDispatchFailureState;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  sendErrorMessage: CustomDispatchFailureSendErrorMessage;
  log?: CustomToolFallbackLogger;
  failureKind: "response-timeout" | "context-too-long";
  eventKind: "response-timeout" | "context-too-long";
  notice: string;
  timeoutMs?: number;
  failedLogLabel: string;
}): Promise<HandleCustomDispatchRaceFailureResult> {
  if (params.state.hasBlockResponse) {
    return { kind: "skipped", failureKind: params.failureKind, reason: "block-response" };
  }
  if (params.state.toolFallbackSent) {
    return { kind: "skipped", failureKind: params.failureKind, reason: "tool-fallback-sent" };
  }

  params.recordFallbackEvent({
    kind: params.eventKind,
    reason: String(params.err),
    timeoutMs: params.timeoutMs,
  });
  try {
    await params.sendErrorMessage(params.notice);
    params.state.markResponse();
    return { kind: "notice-sent", failureKind: params.failureKind };
  } catch (sendErr) {
    params.log?.error?.(`[qqbot:${params.accountId}] Failed to send ${params.failedLogLabel} notice: ${sendErr}`);
    return {
      kind: "notice-failed",
      failureKind: params.failureKind,
      error: sendErr,
    };
  }
}
