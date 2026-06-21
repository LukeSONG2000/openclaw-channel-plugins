import type { QueuedMessage } from "../message-queue.js";
import { buildCustomFallbackEvent, type CustomFallbackEvent } from "./fallbacks.js";
import type { CustomActor, CustomPeer } from "./types.js";

const CUSTOM_URGENT_QUEUE_BYPASS_COMMAND_SET = new Set([
  "/stop",
  "/approve",
  "/new",
  "/compact",
]);

export const CUSTOM_URGENT_QUEUE_BYPASS_COMMANDS = [...CUSTOM_URGENT_QUEUE_BYPASS_COMMAND_SET];

export interface CustomUrgentQueueSnapshot {
  totalPending: number;
  activeUsers: number;
  maxConcurrentUsers: number;
  senderPending: number;
}

export interface BuildCustomUrgentQueueBypassEventParams {
  accountId: string;
  peer: CustomPeer;
  actor: CustomActor;
  messageId: string;
  command: string;
  queuePeerId: string;
  droppedQueuedMessages: number;
  queueBefore: CustomUrgentQueueSnapshot;
  queueAfter: CustomUrgentQueueSnapshot;
}

export function isCustomUrgentQueueBypassCommand(content: string | null | undefined): boolean {
  return resolveCustomUrgentQueueBypassCommand(content) !== null;
}

export function resolveCustomUrgentQueueBypassCommand(content: string | null | undefined): string | null {
  const commandToken = firstSlashCommandToken(content);
  return commandToken && CUSTOM_URGENT_QUEUE_BYPASS_COMMAND_SET.has(commandToken) ? commandToken : null;
}

export function resolveCustomUrgentQueuePeer(msg: QueuedMessage, queuePeerId: string): CustomPeer {
  if (msg.type === "group") {
    return { kind: "group", id: msg.groupOpenid ?? stripQueuePeerPrefix(queuePeerId) };
  }
  if (msg.type === "guild") {
    return { kind: "channel", id: msg.channelId ?? stripQueuePeerPrefix(queuePeerId) };
  }
  if (msg.type === "dm") {
    return { kind: "dm", id: msg.senderId, label: msg.senderName };
  }
  return { kind: "c2c", id: msg.senderId, label: msg.senderName };
}

export function buildCustomUrgentQueueBypassEvent(params: BuildCustomUrgentQueueBypassEventParams): CustomFallbackEvent {
  return buildCustomFallbackEvent({
    kind: "urgent-queue-bypass",
    accountId: params.accountId,
    peer: params.peer,
    actor: params.actor,
    runId: params.messageId,
    messageId: params.messageId,
    reason: `urgent command ${params.command} bypassed peer queue; dropped ${params.droppedQueuedMessages} queued message(s)`,
    details: {
      command: params.command,
      queuePeerId: params.queuePeerId,
      droppedQueuedMessages: params.droppedQueuedMessages,
      queueTotalPending: params.queueBefore.totalPending,
      queueActiveUsers: params.queueBefore.activeUsers,
      queueMaxConcurrentUsers: params.queueBefore.maxConcurrentUsers,
      queueSenderPending: params.queueBefore.senderPending,
      queueAfterTotalPending: params.queueAfter.totalPending,
      queueAfterSenderPending: params.queueAfter.senderPending,
    },
  });
}

function firstSlashCommandToken(content: string | null | undefined): string | null {
  const trimmed = (content ?? "").trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed.split(/\s+/, 1)[0]?.toLowerCase() ?? null;
}

function stripQueuePeerPrefix(queuePeerId: string): string {
  const idx = queuePeerId.indexOf(":");
  return idx >= 0 ? queuePeerId.slice(idx + 1) : queuePeerId;
}
