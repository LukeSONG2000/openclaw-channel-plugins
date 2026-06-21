import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { InlineKeyboard } from "../types.js";
import {
  applyCustomRuntimeAdminBindingsToConfig,
  clearCustomRuntimeInitBindChallengeFromConfig,
  resolveCustomRuntimeConfig,
} from "./config.js";
import { upsertCustomSceneConfig } from "./scene-gateway-adapter.js";
import type { CustomSlashGatewayResult } from "./slash-gateway-adapter.js";
import {
  deliverCustomSlashGatewayReply,
  type CustomSlashAdminGroupNotification,
} from "./slash-reply-delivery-gateway-adapter.js";
import {
  applyCustomTaskNotificationDeliveries,
  type CustomTaskNotificationDelivery,
  type CustomTaskNotificationDeliveryResult,
  type CustomTaskNotificationSendText,
} from "./task-notification-gateway-adapter.js";

export type CustomSlashGatewayHandledResult = Extract<CustomSlashGatewayResult, { handled: true }>;

export interface CustomSlashGatewayEffectsLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CustomSlashGatewayConfigApi {
  loadConfig?: () => Record<string, unknown>;
  writeConfigFile: (cfg: unknown) => Promise<void>;
}

export interface ApplyCustomSlashGatewayEffectsParams {
  accountId: string;
  cfg: OpenClawConfig;
  result: CustomSlashGatewayHandledResult;
  log?: CustomSlashGatewayEffectsLogger;
  getConfigApi?: () => CustomSlashGatewayConfigApi;
  persistAuthState?: () => void;
  persistTaskState?: () => void;
  persistPollState?: () => void;
  persistGameState?: () => void;
  persistDeployConfirmationState?: () => void;
  sendText: (text: string) => Promise<void>;
  sendKeyboard: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
  sendAdminGroupNotification?: (notification: CustomSlashAdminGroupNotification) => Promise<void>;
  sendTaskNotificationText?: CustomTaskNotificationSendText;
}

export interface ApplyCustomSlashGatewayEffectsResult {
  authPersisted: boolean;
  configPersisted: boolean;
  tasksPersisted: boolean;
  pollsPersisted: boolean;
  gamesPersisted: boolean;
  deployConfirmationsPersisted: boolean;
  replyDelivered: boolean;
  replyFailed: boolean;
  taskNotificationResults: CustomTaskNotificationDeliveryResult[];
}

export async function applyCustomSlashGatewayEffects(
  params: ApplyCustomSlashGatewayEffectsParams,
): Promise<ApplyCustomSlashGatewayEffectsResult> {
  const result: ApplyCustomSlashGatewayEffectsResult = {
    authPersisted: false,
    configPersisted: false,
    tasksPersisted: false,
    pollsPersisted: false,
    gamesPersisted: false,
    deployConfirmationsPersisted: false,
    replyDelivered: false,
    replyFailed: false,
    taskNotificationResults: [],
  };

  logCustomSlashGatewayResult(params);

  const persist = params.result.persist;
  if (persist?.auth) {
    requireCallback(params.persistAuthState, "persistAuthState")();
    result.authPersisted = true;
  }
  if (persist?.config) {
    await persistCustomSlashConfig(params);
    result.configPersisted = true;
  }
  if (persist?.initBind) {
    await persistCustomInitBindConfig(params);
    result.configPersisted = true;
  }
  if (persist?.tasks) {
    requireCallback(params.persistTaskState, "persistTaskState")();
    result.tasksPersisted = true;
  }
  if (persist?.polls) {
    requireCallback(params.persistPollState, "persistPollState")();
    result.pollsPersisted = true;
  }
  if (persist?.games) {
    requireCallback(params.persistGameState, "persistGameState")();
    result.gamesPersisted = true;
  }
  if (persist?.deployConfirmations) {
    requireCallback(params.persistDeployConfirmationState, "persistDeployConfirmationState")();
    result.deployConfirmationsPersisted = true;
  }

  if (params.result.reply) {
    try {
      await deliverCustomSlashGatewayReply({
        accountId: params.accountId,
        reply: params.result.reply,
        sendText: params.sendText,
        sendKeyboard: params.sendKeyboard,
        sendAdminGroupNotification: params.sendAdminGroupNotification,
        log: params.log,
      });
      result.replyDelivered = true;
    } catch (sendErr) {
      result.replyFailed = true;
      params.log?.error?.(`[qqbot:${params.accountId}] Failed to send custom slash command reply: ${sendErr}`);
    }
  }

  result.taskNotificationResults = await deliverCustomSlashTaskNotifications(params);
  return result;
}

