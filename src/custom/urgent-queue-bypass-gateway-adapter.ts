import type { QueuedMessage } from "../message-queue.js";
import type { QueueSnapshot } from "../slash-commands.js";
import type { CustomFallbackEvent } from "./fallbacks.js";
import {
  buildCustomUrgentQueueBypassEvent,
  resolveCustomUrgentQueueBypassCommand,
  resolveCustomUrgentQueuePeer,
} from "./urgent-commands.js";

export interface CustomUrgentQueueBypassLogger {
  info?: (msg: string) => void;
}

export interface CustomUrgentQueueBypassQueue {
  getMessagePeerId: (msg: QueuedMessage) => string;
  getSnapshot: (peerId: string) => QueueSnapshot;
  clearUserQueue: (peerId: string) => number;
  executeImmediate: (msg: QueuedMessage) => void;
}

export interface ApplyCustomUrgentQueueBypassParams {
  accountId: string;
  content: string;
  message: QueuedMessage;
  queue: CustomUrgentQueueBypassQueue;
  recordFallbackEvent?: (event: CustomFallbackEvent) => void;
  log?: CustomUrgentQueueBypassLogger;
}

export type ApplyCustomUrgentQueueBypassResult =
  | { handled: false }
  | {
      handled: true;
      command: string;
      peerId: string;
      droppedQueuedMessages: number;
      event: CustomFallbackEvent;
    };

export function applyCustomUrgentQueueBypass(
  params: ApplyCustomUrgentQueueBypassParams,
): ApplyCustomUrgentQueueBypassResult {
  const command = resolveCustomUrgentQueueBypassCommand(params.content);
  if (!command) return { handled: false };

  params.log?.info?.(`[qqbot:${params.accountId}] Urgent command detected: ${params.content.slice(0, 20)}, executing immediately`);
  const peerId = params.queue.getMessagePeerId(params.message);
  const queueBefore = params.queue.getSnapshot(peerId);
  const droppedQueuedMessages = params.queue.clearUserQueue(peerId);
  const queueAfter = params.queue.getSnapshot(peerId);

  if (droppedQueuedMessages > 0) {
    params.log?.info?.(`[qqbot:${params.accountId}] Dropped ${droppedQueuedMessages} queued messages for ${peerId} due to urgent command`);
  }

  const event = buildCustomUrgentQueueBypassEvent({
    accountId: params.accountId,
    peer: resolveCustomUrgentQueuePeer(params.message, peerId),
    actor: {
      id: params.message.senderId,
      label: params.message.senderName,
      isBot: params.message.senderIsBot,
    },
    messageId: params.message.messageId,
    command,
    queuePeerId: peerId,
    droppedQueuedMessages,
    queueBefore,
    queueAfter,
  });

  params.recordFallbackEvent?.(event);
  params.queue.executeImmediate(params.message);

  return {
    handled: true,
    command,
    peerId,
    droppedQueuedMessages,
    event,
  };
}
