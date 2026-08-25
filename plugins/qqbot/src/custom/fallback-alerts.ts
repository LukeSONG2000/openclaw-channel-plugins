import { resolveCustomAdminGroupKey } from "./auth.js";
import type { CustomFallbackEvent, CustomFallbackEventKind } from "./fallbacks.js";
import type { InlineKeyboard, KeyboardButton } from "../types.js";
import type { CustomRuntimeConfig } from "./types.js";
import { formatDurationZh } from "./presentation-labels.js";

export const DEFAULT_CUSTOM_FALLBACK_ALERT_WINDOW_MS = 15 * 60_000;
export const DEFAULT_CUSTOM_FALLBACK_ALERT_THRESHOLD = 3;
export const DEFAULT_CUSTOM_FALLBACK_ALERT_COOLDOWN_MS = 30 * 60_000;

const DEFAULT_ALERT_KINDS: CustomFallbackEventKind[] = [
  "response-timeout",
  "context-too-long",
];

export interface CustomFallbackAlertDecision {
  alert: boolean;
  reason?: string;
  groupOpenid?: string;
  text?: string;
  keyboard?: InlineKeyboard;
  cooldownKey?: string;
  eventCount?: number;
}

export function buildCustomFallbackAlertDecision(params: {
  runtime: CustomRuntimeConfig;
  accountId: string;
  currentEvent: CustomFallbackEvent;
  recentEvents: readonly CustomFallbackEvent[];
  now?: number;
}): CustomFallbackAlertDecision {
  const cfg = resolveCustomFallbackAlertConfig(params.runtime);
  if (!cfg.enabled) return { alert: false, reason: "disabled" };
  if (params.runtime.enabled !== true) return { alert: false, reason: "runtime-disabled" };

  const groupOpenid = parseAdminGroupOpenid(params.runtime.adminGroup);
  if (!groupOpenid) return { alert: false, reason: "missing-admin-group" };
  if (!cfg.kinds.has(params.currentEvent.kind)) return { alert: false, reason: "kind-not-alerted" };

  const now = normalizeTime(params.now, params.currentEvent.at);
  const windowStart = now - cfg.windowMs;
  const peerKey = formatFallbackAlertPeerKey(params.currentEvent);
  const matchingEvents = params.recentEvents.filter((event) =>
    event.accountId === params.accountId
    && event.at >= windowStart
    && event.at <= now
    && cfg.kinds.has(event.kind)
    && formatFallbackAlertPeerKey(event) === peerKey
  );

  if (matchingEvents.length < cfg.threshold) {
    return {
      alert: false,
      reason: "below-threshold",
      groupOpenid,
      cooldownKey: formatCooldownKey(params.accountId, peerKey),
      eventCount: matchingEvents.length,
    };
  }

  const latest = matchingEvents[matchingEvents.length - 1] ?? params.currentEvent;
  const byKind = countByKind(matchingEvents);
  const queueSummary = formatQueueSummary(latest);
  const text = [
    `⚠️ QQBot 兜底事件告警`,
    ``,
    `账号：${params.accountId}`,
    `会话：${formatFallbackAlertPeerLabel(params.currentEvent)}`,
    `窗口：${formatDurationZh(cfg.windowMs)} 内 ${matchingEvents.length} 次`,
    `类型：${[...byKind.entries()].map(([kind, count]) => `${formatFallbackKind(kind)}=${count}`).join(", ")}`,
    `最新：${new Date(latest.at).toISOString()} ${formatFallbackKind(latest.kind)}`,
    ...(queueSummary ? [`队列：${queueSummary}`] : []),
    ``,
    `建议先在原会话查看：`,
    commandInput("/bot-queue", "队列状态"),
    commandInput("/bot-fallback summary 20", "兜底摘要"),
  ].join("\n");

  return {
    alert: true,
    groupOpenid,
    text,
    keyboard: buildCustomFallbackAlertKeyboard(),
    cooldownKey: formatCooldownKey(params.accountId, peerKey),
    eventCount: matchingEvents.length,
  };
}

export function buildCustomFallbackAlertKeyboard(): InlineKeyboard {
  return {
    content: {
      rows: [
        {
          buttons: [
            makeAlertCommandButton("queue", "队列状态", "/bot-queue", true, 1),
          ],
        },
        {
          buttons: [
            makeAlertCommandButton("summary", "兜底摘要", "/bot-fallback summary 20", true, 1),
          ],
        },
      ],
    },
  };
}

function makeAlertCommandButton(
  id: string,
  label: string,
  command: string,
  enter: boolean,
  style: 0 | 1 | 3,
): KeyboardButton {
  return {
    id: `fallback_${id}`,
    render_data: { label, visited_label: label, style },
    action: {
      type: 2,
      data: command,
      enter,
      permission: { type: 2 },
      click_limit: 0,
    },
    group_id: "custom-fallback-alert",
  };
}

