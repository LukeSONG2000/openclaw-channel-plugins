import type { InlineKeyboard } from "../types.js";
import type { QueuedMessage } from "../message-queue.js";
import type { QueueSnapshot } from "../slash-commands.js";
import type { CustomRuntimeConfig } from "./types.js";
import type { CustomFallbackDispatchStateSnapshot } from "./fallback-dispatch-state.js";
import {
  buildCustomFallbackEvent,
  formatCustomFallbackEventLog,
  type BuildCustomFallbackEventParams,
  type CustomFallbackEvent,
  type CustomFallbackEventInputDetails,
  type CustomFallbackEventKind,
} from "./fallbacks.js";
import {
  appendCustomFallbackEvent,
  loadCustomFallbackEvents,
  type CustomFallbackEventStoreOptions,
} from "./fallback-event-store.js";
import { buildCustomFallbackAlertDecision } from "./fallback-alerts.js";
import { buildCustomFallbackRecordInput } from "./fallback-record-context.js";

export interface CustomFallbackRecordLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomFallbackAlertDelivery {
  groupOpenid: string;
  text: string;
  keyboard?: InlineKeyboard;
  cooldownKey: string;
  eventCount?: number;
}

export interface CustomFallbackRecordGatewayResult {
  event: CustomFallbackEvent;
  persisted: boolean;
  alert?: {
    sent: boolean;
    reason?: string;
    delivery?: CustomFallbackAlertDelivery;
  };
}

export type CustomFallbackRecordInput =
  | CustomFallbackEvent
  | (Omit<BuildCustomFallbackEventParams, "accountId"> & { accountId?: string });

export interface CustomDispatchFallbackRecordParams {
  kind: CustomFallbackEventKind;
  reason?: string;
  timeoutMs?: number;
  details?: CustomFallbackEventInputDetails;
}

export interface CustomDispatchFallbackRecorderParams {
  accountId: string;
  message: QueuedMessage;
  sessionKey?: string;
  getQueueSnapshot: () => QueueSnapshot;
  getDispatchSnapshot: () => CustomFallbackDispatchStateSnapshot;
  runtime?: CustomRuntimeConfig;
  getRuntime?: () => CustomRuntimeConfig;
  storeOptions?: CustomFallbackEventStoreOptions;
  alertRecentLimit?: number;
  sendAlert?: (delivery: CustomFallbackAlertDelivery) => void | Promise<void>;
  log?: CustomFallbackRecordLogger;
}

export type CustomDispatchFallbackRecorder = (
  params: CustomDispatchFallbackRecordParams,
) => CustomFallbackRecordGatewayResult;

export function createCustomDispatchFallbackRecorder(
  params: CustomDispatchFallbackRecorderParams,
): CustomDispatchFallbackRecorder {
  return (eventParams) => recordCustomFallbackEventGateway({
    accountId: params.accountId,
    runtime: params.getRuntime ? params.getRuntime() : params.runtime,
    storeOptions: params.storeOptions,
    alertRecentLimit: params.alertRecentLimit,
    log: params.log,
    sendAlert: params.sendAlert,
    event: buildCustomFallbackRecordInput({
      ...eventParams,
      message: params.message,
      sessionKey: params.sessionKey,
      queueSnapshot: params.getQueueSnapshot(),
      dispatchSnapshot: params.getDispatchSnapshot(),
    }),
  });
}

export function recordCustomFallbackEventGateway(params: {
  accountId: string;
  event: CustomFallbackRecordInput;
  runtime?: CustomRuntimeConfig;
  storeOptions?: CustomFallbackEventStoreOptions;
  alertRecentLimit?: number;
  sendAlert?: (delivery: CustomFallbackAlertDelivery) => void | Promise<void>;
  log?: CustomFallbackRecordLogger;
}): CustomFallbackRecordGatewayResult {
  const event = normalizeFallbackRecordInput(params.accountId, params.event);
  params.log?.info?.(formatCustomFallbackEventLog(event));

  const persisted = appendCustomFallbackEvent(params.accountId, event, params.storeOptions);
  if (!persisted) {
    params.log?.error?.(`[qqbot:${params.accountId}] Failed to persist custom fallback event: kind=${event.kind} runId=${event.runId ?? ""}`);
    return { event, persisted: false };
  }

  if (!params.runtime) return { event, persisted: true };

  const recentEvents = loadCustomFallbackEvents(params.accountId, {
    ...params.storeOptions,
    limit: params.alertRecentLimit ?? 100,
  });
  const alertDecision = buildCustomFallbackAlertDecision({
    runtime: params.runtime,
    accountId: params.accountId,
    currentEvent: event,
    recentEvents,
    now: event.at,
  });

  if (alertDecision.alert && alertDecision.groupOpenid && alertDecision.text && alertDecision.cooldownKey) {
    const delivery: CustomFallbackAlertDelivery = {
      groupOpenid: alertDecision.groupOpenid,
      text: alertDecision.text,
      keyboard: alertDecision.keyboard,
      cooldownKey: alertDecision.cooldownKey,
      eventCount: alertDecision.eventCount,
    };
    void Promise.resolve(params.sendAlert?.(delivery)).catch((err) => {
      params.log?.error?.(`[qqbot:${params.accountId}] Failed to dispatch custom fallback alert delivery: key=${delivery.cooldownKey} error=${err}`);
    });
    return { event, persisted: true, alert: { sent: Boolean(params.sendAlert), delivery } };
  }

  if (alertDecision.reason && alertDecision.reason !== "below-threshold" && alertDecision.reason !== "kind-not-alerted") {
    params.log?.debug?.(`[qqbot:${params.accountId}] custom fallback alert skipped: reason=${alertDecision.reason} kind=${event.kind}`);
  }

  return {
    event,
    persisted: true,
    alert: { sent: false, reason: alertDecision.reason },
  };
}

function normalizeFallbackRecordInput(
  accountId: string,
  input: CustomFallbackRecordInput,
): CustomFallbackEvent {
  if ("type" in input && input.type === "custom-fallback") {
    return input;
  }
  return buildCustomFallbackEvent({
    ...input,
    accountId: input.accountId ?? accountId,
  });
}
