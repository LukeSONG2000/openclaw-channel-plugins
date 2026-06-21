import type {
  DeliverAccountContext,
  DeliverEventContext,
} from "../outbound-deliver.js";
import { prepareCustomProactiveSend } from "./proactive-send-guard.js";

export interface CustomGuardedMediaSendResult {
  channel: string;
  error?: string;
}

export interface CustomMediaAutoSendInput {
  to: string;
  text: string;
  mediaUrl: string;
  accountId: string;
  replyToId?: string;
  account: DeliverAccountContext["account"];
}

export interface CustomGuardedMediaAutoSendParams {
  mediaUrl: string;
  label: string;
  event: DeliverEventContext;
  accountContext: DeliverAccountContext;
  sendMedia: (input: CustomMediaAutoSendInput) => Promise<CustomGuardedMediaSendResult>;
}

export async function applyCustomGuardedMediaAutoSend(
  params: CustomGuardedMediaAutoSendParams,
): Promise<CustomGuardedMediaSendResult> {
  const proactiveGuardDecision = prepareCustomProactiveSend(
    params.event,
    params.accountContext,
    {
      kind: "media",
      mediaUrl: params.mediaUrl,
      text: formatProactiveMediaText(params.mediaUrl),
    },
  );
  if (!proactiveGuardDecision.allowed) {
    const reason = `${params.label} blocked by custom proactive guard: ${proactiveGuardDecision.reason}`;
    params.accountContext.log?.error(`[qqbot:${params.accountContext.account.accountId}] ${reason}`);
    return { channel: "qqbot", error: reason };
  }

  const result = await params.sendMedia({
    to: params.accountContext.qualifiedTarget,
    text: "",
    mediaUrl: params.mediaUrl,
    accountId: params.accountContext.account.accountId,
    replyToId: params.event.replyToId,
    account: params.accountContext.account,
  });
  if (!result.error) {
    proactiveGuardDecision.commit?.();
  }
  return result;
}

function formatProactiveMediaText(mediaUrl: string): string {
  const compactUrl = mediaUrl.length <= 200 ? mediaUrl : `${mediaUrl.slice(0, 200)}...`;
  return `[media] ${compactUrl}`;
}
