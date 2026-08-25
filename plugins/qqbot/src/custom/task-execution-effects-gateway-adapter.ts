import type { CustomSandboxTask } from "./types.js";
import type { CustomTaskExecutionEffect } from "./task-executor-adapter.js";
import {
  applyCustomTaskNotificationDeliveries,
  deliveriesFromCustomTaskNotifications,
  type CustomTaskNotificationDelivery,
  type CustomTaskNotificationDeliveryResult,
  type CustomTaskNotificationSendText,
} from "./task-notification-gateway-adapter.js";

export interface CustomTaskExecutionEffectsRuntime {
  getTask: (taskId: string) => CustomSandboxTask | null;
}

export interface CustomTaskExecutionEffectsLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CollectCustomTaskExecutionEffectDeliveriesParams {
  accountId: string;
  tasks: CustomTaskExecutionEffectsRuntime;
  effects: CustomTaskExecutionEffect[];
  passiveMessageId?: string;
  log?: CustomTaskExecutionEffectsLogger;
}

export interface SendCustomTaskExecutionNotificationDeliveriesParams {
  accountId: string;
  deliveries: CustomTaskNotificationDelivery[];
  allowUnanchored?: boolean;
  sendText: CustomTaskNotificationSendText;
  log?: CustomTaskExecutionEffectsLogger;
}

export interface ApplyCustomTaskAsyncStatusGatewayParams {
  accountId: string;
  tasks: CustomTaskExecutionEffectsRuntime;
  effects: CustomTaskExecutionEffect[];
  persistTaskState: () => void;
  sendText: CustomTaskNotificationSendText;
  allowUnanchored?: boolean;
  log?: CustomTaskExecutionEffectsLogger;
}

export interface ApplyCustomTaskAsyncStatusGatewayResult {
  changed: boolean;
  deliveries: CustomTaskNotificationDelivery[];
  deliveryResults: CustomTaskNotificationDeliveryResult[];
  failed: boolean;
}

export function collectCustomTaskExecutionEffectDeliveries(
  params: CollectCustomTaskExecutionEffectDeliveriesParams,
): CustomTaskNotificationDelivery[] {
  const deliveries: CustomTaskNotificationDelivery[] = [];
  for (const effect of params.effects) {
    logCustomTaskExecutionEffect(params.accountId, effect, params.log);
    if (effect.kind !== "notify" || !effect.notification || !effect.taskId) continue;
    const task = params.tasks.getTask(effect.taskId);
    if (!task) continue;
    deliveries.push(...deliveriesFromCustomTaskNotifications({
      task,
      notifications: [effect.notification],
      passiveMessageId: params.passiveMessageId,
    }));
  }
  return deliveries;
}

export async function sendCustomTaskExecutionNotificationDeliveries(
  params: SendCustomTaskExecutionNotificationDeliveriesParams,
): Promise<CustomTaskNotificationDeliveryResult[]> {
  if (!params.deliveries.length) return [];
  const results = await applyCustomTaskNotificationDeliveries({
    deliveries: params.deliveries,
    allowUnanchored: (delivery) => params.allowUnanchored === true
      && (delivery.target.type === "c2c" || delivery.target.type === "group"),
    sendText: params.sendText,
  });
  for (const result of results) {
    logCustomTaskNotificationDeliveryResult(params.accountId, result, params.log);
  }
  return results;
}

export async function applyCustomTaskAsyncStatusGateway(
  params: ApplyCustomTaskAsyncStatusGatewayParams,
): Promise<ApplyCustomTaskAsyncStatusGatewayResult> {
  const emptyResult: ApplyCustomTaskAsyncStatusGatewayResult = {
    changed: false,
    deliveries: [],
    deliveryResults: [],
    failed: false,
  };
  try {
    if (!params.effects.length) return emptyResult;
    params.persistTaskState();
    const deliveries = collectCustomTaskExecutionEffectDeliveries({
      accountId: params.accountId,
      tasks: params.tasks,
      effects: params.effects,
      log: params.log,
    });
    const deliveryResults = await sendCustomTaskExecutionNotificationDeliveries({
      accountId: params.accountId,
      deliveries,
      allowUnanchored: params.allowUnanchored,
      sendText: params.sendText,
      log: params.log,
    });
    return {
      changed: true,
      deliveries,
      deliveryResults,
      failed: false,
    };
  } catch (err) {
    params.log?.error?.(`[qqbot:${params.accountId}] custom task async status handling failed: ${err}`);
    return { ...emptyResult, failed: true };
  }
}

function logCustomTaskExecutionEffect(
  accountId: string,
  effect: CustomTaskExecutionEffect,
  log?: CustomTaskExecutionEffectsLogger,
): void {
  log?.[effect.kind === "error" ? "error" : "info"]?.(
    `[qqbot:${accountId}] custom task execution: kind=${effect.kind}${effect.taskId ? ` task=${effect.taskId}` : ""}${effect.runId ? ` run=${effect.runId}` : ""}${effect.message ? ` message=${effect.message}` : ""}`,
  );
}

function logCustomTaskNotificationDeliveryResult(
  accountId: string,
  result: CustomTaskNotificationDeliveryResult,
  log?: CustomTaskExecutionEffectsLogger,
): void {
  const target = `${result.delivery.target.type}:${result.delivery.target.groupOpenid ?? result.delivery.target.channelId ?? result.delivery.target.senderId}`;
  if (result.status === "sent") {
    log?.info?.(`[qqbot:${accountId}] custom task notification sent: task=${result.delivery.taskId} audience=${result.delivery.audience} target=${target}`);
  } else if (result.status === "skipped") {
    log?.info?.(`[qqbot:${accountId}] custom task notification skipped: task=${result.delivery.taskId} audience=${result.delivery.audience} target=${target} reason=${result.reason}`);
  } else {
    log?.error?.(`[qqbot:${accountId}] custom task notification failed: task=${result.delivery.taskId} audience=${result.delivery.audience} target=${target} reason=${result.reason}`);
  }
}
