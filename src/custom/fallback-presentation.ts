import type { CustomFallbackEvent } from "./fallbacks.js";
import {
  CUSTOM_FALLBACK_MAX_LIST_LIMIT,
  CUSTOM_FALLBACK_MAX_SUMMARY_LIMIT,
} from "./fallback-command-parser.js";

export function formatCustomFallbackHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🧯 自定义兜底事件命令`,
    ``,
    `/bot-fallback`,
    `/bot-fallback list [数量]`,
    `/bot-fallback status [数量]`,
    `/bot-fallback summary [数量]`,
    `/bot-fallback clear --force`,
    ``,
    `查看、统计或清理最近的超时、上下文过长、工具无输出等兜底事件。列表数量范围：1-${CUSTOM_FALLBACK_MAX_LIST_LIMIT}；统计范围：1-${CUSTOM_FALLBACK_MAX_SUMMARY_LIMIT}。`,
  );
  return lines.join("\n");
}

export function formatCustomFallbackClearHelp(): string {
  return [
    `⚠️ 清空兜底事件需要确认`,
    ``,
    `请使用：/bot-fallback clear --force`,
    ``,
    `清空后将无法通过 /bot-fallback 查看之前的兜底记录。`,
  ].join("\n");
}

export function formatCustomFallbackList(events: CustomFallbackEvent[], limit: number): string {
  if (events.length === 0) {
    return [
      `🧯 最近兜底事件`,
      ``,
      `暂无记录。`,
      `保留范围：最近 ${limit} 条。`,
    ].join("\n");
  }

  const lines = [
    `🧯 最近兜底事件`,
    ``,
    `显示：${events.length}/${limit}`,
  ];
  for (const event of events.slice().reverse()) {
    lines.push(
      ``,
      `- ${formatEventTime(event.at)} ${event.kind}`,
      `  会话：${formatPeer(event)}`,
      `  用户：${event.actor?.label || event.actor?.id || "unknown"}`,
      `  run：${event.runId || event.messageId || "unknown"}`,
      `  响应：hasResponse=${event.hasResponse === undefined ? "unknown" : event.hasResponse ? "yes" : "no"}, block=${event.hasBlockResponse === undefined ? "unknown" : event.hasBlockResponse ? "yes" : "no"}`,
      `  tool：deliver=${event.toolDeliverCount ?? 0}, text=${event.toolTextCount ?? 0}, media=${event.toolMediaCount ?? 0}`,
      ...formatQueueDetails(event),
      ...formatUrgentDetails(event),
      ...(event.timeoutMs ? [`  timeoutMs：${event.timeoutMs}`] : []),
      ...(event.reason ? [`  reason：${truncate(event.reason, 120)}`] : []),
    );
  }
  lines.push(``, ...formatRecoveryShortcuts());
  return lines.join("\n");
}

export function formatCustomFallbackSummary(events: CustomFallbackEvent[], limit: number): string {
  const lines = [
    `🧯 兜底事件摘要`,
    ``,
  ];
  if (events.length === 0) {
    lines.push(
      `暂无记录。`,
      `统计范围：最近 ${limit} 条。`,
    );
    return lines.join("\n");
  }

  const byKind = countByKind(events);
  const latest = events[events.length - 1];
  lines.push(
    `统计：${events.length}/${limit}`,
    `响应超时：${byKind.get("response-timeout") ?? 0}`,
    `上下文过长：${byKind.get("context-too-long") ?? 0}`,
    `紧急绕行：${byKind.get("urgent-queue-bypass") ?? 0}`,
    `工具兜底：${events.filter((event) => event.kind.startsWith("tool-")).length}`,
  );

  const maxPending = maxNumber(events, "queueTotalPending");
  const maxActive = maxNumber(events, "queueActiveUsers");
  const maxConcurrency = maxNumber(events, "queueMaxConcurrentUsers");
  const maxSenderPending = maxNumber(events, "queueSenderPending");
  const maxSenderActiveMs = maxNumber(events, "queueSenderActiveMs");
  const maxActiveMs = maxNumber(events, "queueMaxActiveMs");
  if (maxPending !== null || maxActive !== null || maxConcurrency !== null || maxSenderPending !== null) {
    lines.push(`最大队列：pending=${maxPending ?? "?"}, active=${maxActive ?? "?"}/${maxConcurrency ?? "?"}, senderPending=${maxSenderPending ?? "?"}`);
  }
  if (maxSenderActiveMs !== null || maxActiveMs !== null) {
    lines.push(`最长活跃：senderActiveMs=${maxSenderActiveMs ?? "?"}, maxActiveMs=${maxActiveMs ?? "?"}`);
  }

  lines.push(``, `类型分布：`);
  for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`- ${kind}: ${count}`);
  }

  if (latest) {
    lines.push(
      ``,
      `最新：${formatEventTime(latest.at)} ${latest.kind}`,
    );
  }
  lines.push(``, ...formatRecoveryShortcuts());
  return lines.join("\n");
}

function countByKind(events: CustomFallbackEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  }
  return counts;
}

function formatPeer(event: CustomFallbackEvent): string {
  if (!event.peer) return "unknown";
  return `${event.peer.kind}:${event.peer.label || event.peer.id}`;
}

function formatEventTime(at: number): string {
  if (!Number.isFinite(at)) return "unknown-time";
  return new Date(at).toISOString();
}

function formatQueueDetails(event: CustomFallbackEvent): string[] {
  const total = numberDetail(event, "queueTotalPending");
  const active = numberDetail(event, "queueActiveUsers");
  const max = numberDetail(event, "queueMaxConcurrentUsers");
  const sender = numberDetail(event, "queueSenderPending");
  const senderActiveMs = numberDetail(event, "queueSenderActiveMs");
  const maxActiveMs = numberDetail(event, "queueMaxActiveMs");
  if (total === null && active === null && max === null && sender === null && senderActiveMs === null && maxActiveMs === null) return [];
  const activeAge = senderActiveMs !== null || maxActiveMs !== null
    ? `, activeMs=${senderActiveMs ?? "?"}/${maxActiveMs ?? "?"}`
    : "";
  return [`  queue：pending=${total ?? "?"}, active=${active ?? "?"}/${max ?? "?"}, senderPending=${sender ?? "?"}${activeAge}`];
}

function numberDetail(event: CustomFallbackEvent, key: string): number | null {
  const value = event.details?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringDetail(event: CustomFallbackEvent, key: string): string | null {
  const value = event.details?.[key];
  return typeof value === "string" && value ? value : null;
}

function formatUrgentDetails(event: CustomFallbackEvent): string[] {
  if (event.kind !== "urgent-queue-bypass") return [];
  const command = stringDetail(event, "command") ?? "?";
  const queuePeerId = stringDetail(event, "queuePeerId") ?? "?";
  const dropped = numberDetail(event, "droppedQueuedMessages");
  const afterTotal = numberDetail(event, "queueAfterTotalPending");
  const afterSender = numberDetail(event, "queueAfterSenderPending");
  const afterSenderActiveMs = numberDetail(event, "queueAfterSenderActiveMs");
  const afterActive = afterSenderActiveMs !== null ? `, afterSenderActiveMs=${afterSenderActiveMs}` : "";
  return [`  urgent：command=${command}, dropped=${dropped ?? "?"}, queuePeer=${queuePeerId}, afterPending=${afterTotal ?? "?"}, afterSenderPending=${afterSender ?? "?"}${afterActive}`];
}

function maxNumber(events: CustomFallbackEvent[], key: string): number | null {
  let max: number | null = null;
  for (const event of events) {
    const value = numberDetail(event, key);
    if (value !== null && (max === null || value > max)) {
      max = value;
    }
  }
  return max;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}

function formatRecoveryShortcuts(): string[] {
  return [
    `恢复命令：`,
    commandInput("/compact", "压缩上下文"),
    commandInput("/new", "新会话"),
  ];
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
