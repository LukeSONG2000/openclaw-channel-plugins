import type { InlineKeyboard } from "../types.js";
import type { CustomProactiveSendGuard } from "./proactive-send-guard.js";

export type CustomAdminGroupDeliveryStatus = "sent" | "blocked" | "skipped" | "failed";

export interface CustomAdminGroupDelivery {
  groupOpenid: string;
  text: string;
  keyboard?: InlineKeyboard;
  label: string;
  details: string;
  cooldownKey?: string;
  cooldownMs?: number;
}

export interface CustomAdminGroupDeliveryResult {
  status: CustomAdminGroupDeliveryStatus;
  reason?: string;
}

export interface CustomAdminGroupDeliveryLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export async function applyCustomAdminGroupDelivery(params: {
  accountId: string;
  delivery: CustomAdminGroupDelivery;
  proactiveGuard: CustomProactiveSendGuard;
  sendText: (groupOpenid: string, text: string) => Promise<void>;
  sendKeyboard: (groupOpenid: string, text: string, keyboard: InlineKeyboard) => Promise<void>;
  cooldowns?: Map<string, number>;
  clock?: () => number;
  log?: CustomAdminGroupDeliveryLogger;
}): Promise<CustomAdminGroupDeliveryResult> {
  const now = params.clock?.() ?? Date.now();
  const cooldownKey = params.delivery.cooldownKey;
  const cooldownMs = params.delivery.cooldownMs;
  if (cooldownKey && cooldownMs && params.cooldowns) {
    const nextAllowedAt = params.cooldowns.get(cooldownKey) ?? 0;
    if (now < nextAllowedAt) {
      params.log?.info?.(`[qqbot:${params.accountId}] custom ${params.delivery.label} skipped by cooldown: ${params.delivery.details}`);
      return { status: "skipped", reason: "cooldown" };
    }
  }

  const proactiveDecision = params.proactiveGuard({
    targetType: "group",
    targetId: params.delivery.groupOpenid,
    text: params.delivery.text,
  });
  if (!proactiveDecision.allowed) {
    applyDeliveryCooldown(params.cooldowns, cooldownKey, cooldownMs, now);
    params.log?.error?.(`[qqbot:${params.accountId}] custom ${params.delivery.label} blocked: ${params.delivery.details} reason=${proactiveDecision.reason}`);
    return { status: "blocked", reason: proactiveDecision.reason };
  }

  try {
    if (params.delivery.keyboard) {
      await params.sendKeyboard(params.delivery.groupOpenid, params.delivery.text, params.delivery.keyboard);
    } else {
      await params.sendText(params.delivery.groupOpenid, params.delivery.text);
    }
    proactiveDecision.commit?.();
    applyDeliveryCooldown(params.cooldowns, cooldownKey, cooldownMs, now);
    params.log?.info?.(`[qqbot:${params.accountId}] custom ${params.delivery.label} sent: ${params.delivery.details} group=${params.delivery.groupOpenid}`);
    return { status: "sent" };
  } catch (sendErr) {
    params.log?.error?.(`[qqbot:${params.accountId}] Failed to send custom ${params.delivery.label}: ${params.delivery.details} group=${params.delivery.groupOpenid} error=${sendErr}`);
    return { status: "failed", reason: String(sendErr) };
  }
}

function applyDeliveryCooldown(
  cooldowns: Map<string, number> | undefined,
  cooldownKey: string | undefined,
  cooldownMs: number | undefined,
  now: number,
): void {
  if (!cooldowns || !cooldownKey || !cooldownMs) return;
  cooldowns.set(cooldownKey, now + cooldownMs);
}
