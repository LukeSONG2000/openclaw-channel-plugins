import type { InlineKeyboard } from "../types.js";
import type { CustomAdminGroupDelivery } from "./admin-group-delivery-gateway-adapter.js";
import { applyCustomAdminGroupDelivery } from "./admin-group-delivery-gateway-adapter.js";
import { resolveCustomFallbackAlertCooldownMs } from "./fallback-alerts.js";
import type { CustomProactiveSendGuard } from "./proactive-send-guard.js";
import type { CustomRuntimeConfig } from "./types.js";
import {
  buildCustomUpdateAvailableNotification,
  type CustomUpdateCheckResult,
} from "./update-check.js";

export interface CustomAdminGroupNotificationServiceLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomAuthAdminGroupNotificationInput {
  groupOpenid: string;
  text: string;
  keyboard?: InlineKeyboard;
  requestId: string;
  source: "slash" | "dispatch";
}

export interface CustomFallbackAdminGroupAlertInput {
  groupOpenid: string;
  text: string;
  keyboard?: InlineKeyboard;
  cooldownKey: string;
  eventCount?: number;
}

export interface CustomAdminGroupNotificationService {
  sendDelivery: (delivery: CustomAdminGroupDelivery) => Promise<void>;
  sendAuthAdminGroupNotification: (notification: CustomAuthAdminGroupNotificationInput) => Promise<void>;
  sendFallbackAdminGroupAlert: (alert: CustomFallbackAdminGroupAlertInput) => Promise<void>;
  sendUpdateAvailableNotification: (result: CustomUpdateCheckResult) => Promise<void>;
}

export function createCustomAdminGroupNotificationServiceGateway(params: {
  accountId: string;
  getRuntime: () => CustomRuntimeConfig;
  buildProactiveGuard: () => CustomProactiveSendGuard;
  sendText: (groupOpenid: string, text: string) => Promise<void>;
  sendKeyboard: (groupOpenid: string, text: string, keyboard: InlineKeyboard) => Promise<void>;
  cooldowns?: Map<string, number>;
  clock?: () => number;
  log?: CustomAdminGroupNotificationServiceLogger;
}): CustomAdminGroupNotificationService {
  const cooldowns = params.cooldowns ?? new Map<string, number>();

  const sendDelivery = async (delivery: CustomAdminGroupDelivery): Promise<void> => {
    await applyCustomAdminGroupDelivery({
      accountId: params.accountId,
      delivery,
      proactiveGuard: params.buildProactiveGuard(),
      cooldowns,
      clock: params.clock,
      log: params.log,
      sendText: params.sendText,
      sendKeyboard: params.sendKeyboard,
    });
  };

  return {
    sendDelivery,
    sendAuthAdminGroupNotification: async (notification) => {
      await sendDelivery({
        groupOpenid: notification.groupOpenid,
        text: notification.text,
        keyboard: notification.keyboard,
        label: "auth admin-group notification",
        details: `source=${notification.source} request=${notification.requestId}`,
      });
    },
    sendFallbackAdminGroupAlert: async (alert) => {
      const cooldownMs = resolveCustomFallbackAlertCooldownMs(params.getRuntime());
      await sendDelivery({
        groupOpenid: alert.groupOpenid,
        text: alert.text,
        keyboard: alert.keyboard,
        label: "fallback admin-group alert",
        details: `key=${alert.cooldownKey} count=${alert.eventCount ?? "?"}`,
        cooldownKey: alert.cooldownKey,
        cooldownMs,
      });
    },
    sendUpdateAvailableNotification: async (result) => {
      const notification = buildCustomUpdateAvailableNotification({
        accountId: params.accountId,
        runtime: params.getRuntime(),
        result,
      });
      if (!notification) {
        params.log?.debug?.(`[qqbot:${params.accountId}] custom update available notification skipped: missing custom runtime admin group or not notifiable`);
        return;
      }

      await sendDelivery({
        groupOpenid: notification.groupOpenid,
        text: notification.text,
        keyboard: notification.keyboard,
        label: "update available notification",
        details: `package=${notification.packageName} latest=${notification.latest}`,
      });
    },
  };
}
