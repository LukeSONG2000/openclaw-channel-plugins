import type { QueueSnapshot } from "../slash-commands.js";

export type CustomQueueStatusCommand =
  | { kind: "help" }
  | { kind: "status" };

export type CustomQueueStatusCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomQueueStatusCommand; error?: string };

export interface CustomQueueStatusCommandResult {
  handled: boolean;
  reply?: string;
}

export function parseCustomQueueStatusCommand(rawContent: string): CustomQueueStatusCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-queue") return { matched: false };

  const action = (tokens.shift() ?? "status").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "status" || action === "show" || action === "health") return { matched: true, command: { kind: "status" } };
  return { matched: true, error: `未知子命令：${action}` };
}

export function handleCustomQueueStatusCommand(params: {
  rawContent: string;
  peerId: string;
  snapshot?: QueueSnapshot;
}): CustomQueueStatusCommandResult {
  const parsed = parseCustomQueueStatusCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };
  if (parsed.error) return { handled: true, reply: formatQueueStatusHelp(parsed.error) };
  const command = parsed.command ?? { kind: "status" as const };
  if (command.kind === "help") return { handled: true, reply: formatQueueStatusHelp() };
  if (!params.snapshot) {
    return {
      handled: true,
      reply: [
        `📊 当前队列状态`,
        ``,
        `当前会话：${params.peerId}`,
        `队列快照暂不可用。`,
      ].join("\n"),
    };
  }
  return { handled: true, reply: formatQueueStatus(params.peerId, params.snapshot) };
}

function formatQueueStatusHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `📊 自定义队列状态命令`,
    ``,
    `/bot-queue`,
    `/bot-queue status`,
    ``,
    `查看当前会话的队列 pending、全局活跃用户数和活跃处理时长。`,
  );
  return lines.join("\n");
}

function formatQueueStatus(peerId: string, snapshot: QueueSnapshot): string {
  const lines = [
    `📊 当前队列状态`,
    ``,
    `当前会话：${peerId}`,
    `本会话待处理：${snapshot.senderPending}`,
    `全局待处理：${snapshot.totalPending}`,
    `活跃用户：${snapshot.activeUsers}/${snapshot.maxConcurrentUsers}`,
    `本会话活跃：${formatDuration(snapshot.senderActiveMs)}`,
    `最长活跃：${formatDuration(snapshot.maxActiveMs)}`,
  ];
  if ((snapshot.senderActiveMs ?? 0) > 0 || snapshot.senderPending > 0) {
    lines.push(
      ``,
      `恢复命令：`,
      commandInput("/compact", "压缩上下文"),
      commandInput("/new", "新会话"),
    );
  }
  return lines.join("\n");
}

function formatDuration(ms?: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "-";
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return minutes > 0 ? `${minutes}m${remainSeconds}s` : `${seconds}s`;
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
