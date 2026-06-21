import type { InlineKeyboard } from "../types.js";
import type { CustomSlashGatewayReply } from "./slash-gateway-adapter.js";

type CustomSlashAuthApprovalReply = Extract<CustomSlashGatewayReply, { kind: "auth-approval" }>;
export type CustomSlashAdminGroupNotification = NonNullable<CustomSlashAuthApprovalReply["adminGroupNotification"]>;

export interface CustomSlashReplyDeliveryLogger {
  error?: (msg: string) => void;
}

export interface DeliverCustomSlashGatewayReplyParams {
  accountId: string;
  reply: CustomSlashGatewayReply;
  sendText: (text: string) => Promise<void>;
  sendKeyboard: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
  sendAdminGroupNotification?: (notification: CustomSlashAdminGroupNotification) => Promise<void>;
  log?: CustomSlashReplyDeliveryLogger;
}

export type DeliverCustomSlashGatewayReplyResult =
  | {
      kind: "text";
    }
  | {
      kind: "keyboard";
      fallbackToText: boolean;
    }
  | {
      kind: "auth-approval";
      approvalCardSent: boolean;
      adminGroupNotified: boolean;
      fallbackToDenialText: boolean;
    };

export async function deliverCustomSlashGatewayReply(
  params: DeliverCustomSlashGatewayReplyParams,
): Promise<DeliverCustomSlashGatewayReplyResult> {
  if (params.reply.kind === "text") {
    await params.sendText(params.reply.text);
    return { kind: "text" };
  }

  if (params.reply.kind === "keyboard") {
    try {
      await params.sendKeyboard(params.reply.text, params.reply.keyboard);
      return { kind: "keyboard", fallbackToText: false };
    } catch (sendErr) {
      params.log?.error?.(`[qqbot:${params.accountId}] Failed to send custom slash keyboard reply, falling back to text: ${sendErr}`);
      await params.sendText(params.reply.text);
      return { kind: "keyboard", fallbackToText: true };
    }
  }

  if (params.reply.approvalText && params.reply.keyboard) {
    try {
      await params.sendKeyboard(params.reply.approvalText, params.reply.keyboard);
      const adminGroupNotified = await notifyAdminGroup(params, params.reply.adminGroupNotification);
      return {
        kind: "auth-approval",
        approvalCardSent: true,
        adminGroupNotified,
        fallbackToDenialText: false,
      };
    } catch (sendErr) {
      params.log?.error?.(`[qqbot:${params.accountId}] Failed to send custom auth approval card, falling back to text: ${sendErr}`);
    }
  }

  await params.sendText(params.reply.denialText);
  const adminGroupNotified = await notifyAdminGroup(params, params.reply.adminGroupNotification);
  return {
    kind: "auth-approval",
    approvalCardSent: false,
    adminGroupNotified,
    fallbackToDenialText: true,
  };
}

async function notifyAdminGroup(
  params: DeliverCustomSlashGatewayReplyParams,
  notification: CustomSlashAdminGroupNotification | null | undefined,
): Promise<boolean> {
  if (!notification || !params.sendAdminGroupNotification) return false;
  await params.sendAdminGroupNotification(notification);
  return true;
}
