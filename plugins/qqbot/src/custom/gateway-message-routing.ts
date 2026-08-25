import type { QueuedMessage } from "../message-queue.js";
import type { MessageTarget } from "../reply-dispatcher.js";
import type { CustomRoutePeer } from "./route.js";
import type { CustomPeer } from "./types.js";

export interface CustomGatewayMessageRouteContext {
  isGroupChat: boolean;
  peerId: string;
  routePeer: CustomRoutePeer;
  customScenePeer: CustomPeer;
  fromAddress: string;
  toAddress: string;
  /**
   * Existing request-context target used by reminder/media delivery paths.
   * Guild handling intentionally preserves current gateway behavior.
   */
  requestTarget: string;
}

export function resolveCustomGatewayMessageRouteContext(event: QueuedMessage): CustomGatewayMessageRouteContext {
  const isGroupChat = event.type === "guild" || event.type === "group";
  const peerId = resolveGatewayPeerId(event);
  const fromAddress = resolveGatewayFromAddress(event);
  return {
    isGroupChat,
    peerId,
    routePeer: {
      kind: isGroupChat ? "group" : "direct",
      id: peerId,
    },
    customScenePeer: {
      kind: event.type === "guild" ? "channel" : event.type === "group" ? "group" : event.type === "dm" ? "dm" : "c2c",
      id: peerId,
    },
    fromAddress,
    toAddress: fromAddress,
    requestTarget: isGroupChat ? `qqbot:group:${event.groupOpenid}` : `qqbot:c2c:${event.senderId}`,
  };
}

export function resolveCustomGatewayMessageReplyTarget(
  event: QueuedMessage,
  messageId: string,
): MessageTarget {
  return {
    type: event.type,
    senderId: event.senderId,
    messageId,
    channelId: event.channelId,
    groupOpenid: event.groupOpenid,
  };
}

function resolveGatewayPeerId(event: QueuedMessage): string {
  if (event.type === "guild") return event.channelId ?? "unknown";
  if (event.type === "group") return event.groupOpenid ?? "unknown";
  return event.senderId;
}

function resolveGatewayFromAddress(event: QueuedMessage): string {
  if (event.type === "guild") return `qqbot:channel:${event.channelId}`;
  if (event.type === "group") return `qqbot:group:${event.groupOpenid}`;
  return `qqbot:c2c:${event.senderId}`;
}
