import type { CustomUnreadRuntime } from "./unread-runtime.js";
import { inspectCustomUnreadRuntimeState } from "./unread-runtime.js";

const DEFAULT_PEER_LIMIT = 5;
const MAX_PEER_LIMIT = 20;

export type CustomUnreadStatusCommand =
  | { kind: "help" }
  | { kind: "status"; limit: number };

export type CustomUnreadStatusCommandParseResult =
  | { matched: false }
  | { matched: true; command?: CustomUnreadStatusCommand; error?: string };

export interface CustomUnreadStatusCommandResult {
  handled: boolean;
  reply?: string;
}

export function parseCustomUnreadStatusCommand(rawContent: string): CustomUnreadStatusCommandParseResult {
  const content = rawContent.trim();
  if (!content.startsWith("/")) return { matched: false };
  const [rawName = "", ...tokens] = content.slice(1).split(/\s+/).filter(Boolean);
  if (rawName.toLowerCase() !== "bot-unread") return { matched: false };

  const action = (tokens.shift() ?? "status").toLowerCase();
  if (action === "help" || action === "?") return { matched: true, command: { kind: "help" } };
  if (action === "status" || action === "summary" || action === "list" || action === "ls") {
    const limit = parseLimit(tokens[0]);
    if (limit === null) return { matched: true, error: `数量需要是 1 到 ${MAX_PEER_LIMIT} 的整数` };
    return { matched: true, command: { kind: "status", limit } };
  }

  const limit = parseLimit(action);
  if (limit !== null) return { matched: true, command: { kind: "status", limit } };
  return { matched: true, error: `未知子命令：${action}` };
}

export function handleCustomUnreadStatusCommand(params: {
  unread: CustomUnreadRuntime;
  rawContent: string;
}): CustomUnreadStatusCommandResult {
  const parsed = parseCustomUnreadStatusCommand(params.rawContent);
  if (!parsed.matched) return { handled: false };
  if (parsed.error) return { handled: true, reply: formatCustomUnreadStatusHelp(parsed.error) };
  const command = parsed.command ?? { kind: "status" as const, limit: DEFAULT_PEER_LIMIT };
  if (command.kind === "help") return { handled: true, reply: formatCustomUnreadStatusHelp() };
  return {
    handled: true,
    reply: formatCustomUnreadStatus(params.unread, command.limit),
  };
}

function parseLimit(raw: string | undefined): number | null {
  if (!raw) return DEFAULT_PEER_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || String(value) !== raw || value < 1 || value > MAX_PEER_LIMIT) return null;
  return value;
}

function formatCustomUnreadStatusHelp(error?: string): string {
  const lines = [];
  if (error) lines.push(`❌ ${error}`, ``);
  lines.push(
    `👀 自定义未读状态命令`,
    ``,
    `/bot-unread`,
    `/bot-unread status [数量]`,
    `/bot-unread summary [数量]`,
    ``,
    `查看未读追读、follow-up 和 sleep-digest 的只读摘要；不会展示缓存消息正文。数量范围：1-${MAX_PEER_LIMIT}。`,
  );
  return lines.join("\n");
}

function formatCustomUnreadStatus(unread: CustomUnreadRuntime, limit: number): string {
  const summary = inspectCustomUnreadRuntimeState(unread.getState(), { limit });
  const lines = [
    `👀 自定义未读状态`,
    ``,
    `peer：${summary.peerCount}`,
    `pending：${summary.totalPendingCount}`,
    `snapshots：${summary.snapshotCount}（policy-gated=${summary.policyGatedSnapshotCount}）`,
    `timers：followup=${summary.scheduledFollowupCount}, sleep=${summary.scheduledSleepDigestCount}`,
    `显示：${summary.peers.length}/${summary.peerCount}`,
  ];

  for (const peer of summary.peers) {
    lines.push(
      ``,
      `- ${peer.peerId}`,
      `  pending=${peer.pendingCount}, snapshots=${peer.snapshotCount}, gated=${peer.policyGatedSnapshotCount}`,
      `  followupActive=${peer.followupActive ? "yes" : "no"}, followupDue=${formatTime(peer.scheduledFollowupDueAt)}, sleepDue=${formatTime(peer.scheduledSleepDigestDueAt)}`,
      `  oldest=${formatTime(peer.oldestPendingAt)}, newest=${formatTime(peer.newestPendingAt)}`,
    );
  }

  if (summary.peerCount === 0) {
    lines.push(``, `暂无未读状态记录。`);
  }
  return lines.join("\n");
}

function formatTime(value?: number): string {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : "-";
}
