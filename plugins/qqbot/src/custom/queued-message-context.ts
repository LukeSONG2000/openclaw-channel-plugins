import type { QueuedMessage } from "../message-queue.js";
import type { CustomActor, CustomPeer } from "./types.js";

export interface CustomQueuedMessagePeerOptions {
  /**
   * Optional queue peer fallback such as `group:<openid>` when the queued
   * message lacks a platform-specific peer field.
   */
  queuePeerId?: string;
}

export function toCustomPeerFromQueuedMessage(
  message: QueuedMessage,
  options: CustomQueuedMessagePeerOptions = {},
): CustomPeer {
  if (message.type === "group") {
    return {
      kind: "group",
      id: message.groupOpenid ?? stripQueuePeerPrefix(options.queuePeerId) ?? "unknown",
    };
  }
  if (message.type === "guild") {
    return {
      kind: "channel",
      id: message.channelId ?? stripQueuePeerPrefix(options.queuePeerId) ?? "unknown",
    };
  }
  if (message.type === "dm") {
    return {
      kind: "dm",
      id: message.senderId,
    };
  }
  return {
    kind: "c2c",
    id: message.senderId,
  };
}

export function toCustomActorFromQueuedMessage(message: QueuedMessage): CustomActor {
  return {
    id: message.senderId,
    label: message.senderName,
    isBot: message.senderIsBot,
  };
}

export function stripQueuePeerPrefix(queuePeerId?: string): string | undefined {
  if (!queuePeerId) return undefined;
  const idx = queuePeerId.indexOf(":");
  return idx >= 0 ? queuePeerId.slice(idx + 1) : queuePeerId;
}
