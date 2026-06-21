import type { QueuedMessage } from "../message-queue.js";
import type { DeliverAccountContext, DeliverEventContext } from "../outbound-deliver.js";
import type { MessageTarget, ReplyContext } from "../reply-dispatcher.js";
import {
  buildCustomDispatchSendHelpers,
  type CustomDispatchSendHelpers,
} from "./dispatch-send-helpers-gateway-adapter.js";
import {
  applyCustomGuardedMediaAutoSend,
  type CustomGuardedMediaAutoSendParams,
  type CustomGuardedMediaSendResult,
} from "./guarded-media-send-gateway-adapter.js";
import {
  buildCustomOutboundDeliverContext,
  buildCustomOutboundProactiveSource,
  type CustomOutboundProactiveSource,
} from "./outbound-deliver-context.js";
import { buildCustomGatewayReplyContext } from "./reply-context-gateway-adapter.js";
import type { CustomProactiveSendGuard } from "./proactive-send-guard.js";

export interface CustomDispatchSetupGatewayLogger {
  info: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomDispatchSetupProactiveGuardResult {
  proactiveGuard: CustomProactiveSendGuard;
}

export interface ApplyCustomDispatchSetupGatewayParams {
  event: QueuedMessage;
  account: ReplyContext["account"] & DeliverAccountContext["account"];
  cfg: unknown;
  qualifiedTarget: string;
  buildProactiveGuard: (source?: CustomOutboundProactiveSource) => CustomDispatchSetupProactiveGuardResult;
  sendMedia: CustomGuardedMediaAutoSendParams["sendMedia"];
  log?: CustomDispatchSetupGatewayLogger;
}

export interface ApplyCustomDispatchSetupGatewayResult extends CustomDispatchSendHelpers {
  replyAnchorId?: string;
  replyTarget: MessageTarget;
  replyContext: ReplyContext;
  deliverEvent: DeliverEventContext;
  deliverAccountContext: DeliverAccountContext;
  sendGuardedMediaAuto: (mediaUrl: string, label: string) => Promise<CustomGuardedMediaSendResult>;
}

export function applyCustomDispatchSetupGateway(
  params: ApplyCustomDispatchSetupGatewayParams,
): ApplyCustomDispatchSetupGatewayResult {
  const replyProactive = params.buildProactiveGuard();
  const {
    replyAnchorId,
    replyTarget,
    replyContext,
  } = buildCustomGatewayReplyContext({
    event: params.event,
    account: params.account,
    cfg: params.cfg,
    log: params.log,
    prepareUnanchoredTextSend: replyProactive.proactiveGuard,
  });

  const sendHelpers = buildCustomDispatchSendHelpers({
    account: params.account,
    replyContext,
    log: params.log,
  });

  const deliverProactive = params.buildProactiveGuard(buildCustomOutboundProactiveSource(params.event));
  const {
    deliverEvent,
    deliverAccountContext,
  } = buildCustomOutboundDeliverContext({
    event: params.event,
    replyAnchorId,
    account: params.account,
    qualifiedTarget: params.qualifiedTarget,
    log: params.log,
    proactiveGuard: deliverProactive.proactiveGuard,
  });

  return {
    replyAnchorId,
    replyTarget,
    replyContext,
    ...sendHelpers,
    deliverEvent,
    deliverAccountContext,
    sendGuardedMediaAuto: (mediaUrl, label) => applyCustomGuardedMediaAutoSend({
      mediaUrl,
      label,
      event: deliverEvent,
      accountContext: deliverAccountContext,
      sendMedia: params.sendMedia,
    }),
  };
}
