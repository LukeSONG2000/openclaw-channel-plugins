import type { QueuedMessage } from "../message-queue.js";
import { clearCustomFallbackEvents, loadCustomFallbackEvents } from "./fallback-event-store.js";
import type { CustomFallbackEvent } from "./fallbacks.js";

const DEFAULT_LIST_LIMIT = 5;
const MAX_LIST_LIMIT = 20;
const DEFAULT_SUMMARY_LIMIT = 20;
const MAX_SUMMARY_LIMIT = 100;

export type CustomFallbackCommand =
  | { kind: "help" }
  | { kind: "list"; limit: number }
  | { kind: "summary"; limit: number }
  | { kind: "clear"; force: boolean };

export type CustomFallbackCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomFallbackCommand; error?: string };

export interface CustomFallbackCommandResult {
  handled: boolean;
  reply?: string;
}

export interface CustomFallbackCommandStore {
  loadEvents: (accountId: string, limit: number) => CustomFallbackEvent[];
  clearEvents?: (accountId: string) => boolean;
}

export function parseCustomFallbackCommand(rawContent: string): CustomFallbackCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-fallback") return { matched: false };

  const action = (tokens.shift() ?? "list").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "list" || action === "ls" || action === "status" || action === "show") {
    const parsedLimit = parseLimit(tokens[0], DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    if (parsedLimit === null) return { matched: true, error: `数量需要是 1 到 ${MAX_LIST_LIMIT} 的整数` };
    return { matched: true, command: { kind: "list", limit: parsedLimit } };
  }
  if (action === "summary" || action === "stats") {
    const parsedLimit = parseLimit(tokens[0], DEFAULT_SUMMARY_LIMIT, MAX_SUMMARY_LIMIT);
    if (parsedLimit === null) return { matched: true, error: `统计数量需要是 1 到 ${MAX_SUMMARY_LIMIT} 的整数` };
    return { matched: true, command: { kind: "summary", limit: parsedLimit } };
  }
  if (action === "clear" || action === "reset") {
    return { matched: true, command: { kind: "clear", force: tokens.some((token) => token.toLowerCase() === "--force") } };
  }

  const parsedLimit = parseLimit(action, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  if (parsedLimit !== null) {
    return { matched: true, command: { kind: "list", limit: parsedLimit } };
  }

  return { matched: true, error: `未知子命令：${action}` };
}

export function handleCustomFallbackCommand(params: {
  accountId: string;
  message: QueuedMessage;
  rawContent: string;
  store?: CustomFallbackCommandStore;
}): CustomFallbackCommandResult {
  const parsed = parseCustomFallbackCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };
  if (parsed.error) return { handled: true, reply: formatCustomFallbackHelp(parsed.error) };
  const command = parsed.command ?? { kind: "list" as const, limit: DEFAULT_LIST_LIMIT };

  if (command.kind === "help") return { handled: true, reply: formatCustomFallbackHelp() };
  if (command.kind === "clear") {
    if (!command.force) return { handled: true, reply: formatCustomFallbackClearHelp() };
    const clear = params.store?.clearEvents ?? clearCustomFallbackEvents;
    const ok = clear(params.accountId);
    return {
      handled: true,
      reply: ok
        ? `✅ 已清空最近兜底事件。`
        : `⚠️ 清空最近兜底事件失败，请查看 gateway 日志。`,
    };
  }

  const events = (params.store?.loadEvents ?? loadFallbackEvents)(params.accountId, command.limit);
  if (command.kind === "summary") {
    return { handled: true, reply: formatCustomFallbackSummary(events, command.limit) };
  }
  return { handled: true, reply: formatCustomFallbackList(events, command.limit) };
}

function loadFallbackEvents(accountId: string, limit: number): CustomFallbackEvent[] {
  return loadCustomFallbackEvents(accountId, { limit });
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number | null {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || String(value) !== raw || value < 1 || value > max) return null;
  return value;
}

function formatCustomFallbackHelp(error?: string): string {
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
    `查看、统计或清理最近的超时、上下文过长、工具无输出等兜底事件。列表数量范围：1-${MAX_LIST_LIMIT}；统计范围：1-${MAX_SUMMARY_LIMIT}。`,
  );
  return lines.join("\n");
}

function formatCustomFallbackClearHelp(): string {
  return [
    `⚠️ 清空兜底事件需要确认`,
    ``,
    `请使用：/bot-fallback clear --force`,
    ``,
    `清空后将无法通过 /bot-fallback 查看之前的兜底记录。`,
  ].join("\n");
}

function formatCustomFallbackList(events: CustomFallbackEvent[], limit: number): string {
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
  return lines.join("\n");
}

function formatCustomFallbackSummary(events: CustomFallbackEvent[], limit: number): string {
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
  if (maxPending !== null || maxActive !== null || maxConcurrency !== null || maxSenderPending !== null) {
    lines.push(`最大队列：pending=${maxPending ?? "?"}, active=${maxActive ?? "?"}/${maxConcurrency ?? "?"}, senderPending=${maxSenderPending ?? "?"}`);
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
  if (total === null && active === null && max === null && sender === null) return [];
  return [`  queue：pending=${total ?? "?"}, active=${active ?? "?"}/${max ?? "?"}, senderPending=${sender ?? "?"}`];
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
  return [`  urgent：command=${command}, dropped=${dropped ?? "?"}, queuePeer=${queuePeerId}, afterPending=${afterTotal ?? "?"}, afterSenderPending=${afterSender ?? "?"}`];
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