function logCustomSlashGatewayResult(params: ApplyCustomSlashGatewayEffectsParams): void {
  for (const item of params.result.logs ?? []) {
    if (item.level === "error") {
      params.log?.error?.(`[qqbot:${params.accountId}] ${item.message}`);
    } else {
      params.log?.info?.(`[qqbot:${params.accountId}] ${item.message}`);
    }
  }
}

async function persistCustomInitBindConfig(params: ApplyCustomSlashGatewayEffectsParams): Promise<void> {
  const initBindPersist = params.result.persist?.initBind;
  if (!initBindPersist) return;
  const configApi = params.getConfigApi?.();
  if (!configApi) throw new Error("getConfigApi is required to persist custom init binding changes");

  const currentCfg = typeof configApi.loadConfig === "function"
    ? structuredClone(configApi.loadConfig()) as OpenClawConfig
    : structuredClone(params.cfg) as OpenClawConfig;
  let nextCfg = applyCustomRuntimeAdminBindingsToConfig(currentCfg, {
    admins: initBindPersist.admins,
    adminGroup: initBindPersist.adminGroup,
    ...(typeof initBindPersist.enableRuntime === "boolean" ? { enabled: initBindPersist.enableRuntime } : {}),
  });
  if (initBindPersist.clearInitBind) {
    nextCfg = clearCustomRuntimeInitBindChallengeFromConfig(nextCfg);
  }
  await configApi.writeConfigFile(nextCfg);
  params.log?.info?.(`[qqbot:${params.accountId}] custom runtime init binding persisted: admins=${initBindPersist.admins.length} adminGroup=${initBindPersist.adminGroup ?? "unchanged"} clear=${initBindPersist.clearInitBind === true}`);
}

async function persistCustomSlashConfig(params: ApplyCustomSlashGatewayEffectsParams): Promise<void> {
  const configPersist = params.result.persist?.config;
  if (!configPersist) return;
  const configApi = params.getConfigApi?.();
  if (!configApi) throw new Error("getConfigApi is required to persist custom slash config changes");

  const currentCfg = typeof configApi.loadConfig === "function"
    ? structuredClone(configApi.loadConfig()) as OpenClawConfig
    : structuredClone(params.cfg) as OpenClawConfig;
  upsertCustomSceneConfig(
    currentCfg,
    configPersist.sceneKey,
    configPersist.sceneConfig,
    resolveCustomRuntimeConfig(currentCfg as any),
  );
  await configApi.writeConfigFile(currentCfg);
  params.log?.info?.(`[qqbot:${params.accountId}] custom runtime config persisted: key=${configPersist.sceneKey} scene=${configPersist.sceneConfig.scene}`);
}

async function deliverCustomSlashTaskNotifications(
  params: ApplyCustomSlashGatewayEffectsParams,
): Promise<CustomTaskNotificationDeliveryResult[]> {
  const deliveries = params.result.taskNotificationDeliveries ?? [];
  if (!deliveries.length) return [];
  const results = await applyCustomTaskNotificationDeliveries({
    deliveries,
    sendText: async (delivery) => {
      if (!params.sendTaskNotificationText) throw new Error("sendTaskNotificationText is required");
      await params.sendTaskNotificationText(delivery);
    },
  });
  for (const deliveryResult of results) {
    logCustomTaskNotificationDeliveryResult(params, deliveryResult);
  }
  return results;
}

function logCustomTaskNotificationDeliveryResult(
  params: ApplyCustomSlashGatewayEffectsParams,
  result: CustomTaskNotificationDeliveryResult,
): void {
  const target = formatCustomTaskNotificationTarget(result.delivery);
  if (result.status === "sent") {
    params.log?.info?.(`[qqbot:${params.accountId}] custom task notification sent: task=${result.delivery.taskId} audience=${result.delivery.audience} target=${target}`);
  } else if (result.status === "skipped") {
    params.log?.info?.(`[qqbot:${params.accountId}] custom task notification skipped: task=${result.delivery.taskId} audience=${result.delivery.audience} target=${target} reason=${result.reason}`);
  } else {
    params.log?.error?.(`[qqbot:${params.accountId}] custom task notification failed: task=${result.delivery.taskId} audience=${result.delivery.audience} target=${target} reason=${result.reason}`);
  }
}

function formatCustomTaskNotificationTarget(delivery: CustomTaskNotificationDelivery): string {
  return `${delivery.target.type}:${delivery.target.groupOpenid ?? delivery.target.channelId ?? delivery.target.senderId}`;
}

function requireCallback<T extends (...args: never[]) => unknown>(callback: T | undefined, name: string): T {
  if (!callback) throw new Error(`${name} is required to apply custom slash effects`);
  return callback;
}
