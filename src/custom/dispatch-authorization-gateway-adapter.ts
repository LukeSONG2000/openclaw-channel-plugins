import type { QueuedMessage } from "../message-queue.js";
import type { InlineKeyboard } from "../types.js";
import {
  checkCustomDispatchAuthorization,
  describeCustomAuthorizationIntents,
  type CustomDispatchAuthorizationDecision,
} from "./auth-gateway-adapter.js";
import type { CustomAuthorizationRuntime } from "./auth.js";
import {
  applyCustomDispatchAuthDenialDelivery,
  type CustomDispatchAuthApprovalCardTarget,
  type CustomDispatchAuthDenialDeliveryResult,
} from "./dispatch-auth-delivery-gateway-adapter.js";
import type { CustomAuthAdminGroupNotification } from "./auth-gateway-adapter.js";

export interface CustomDispatchAuthorizationGatewayResult {
  decision: CustomDispatchAuthorizationDecision;
  shouldStop: boolean;
  denialDelivery?: CustomDispatchAuthDenialDeliveryResult;
}

export interface CustomDispatchAuthorizationGatewayParams {
  cfg: unknown;
  auth: CustomAuthorizationRuntime;
  message: QueuedMessage;
  rawContent: string;
  accountId: string;
  now?: number;
  persistAuthState: () => void;
  sendText: (text: string) => Promise<void>;
  sendApprovalCard?: (
    target: CustomDispatchAuthApprovalCardTarget,
    text: string,
    keyboard: InlineKeyboard,
  ) => Promise<void>;
  notifyAdminGroup?: (notification: CustomAuthAdminGroupNotification & { source: "dispatch" }) => Promise<void>;
  log?: {
    info?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

export async function applyCustomDispatchAuthorizationGateway(
  params: CustomDispatchAuthorizationGatewayParams,
): Promise<CustomDispatchAuthorizationGatewayResult> {
  const decision = checkCustomDispatchAuthorization({
    cfg: params.cfg as any,
    auth: params.auth,
    message: params.message,
    rawContent: params.rawContent,
    now: params.now,
  });

  if (decision.enabled && decision.result?.intents.length) {
    for (const item of describeCustomAuthorizationIntents(decision.result.intents)) {
      params.log?.info?.(`[qqbot:${params.accountId}] custom auth: ${item}`);
    }
    params.persistAuthState();
  }

  if (!decision.enabled || decision.reason !== "denied") {
    return { decision, shouldStop: false };
  }

  params.log?.info?.(`[qqbot:${params.accountId}] Message dispatch denied by custom auth: capability=${decision.capability} sender=${params.message.senderId}`);
  const denialDelivery = await applyCustomDispatchAuthDenialDelivery({
    cfg: params.cfg as any,
    decision,
    message: params.message,
    sendText: params.sendText,
    sendApprovalCard: params.sendApprovalCard,
    log: {
      error: (msg) => params.log?.error?.(`[qqbot:${params.accountId}] ${msg}`),
    },
  });
  if (denialDelivery.adminGroupNotification) {
    await params.notifyAdminGroup?.({
      ...denialDelivery.adminGroupNotification,
      source: "dispatch",
    });
  }
  return {
    decision,
    denialDelivery,
    shouldStop: true,
  };
}
