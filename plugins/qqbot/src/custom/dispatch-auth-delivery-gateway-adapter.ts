import type { QueuedMessage } from "../message-queue.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { InlineKeyboard } from "../types.js";
import {
  buildCustomAuthAdminGroupNotification,
  buildCustomAuthApprovalKeyboard,
  buildCustomAuthApprovalText,
  firstCustomAuthApprovalRequest,
  formatCustomDispatchAuthorizationDeniedMessage,
  type CustomAuthAdminGroupNotification,
  type CustomDispatchAuthorizationDecision,
} from "./auth-gateway-adapter.js";
import { prefixCustomUserFeedbackMention } from "./identity-presentation.js";

export type CustomDispatchAuthApprovalCardTarget =
  | { kind: "c2c"; userOpenid: string; messageId: string }
  | { kind: "group"; groupOpenid: string; messageId: string };

export interface CustomDispatchAuthDenialDeliveryResult {
  handled: boolean;
  delivery?: "approval-card" | "text";
  requestId?: string;
  adminGroupNotification?: CustomAuthAdminGroupNotification | null;
}

export async function applyCustomDispatchAuthDenialDelivery(params: {
  cfg?: OpenClawConfig;
  decision: CustomDispatchAuthorizationDecision;
  message: QueuedMessage;
  sendText: (text: string) => Promise<void>;
  sendApprovalCard?: (
    target: CustomDispatchAuthApprovalCardTarget,
    text: string,
    keyboard: InlineKeyboard,
  ) => Promise<void>;
  log?: { error?: (msg: string) => void };
}): Promise<CustomDispatchAuthDenialDeliveryResult> {
  if (!params.decision.enabled || params.decision.reason !== "denied") {
    return { handled: false };
  }

  const request = params.decision.result?.intents
    ? firstCustomAuthApprovalRequest(params.decision.result.intents)
    : null;
  const baseDenialText = formatCustomDispatchAuthorizationDeniedMessage(params.decision);
  const baseApprovalText = request ? buildCustomAuthApprovalText(request, params.cfg ?? params.decision.cfg) : undefined;
  const denialText = prefixDispatchAuthFeedback(baseDenialText, params.decision);
  const approvalText = baseApprovalText;
  const approvalKeyboard = request ? buildCustomAuthApprovalKeyboard(request) : undefined;

  const cardTarget = resolveDispatchAuthApprovalCardTarget(params.message);
  if (request && approvalText && approvalKeyboard && cardTarget && params.sendApprovalCard) {
    try {
      await params.sendApprovalCard(cardTarget, approvalText, approvalKeyboard);
      return {
        handled: true,
        delivery: "approval-card",
        requestId: request.id,
        adminGroupNotification: buildCustomAuthAdminGroupNotification({
          request,
          sourcePeer: params.decision.peer,
          text: baseApprovalText!,
          keyboard: approvalKeyboard,
          copyToAdminGroup: resolveCopyRequestsToAdminGroup(params.cfg ?? params.decision.cfg),
        }),
      };
    } catch (sendErr) {
      params.log?.error?.(`Failed to send dispatch auth approval card, falling back to text: ${sendErr}`);
    }
  }

  await params.sendText(denialText);
  return {
    handled: true,
    delivery: "text",
    requestId: request?.id,
    adminGroupNotification: request && approvalText
      ? buildCustomAuthAdminGroupNotification({
          request,
          sourcePeer: params.decision.peer,
          text: baseApprovalText!,
          keyboard: approvalKeyboard,
          copyToAdminGroup: resolveCopyRequestsToAdminGroup(params.cfg ?? params.decision.cfg),
        })
      : null,
  };
}

function resolveCopyRequestsToAdminGroup(cfg: unknown): boolean {
  return (cfg as any)?.channels?.qqbot?.customRuntime?.auth?.copyRequestsToAdminGroup !== false;
}

function prefixDispatchAuthFeedback(text: string, decision: CustomDispatchAuthorizationDecision): string {
  return prefixCustomUserFeedbackMention(text, {
    peer: decision.peer,
    actor: decision.actor,
  });
}

function resolveDispatchAuthApprovalCardTarget(message: QueuedMessage): CustomDispatchAuthApprovalCardTarget | null {
  if (message.type === "c2c") {
    return { kind: "c2c", userOpenid: message.senderId, messageId: message.messageId };
  }
  if (message.type === "group" && message.groupOpenid) {
    return { kind: "group", groupOpenid: message.groupOpenid, messageId: message.messageId };
  }
  return null;
}
