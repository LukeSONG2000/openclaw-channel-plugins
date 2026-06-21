import type { InlineKeyboard } from "../types.js";
import type { CustomRuntimeConfig } from "./types.js";
import {
  buildCustomFallbackEvent,
  formatCustomFallbackEventLog,
  type BuildCustomFallbackEventParams,
  type CustomFallbackEvent,
} from "./fallbacks.js";
import {
  appendCustomFallbackEvent,
  loadCustomFallbackEvents,
  type CustomFallbackEventStoreOptions,
} from "./fallback-event-store.js";
import { buildCustomFallbackAlertDecision } from "./fallback-alerts.js";

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
