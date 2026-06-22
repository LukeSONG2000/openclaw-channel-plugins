import type { CustomFallbackEvent } from "./fallbacks.js";
import {
  CUSTOM_FALLBACK_MAX_LIST_LIMIT,
  CUSTOM_FALLBACK_MAX_SUMMARY_LIMIT,
} from "./fallback-command-parser.js";
import { slashCommandInput } from "./command-link.js";
import {
  formatBooleanYesNoUnknown,
  formatDurationZh,
  formatUnknown,
} from "./presentation-labels.js";

export function formatCustomFallbackHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `🧯 自定义兜底事件命令`,
    ``,
    slashCommandInput(`/bot-fallback`),
    slashCommandInput(`/bot-fallback list`, `/bot-fallback list [数量]`),
    slashCommandInput(`/bot-fallback status`, `/bot-fallback status [数量]`),
    slashCommandInput(`/bot-fallback summary`, `/bot-fallback summary [数量]`),
    slashCommandInput(`/bot-fallback clear --force`),
    ``,
    `查看、统计或清理最近的超时、上下文过长、工具无输出等兜底事件。列表数量范围：1-${CUSTOM_FALLBACK_MAX_LIST_LIMIT}；统计范围：1-${CUSTOM_FALLBACK_MAX_SUMMARY_LIMIT}。`,
  );
  return lines.join("\n");
}

export function formatCustomFallbackClearHelp(): string {
  return [
    `⚠️ 清空兜底事件需要确认`,
    ``,
    `请使用：${slashCommandInput("/bot-fallback clear --force")}`,
    ``,
    `清空后将无法通过 ${slashCommandInput("/bot-fallback")} 查看之前的兜底记录。`,
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
      `- ${formatEventTime(event.at)} ${formatFallbackKind(event.kind)}`,
      `  会话：${formatPeer(event)}`,
      `  用户：${formatUnknown(event.actor?.label || event.actor?.id)}`,
      `  运行：${formatUnknown(event.runId || event.messageId)}`,
      `  响应：有回复=${formatBooleanYesNoUnknown(event.hasResponse)}, 阻断回复=${formatBooleanYesNoUnknown(event.hasBlockResponse)}`,
      `  工具：发送=${event.toolDeliverCount ?? 0}, 文本=${event.toolTextCount ?? 0}, 媒体=${event.toolMediaCount ?? 0}`,
      ...formatQueueDetails(event),
      ...formatUrgentDetails(event),
      ...(event.timeoutMs ? [`  超时：${formatDurationZh(event.timeoutMs)}`] : []),
      ...(event.reason ? [`  原因：${truncate(event.reason, 120)}`] : []),
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
    lines.push(`最大队列：待处理=${maxPending ?? "?"}, 活跃=${maxActive ?? "?"}/${maxConcurrency ?? "?"}, 当前会话待处理=${maxSenderPending ?? "?"}`);
  }
  if (maxSenderActiveMs !== null || maxActiveMs !== null) {
    lines.push(`最长活跃：当前会话=${formatDurationDetail(maxSenderActiveMs)}, 全局=${formatDurationDetail(maxActiveMs)}`);
  }

  lines.push(``, `类型分布：`);
  for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`- ${formatFallbackKind(kind)}：${count}`);
  }

  if (latest) {
    lines.push(
      ``,
      `最新：${formatEventTime(latest.at)} ${formatFallbackKind(latest.kind)}`,
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
  if (!event.peer) return "未知";
  return `${event.peer.kind}:${event.peer.label || event.peer.id}`;
}

function formatEventTime(at: number): string {
  if (!Number.isFinite(at)) return "未知时间";
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
    ? `, 活跃时长=${formatDurationDetail(senderActiveMs)}/${formatDurationDetail(maxActiveMs)}`
    : "";
  return [`  队列：待处理=${total ?? "?"}, 活跃=${active ?? "?"}/${max ?? "?"}, 当前会话待处理=${sender ?? "?"}${activeAge}`];
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
  const afterActive = afterSenderActiveMs !== null ? `, 绕行后活跃=${formatDurationZh(afterSenderActiveMs)}` : "";
  const commandText = command.startsWith("/") ? commandInput(command, command) : command;
  return [`  紧急绕行：命令=${commandText}, 丢弃排队=${dropped ?? "?"}, 队列会话=${queuePeerId}, 绕行后待处理=${afterTotal ?? "?"}, 绕行后当前会话待处理=${afterSender ?? "?"}${afterActive}`];
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

function formatDurationDetail(ms: number | null): string {
  return ms === null ? "?" : formatDurationZh(ms);
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
