import type { QueuedMessage } from "../message-queue.js";
import type {
  DeliverAccountContext,
  DeliverEventContext,
} from "../outbound-deliver.js";

export interface CustomOutboundDeliverContextParams {
  event: QueuedMessage;
  replyAnchorId?: string;
  account: DeliverAccountContext["account"];
  qualifiedTarget: string;
  log?: DeliverAccountContext["log"];
  proactiveGuard?: DeliverAccountContext["proactiveGuard"];
}

export interface CustomOutboundDeliverContext {
  deliverEvent: DeliverEventContext;
  deliverAccountContext: DeliverAccountContext;
}

export interface CustomOutboundProactiveSource {
  actor: {
    id: string;
    label?: string;
    isBot?: boolean;
  };
  messageId: string;
  timestamp: number;
}

export function buildCustomOutboundDeliverContext(
  params: CustomOutboundDeliverContextParams,
): CustomOutboundDeliverContext {
  return {
    deliverEvent: buildCustomOutboundDeliverEvent(params.event, params.replyAnchorId),
    deliverAccountContext: {
      account: params.account,
      qualifiedTarget: params.qualifiedTarget,
      log: params.log,
      proactiveGuard: params.proactiveGuard,
    },
  };
}

export function buildCustomOutboundDeliverEvent(
  event: QueuedMessage,
  replyAnchorId?: string,
): DeliverEventContext {
  return {
    type: event.type,
    senderId: event.senderId,
    messageId: event.messageId,
    replyToId: replyAnchorId,
    channelId: event.channelId,
    groupOpenid: event.groupOpenid,
    msgIdx: event.msgIdx,
  };
}

export function buildCustomOutboundProactiveSource(
  event: Pick<QueuedMessage, "senderId" | "senderName" | "senderIsBot" | "messageId" | "timestamp">,
): CustomOutboundProactiveSource {
  return {
    actor: {
      id: event.senderId,
      label: event.senderName,
      isBot: event.senderIsBot,
    },
    messageId: event.messageId,
    timestamp: new Date(event.timestamp).getTime(),
  };
}
