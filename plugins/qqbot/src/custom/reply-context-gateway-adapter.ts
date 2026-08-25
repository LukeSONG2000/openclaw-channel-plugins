import type { QueuedMessage } from "../message-queue.js";
import type { MessageTarget, ReplyContext } from "../reply-dispatcher.js";
import { resolveCustomGatewayMessageReplyTarget } from "./gateway-message-routing.js";

export interface CustomGatewayReplyContextBuildParams {
  event: QueuedMessage;
  account: ReplyContext["account"];
  cfg: unknown;
  log?: ReplyContext["log"];
  prepareUnanchoredTextSend?: ReplyContext["prepareUnanchoredTextSend"];
}

export interface CustomGatewayReplyContextBuildResult {
  replyAnchorId?: string;
  replyTarget: MessageTarget;
  replyContext: ReplyContext;
}

export function buildCustomGatewayReplyContext(
  params: CustomGatewayReplyContextBuildParams,
): CustomGatewayReplyContextBuildResult {
  const replyAnchorId = resolveCustomReplyAnchorId(params.event);
  const replyTarget = resolveCustomGatewayMessageReplyTarget(params.event, replyAnchorId ?? "");
  return {
    replyAnchorId,
    replyTarget,
    replyContext: {
      target: replyTarget,
      account: params.account,
      cfg: params.cfg,
      log: params.log,
      prepareUnanchoredTextSend: params.prepareUnanchoredTextSend,
    },
  };
}

export function resolveCustomReplyAnchorId(
  event: Pick<QueuedMessage, "messageId" | "_customUnreadSnapshotId">,
): string | undefined {
  return event._customUnreadSnapshotId ? undefined : event.messageId;
}
