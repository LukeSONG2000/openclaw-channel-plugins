import type { InlineKeyboard } from "../types.js";
import type { CustomAdminGroupDelivery } from "./admin-group-delivery-gateway-adapter.js";
import { applyCustomAdminGroupDelivery } from "./admin-group-delivery-gateway-adapter.js";
import { resolveCustomFallbackAlertCooldownMs } from "./fallback-alerts.js";
import type { CustomProactiveSendGuard } from "./proactive-send-guard.js";
import type { CustomRuntimeConfig } from "./types.js";
import { parseGroupOpenid } from "./identity-presentation.js";
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

export interface CustomSystemStatusNotificationInput {
  title: string;
  lines?: string[];
  dedupeKey?: string;
}

export interface CustomAdminGroupNotificationService {
  sendDelivery: (delivery: CustomAdminGroupDelivery) => Promise<void>;
  sendAuthAdminGroupNotification: (notification: CustomAuthAdminGroupNotificationInput) => Promise<void>;
  sendFallbackAdminGroupAlert: (alert: CustomFallbackAdminGroupAlertInput) => Promise<void>;
  sendUpdateAvailableNotification: (result: CustomUpdateCheckResult) => Promise<void>;
  sendSystemStatusNotification: (notification: CustomSystemStatusNotificationInput) => Promise<void>;
}

export function createCustomAdminGroupNotificationServiceGateway(params: {
  accountId: string;
  getRuntime: () => CustomRuntimeConfig;
  buildProactiveGuard: () => CustomProactiveSendGuard;
  sendText: (groupOpenid: string, text: string) => Promise<void>;
  sendDirectText?: (userOpenid: string, text: string) => Promise<void>;
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
    sendSystemStatusNotification: async (notification) => {
      const runtime = params.getRuntime();
      const text = formatSystemStatusNotification(notification);
      const adminGroupOpenid = parseGroupOpenid(runtime.adminGroup);
      if (adminGroupOpenid) {
        await sendDelivery({
          groupOpenid: adminGroupOpenid,
          text,
          label: "system status notification",
          details: notification.dedupeKey ?? notification.title,
          cooldownKey: notification.dedupeKey ? `system-status:${notification.dedupeKey}:group:${adminGroupOpenid}` : undefined,
          cooldownMs: notification.dedupeKey ? 60_000 : undefined,
        });
      }

      const adminOpenids = [...new Set((runtime.admins ?? []).map(parseAdminOpenid).filter((id): id is string => Boolean(id)))];
      for (const adminOpenid of adminOpenids) {
        await sendDirectSystemStatus({
          accountId: params.accountId,
          adminOpenid,
          text,
          proactiveGuard: params.buildProactiveGuard(),
          sendDirectText: params.sendDirectText,
          log: params.log,
        });
      }
    },
  };
}

function formatSystemStatusNotification(notification: CustomSystemStatusNotificationInput): string {
  return [
    `🛠 ${notification.title}`,
    ...(notification.lines?.length ? ["", ...notification.lines] : []),
  ].join("\n");
}

function parseAdminOpenid(value: string): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  if (raw.startsWith("qqbot:c2c:")) return raw.slice("qqbot:c2c:".length).trim() || undefined;
  if (raw.startsWith("qqbot:user:")) return raw.slice("qqbot:user:".length).trim() || undefined;
  if (raw.startsWith("c2c:")) return raw.slice("c2c:".length).trim() || undefined;
  if (raw.startsWith("user:")) return raw.slice("user:".length).trim() || undefined;
  if (raw.startsWith("qqbot:")) return undefined;
  return raw;
}

async function sendDirectSystemStatus(params: {
  accountId: string;
  adminOpenid: string;
  text: string;
  proactiveGuard: CustomProactiveSendGuard;
  sendDirectText?: (userOpenid: string, text: string) => Promise<void>;
  log?: CustomAdminGroupNotificationServiceLogger;
}): Promise<void> {
  if (!params.sendDirectText) {
    params.log?.debug?.(`[qqbot:${params.accountId}] custom system status direct notification skipped: sendDirectText missing`);
    return;
  }
  const decision = params.proactiveGuard({
    targetType: "c2c",
    targetId: params.adminOpenid,
    text: params.text,
  });
  if (!decision.allowed) {
    params.log?.error?.(`[qqbot:${params.accountId}] custom system status direct notification blocked: admin=${params.adminOpenid} reason=${decision.reason}`);
    return;
  }
  try {
    await params.sendDirectText(params.adminOpenid, params.text);
    decision.commit?.();
    params.log?.info?.(`[qqbot:${params.accountId}] custom system status direct notification sent: admin=${params.adminOpenid}`);
  } catch (err) {
    params.log?.error?.(`[qqbot:${params.accountId}] Failed to send custom system status direct notification: admin=${params.adminOpenid} error=${err}`);
  }
}
