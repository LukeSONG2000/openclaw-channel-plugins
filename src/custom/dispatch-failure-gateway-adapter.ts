import {
  classifyCustomDispatchFailure,
  formatCustomContextTooLongNotice,
  formatCustomResponseTimeoutNotice,
  type CustomDispatchFailureKind,
} from "./fallbacks.js";
import type { CustomDispatchFallbackRecorder } from "./fallback-record-gateway-adapter.js";
import type { CustomToolFallbackLogger } from "./tool-fallback-gateway-adapter.js";

const FRAMEWORK_RUNTIME_MODULE_NOTICE = "⚠️ AI 服务暂时不可用：openclaw 框架运行时模块加载失败。\n\n请管理员执行：\nnpm install -g openclaw@latest\nopenclaw gateway restart\n\n斜杠命令（如 /bot-ping）不受影响。";

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

export type HandleCustomDispatchCallbackFailureResult =
  | {
      kind: "framework-runtime-module";
    }
  | {
      kind: "context-too-long";
    }
  | {
      kind: "logged";
      failureKind: CustomDispatchFailureKind;
      category: "auth" | "process";
    };

export type HandleCustomMessageProcessingFailureResult =
  | {
      kind: "framework-runtime-module";
      noticeSent: boolean;
      error?: unknown;
    }
  | {
      kind: "context-too-long";
      noticeSent: boolean;
      error?: unknown;
    }
  | {
      kind: "ignored";
      failureKind: CustomDispatchFailureKind;
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

export async function handleCustomDispatchCallbackFailure(params: {
  accountId: string;
  err: unknown;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  sendErrorMessage: CustomDispatchFailureSendErrorMessage;
  log?: CustomToolFallbackLogger;
}): Promise<HandleCustomDispatchCallbackFailureResult> {
  const errMsg = String(params.err);
  const failureKind = classifyCustomDispatchFailure(params.err);

  if (isFrameworkRuntimeModuleError(errMsg)) {
    params.log?.error?.(`[qqbot:${params.accountId}] ⚠️ openclaw 框架 runtime 模块解析失败，可能是 openclaw 版本与 plugin-sdk 不兼容。请尝试: npm install -g openclaw@latest && openclaw gateway restart`);
    await params.sendErrorMessage(FRAMEWORK_RUNTIME_MODULE_NOTICE);
    return { kind: "framework-runtime-module" };
  }

  if (failureKind === "context-too-long") {
    params.recordFallbackEvent({
      kind: "context-too-long",
      reason: errMsg,
    });
    params.log?.error?.(`[qqbot:${params.accountId}] AI context too long: ${errMsg}`);
    await params.sendErrorMessage(formatCustomContextTooLongNotice());
    return { kind: "context-too-long" };
  }

  if (errMsg.includes("401") || errMsg.includes("key") || errMsg.includes("auth")) {
    params.log?.error?.(`[qqbot:${params.accountId}] AI auth error: ${errMsg}`);
    return { kind: "logged", failureKind, category: "auth" };
  }

  params.log?.error?.(`[qqbot:${params.accountId}] AI process error: ${errMsg}`);
  return { kind: "logged", failureKind, category: "process" };
}

export async function handleCustomMessageProcessingFailure(params: {
  accountId: string;
  err: unknown;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  sendErrorMessage: CustomDispatchFailureSendErrorMessage;
  log?: CustomToolFallbackLogger;
}): Promise<HandleCustomMessageProcessingFailureResult> {
  const errStr = String(params.err);
  const failureKind = classifyCustomDispatchFailure(params.err);
  params.log?.error?.(`[qqbot:${params.accountId}] Message processing failed: ${params.err}`);

  if (isFrameworkRuntimeModuleError(errStr)) {
    try {
      await params.sendErrorMessage(FRAMEWORK_RUNTIME_MODULE_NOTICE);
      return { kind: "framework-runtime-module", noticeSent: true };
    } catch (error) {
      return { kind: "framework-runtime-module", noticeSent: false, error };
    }
  }

  if (failureKind === "context-too-long") {
    params.recordFallbackEvent({
      kind: "context-too-long",
      reason: errStr,
    });
    try {
      await params.sendErrorMessage(formatCustomContextTooLongNotice());
      return { kind: "context-too-long", noticeSent: true };
    } catch (error) {
      return { kind: "context-too-long", noticeSent: false, error };
    }
  }

  return { kind: "ignored", failureKind };
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

function isFrameworkRuntimeModuleError(errText: string): boolean {
  return errText.includes("Unable to resolve plugin runtime module") || errText.includes("root-alias.cjs");
}
