import type { QueuedMessage } from "../message-queue.js";
import type { QueueSnapshot } from "../slash-commands.js";
import {
  CUSTOM_RESPONSE_TIMEOUT_MS,
  CUSTOM_TOOL_ONLY_MAX_RENEWALS,
  CUSTOM_TOOL_ONLY_TIMEOUT_MS,
} from "./fallbacks.js";
import { CustomFallbackDispatchState } from "./fallback-dispatch-state.js";
import {
  createCustomDispatchFallbackRecorder,
  type CustomDispatchFallbackRecorder,
  type CustomFallbackAlertDelivery,
  type CustomFallbackRecordLogger,
} from "./fallback-record-gateway-adapter.js";
import type { CustomRuntimeConfig } from "./types.js";
import {
  sendCustomToolFallback as defaultSendCustomToolFallback,
  type CustomToolFallbackSendMedia,
  type CustomToolFallbackSendText,
} from "./tool-fallback-gateway-adapter.js";
import type { CustomToolOnlyTimerHandle } from "./tool-deliver-gateway-adapter.js";

export interface CustomDispatchFallbackSessionParams {
  accountId: string;
  message: QueuedMessage;
  sessionKey?: string;
  getRuntime: () => CustomRuntimeConfig;
  getQueueSnapshot: () => QueueSnapshot;
  sendAlert?: (delivery: CustomFallbackAlertDelivery) => void | Promise<void>;
  sendGuardedMediaAuto: CustomToolFallbackSendMedia;
  sendErrorMessage: CustomToolFallbackSendText;
  log?: CustomFallbackRecordLogger;
  responseTimeoutMs?: number;
  toolOnlyTimeoutMs?: number;
  maxToolRenewals?: number;
  scheduleResponseTimeout?: (callback: () => void, delayMs: number) => CustomToolOnlyTimerHandle;
  clearResponseTimeout?: (timer: CustomToolOnlyTimerHandle) => void;
  sendToolFallback?: typeof defaultSendCustomToolFallback;
}

export interface CustomDispatchFallbackSession {
  state: CustomFallbackDispatchState;
  responseTimeoutMs: number;
  toolOnlyTimeoutMs: number;
  maxToolRenewals: number;
  recordFallbackEvent: CustomDispatchFallbackRecorder;
  createResponseTimeoutPromise: () => Promise<void>;
  clearResponseTimeout: () => void;
  getToolOnlyTimer: () => CustomToolOnlyTimerHandle | null;
  setToolOnlyTimer: (timer: CustomToolOnlyTimerHandle | null) => void;
  sendToolFallback: () => Promise<void>;
}

export function createCustomDispatchFallbackSession(
  params: CustomDispatchFallbackSessionParams,
): CustomDispatchFallbackSession {
  const state = new CustomFallbackDispatchState();
  const responseTimeoutMs = params.responseTimeoutMs ?? CUSTOM_RESPONSE_TIMEOUT_MS;
  const toolOnlyTimeoutMs = params.toolOnlyTimeoutMs ?? CUSTOM_TOOL_ONLY_TIMEOUT_MS;
  const maxToolRenewals = params.maxToolRenewals ?? CUSTOM_TOOL_ONLY_MAX_RENEWALS;
  let responseTimeout: CustomToolOnlyTimerHandle | null = null;
  let toolOnlyTimer: CustomToolOnlyTimerHandle | null = null;

  const recordFallbackEvent: CustomDispatchFallbackRecorder = createCustomDispatchFallbackRecorder({
    accountId: params.accountId,
    message: params.message,
    sessionKey: params.sessionKey,
    getRuntime: params.getRuntime,
    getQueueSnapshot: params.getQueueSnapshot,
    getDispatchSnapshot: () => state.snapshot(),
    log: params.log,
    sendAlert: params.sendAlert,
  });

  return {
    state,
    responseTimeoutMs,
    toolOnlyTimeoutMs,
    maxToolRenewals,
    recordFallbackEvent,
    createResponseTimeoutPromise: () => new Promise<void>((_, reject) => {
      const schedule = params.scheduleResponseTimeout ?? setTimeout;
      responseTimeout = schedule(() => {
        if (!state.hasBlockResponse) {
          reject(new Error("Response timeout"));
        }
      }, responseTimeoutMs);
    }),
    clearResponseTimeout: () => {
      if (!responseTimeout) return;
      (params.clearResponseTimeout ?? clearTimeout)(responseTimeout);
      responseTimeout = null;
    },
    getToolOnlyTimer: () => toolOnlyTimer,
    setToolOnlyTimer: (timer) => {
      toolOnlyTimer = timer;
    },
    sendToolFallback: async () => {
      await (params.sendToolFallback ?? defaultSendCustomToolFallback)({
        accountId: params.accountId,
        state,
        recordFallbackEvent,
        sendGuardedMediaAuto: params.sendGuardedMediaAuto,
        sendErrorMessage: params.sendErrorMessage,
        log: params.log,
      });
    },
  };
}
