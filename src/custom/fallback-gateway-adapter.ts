import type { QueuedMessage } from "../message-queue.js";
import { loadCustomFallbackEvents } from "./fallback-event-store.js";
import type { CustomFallbackEvent } from "./fallbacks.js";

export type CustomFallbackCommand =
  | { kind: "help" }
  | { kind: "list"; limit: number };

export type CustomFallbackCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomFallbackCommand; error?: string };

export interface CustomFallbackCommandResult {
  handled: boolean;
  reply?: string;
}

export interface CustomFallbackCommandStore {
  loadEvents: (accountId: string, limit: number) => CustomFallbackEvent[];
}

export function parseCustomFallbackCommand(rawContent: string): CustomFallbackCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-fallback") return { matched: false };

  const action = (tokens.shift() ?? "list").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "list" || action === "ls" || action === "status" || action === "show") {
    const parsedLimit = parseLimit(tokens[0]);
    if (parsedLimit === null) return { matched: true, error: "数量需要是 1 到 20 的整数" };
    return { matched: true, command: { kind: "list", limit: parsedLimit } };
  }

  const parsedLimit = parseLimit(action);
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
  const command = parsed.command ?? { kind: "list" as const, limit: 5 };

  if (command.kind === "help") return { handled: true, reply: formatCustomFallbackHelp() };

  const events = (params.store?.loadEvents ?? loadFallbackEvents)(params.accountId, command.limit);
  return { handled: true, reply: formatCustomFallbackList(events, command.limit) };
}

function loadFallbackEvents(accountId: string, limit: number): CustomFallbackEvent[] {
  return loadCustomFallbackEvents(accountId, { limit });
}

function parseLimit(raw: string | undefined): number | null {
  if (!raw) return 5;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 20) return null;
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
    ``,
    `查看最近的超时、上下文过长、工具无输出等兜底事件。数量范围：1-20。`,
  );
  return lines.join("\n");
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
      ...(event.timeoutMs ? [`  timeoutMs：${event.timeoutMs}`] : []),
      ...(event.reason ? [`  reason：${truncate(event.reason, 120)}`] : []),
    );
  }
  return lines.join("\n");
}

function formatPeer(event: CustomFallbackEvent): string {
  if (!event.peer) return "unknown";
  return `${event.peer.kind}:${event.peer.label || event.peer.id}`;
}

function formatEventTime(at: number): string {
  if (!Number.isFinite(at)) return "unknown-time";
  return new Date(at).toISOString();
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text;
}