export function resolveCustomFallbackAlertCooldownMs(runtime: CustomRuntimeConfig): number {
  return resolveCustomFallbackAlertConfig(runtime).cooldownMs;
}

function resolveCustomFallbackAlertConfig(runtime: CustomRuntimeConfig): {
  enabled: boolean;
  windowMs: number;
  threshold: number;
  cooldownMs: number;
  kinds: Set<CustomFallbackEventKind>;
} {
  const raw = runtime.fallbackAlerts ?? {};
  const kinds = normalizeAlertKinds(raw.kinds);
  return {
    enabled: raw.enabled !== false,
    windowMs: normalizePositiveInteger(raw.windowMs, DEFAULT_CUSTOM_FALLBACK_ALERT_WINDOW_MS),
    threshold: normalizePositiveInteger(raw.threshold, DEFAULT_CUSTOM_FALLBACK_ALERT_THRESHOLD),
    cooldownMs: normalizePositiveInteger(raw.cooldownMs, DEFAULT_CUSTOM_FALLBACK_ALERT_COOLDOWN_MS),
    kinds,
  };
}

function normalizeAlertKinds(raw: unknown): Set<CustomFallbackEventKind> {
  if (!Array.isArray(raw) || raw.length === 0) return new Set(DEFAULT_ALERT_KINDS);
  const allowed = new Set<CustomFallbackEventKind>([
    "response-timeout",
    "context-too-long",
    "late-deliver-after-timeout",
    "tool-only-timeout",
    "tool-only-complete-no-block",
    "tool-fallback-media",
    "tool-fallback-text",
    "tool-fallback-no-output",
    "urgent-queue-bypass",
  ]);
  const kinds = new Set<CustomFallbackEventKind>();
  for (const item of raw) {
    const kind = String(item ?? "").trim() as CustomFallbackEventKind;
    if (allowed.has(kind)) kinds.add(kind);
  }
  return kinds.size > 0 ? kinds : new Set(DEFAULT_ALERT_KINDS);
}

function parseAdminGroupOpenid(raw?: string): string | undefined {
  const key = resolveCustomAdminGroupKey(raw);
  if (!key?.startsWith("qqbot:group:")) return undefined;
  const openid = key.slice("qqbot:group:".length).trim();
  return openid || undefined;
}

function formatFallbackAlertPeerKey(event: CustomFallbackEvent): string {
  const peer = event.peer;
  return peer ? `${peer.kind}:${peer.id}` : "未知";
}

function formatFallbackAlertPeerLabel(event: CustomFallbackEvent): string {
  const peer = event.peer;
  if (!peer) return "未知";
  return peer.label ? `${peer.kind}:${peer.id} (${peer.label})` : `${peer.kind}:${peer.id}`;
}

function formatCooldownKey(accountId: string, peerKey: string): string {
  return `${accountId}:${peerKey}`;
}

function countByKind(events: readonly CustomFallbackEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  }
  return counts;
}

function formatQueueSummary(event: CustomFallbackEvent): string | null {
  const details = event.details ?? {};
  const pending = details.queueTotalPending;
  const active = details.queueActiveUsers;
  const max = details.queueMaxConcurrentUsers;
  const senderPending = details.queueSenderPending;
  const senderActiveMs = details.queueSenderActiveMs;
  const maxActiveMs = details.queueMaxActiveMs;
  const parts = [];
  if (typeof pending === "number" || typeof active === "number" || typeof senderPending === "number") {
    parts.push(`待处理=${pending ?? "?"}`);
    parts.push(`活跃=${active ?? "?"}/${max ?? "?"}`);
    parts.push(`当前会话待处理=${senderPending ?? "?"}`);
  }
  if (typeof senderActiveMs === "number" || typeof maxActiveMs === "number") {
    parts.push(`活跃时长=${formatDurationOrQuestion(senderActiveMs)}/${formatDurationOrQuestion(maxActiveMs)}`);
  }
  return parts.length ? parts.join(", ") : null;
}

function normalizeTime(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function normalizePositiveInteger(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.floor(raw));
}

function formatFallbackKind(kind: string): string {
  const labels: Record<string, string> = {
    "response-timeout": "响应超时",
    "context-too-long": "上下文过长",
    "late-deliver-after-timeout": "超时后迟到回复",
    "tool-only-timeout": "工具等待超时",
    "tool-only-complete-no-block": "工具完成但无回复",
    "tool-fallback-media": "工具媒体兜底",
    "tool-fallback-text": "工具文本兜底",
    "tool-fallback-no-output": "工具无输出",
    "urgent-queue-bypass": "紧急队列绕行",
  };
  return labels[kind] ? `${labels[kind]}（${kind}）` : kind;
}

function formatDurationOrQuestion(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? formatDurationZh(value) : "?";
}

function commandInput(text: string, show: string): string {
  return `<qqbot-cmd-input text="${escapeCommandInputAttr(text)}" show="${escapeCommandInputAttr(show)}"/>`;
}

function escapeCommandInputAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
