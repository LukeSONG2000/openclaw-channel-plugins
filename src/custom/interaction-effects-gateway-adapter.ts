import type { CustomInteractionGatewayResult } from "./interaction-gateway-adapter.js";
import type { CustomInteractionReplyTarget } from "./interaction-event-normalizer.js";

export type CustomInteractionGatewayHandledResult = Extract<CustomInteractionGatewayResult, { handled: true }>;

export interface CustomInteractionGatewayEffectsLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface ApplyCustomInteractionGatewayEffectsParams {
  accountId: string;
  result: CustomInteractionGatewayHandledResult;
  replyTarget?: CustomInteractionReplyTarget;
  persistAuthState?: () => void;
  persistPollState?: () => void;
  persistGameState?: () => void;
  persistDeployConfirmationState?: () => void;
  sendReply?: (target: CustomInteractionReplyTarget, text: string) => Promise<void> | void;
  log?: CustomInteractionGatewayEffectsLogger;
}

export interface ApplyCustomInteractionGatewayEffectsResult {
  authPersisted: boolean;
  pollsPersisted: boolean;
  gamesPersisted: boolean;
  deployConfirmationsPersisted: boolean;
  replyDelivered: boolean;
  replySkipped: boolean;
  replyFailed: boolean;
}

export async function applyCustomInteractionGatewayEffects(
  params: ApplyCustomInteractionGatewayEffectsParams,
): Promise<ApplyCustomInteractionGatewayEffectsResult> {
  const result: ApplyCustomInteractionGatewayEffectsResult = {
    authPersisted: false,
    pollsPersisted: false,
    gamesPersisted: false,
    deployConfirmationsPersisted: false,
    replyDelivered: false,
    replySkipped: false,
    replyFailed: false,
  };

  logCustomInteractionGatewayResult(params);

  const persist = params.result.persist;
  if (persist?.auth) {
    params.persistAuthState?.();
    result.authPersisted = Boolean(params.persistAuthState);
  }
  if (persist?.polls) {
    params.persistPollState?.();
    result.pollsPersisted = Boolean(params.persistPollState);
  }
  if (persist?.games) {
    params.persistGameState?.();
    result.gamesPersisted = Boolean(params.persistGameState);
  }
  if (persist?.deployConfirmations) {
    params.persistDeployConfirmationState?.();
    result.deployConfirmationsPersisted = Boolean(params.persistDeployConfirmationState);
  }

  if (params.result.reply) {
    if (!params.replyTarget || !params.sendReply) {
      result.replySkipped = true;
      return result;
    }
    try {
      await params.sendReply(params.replyTarget, params.result.reply);
      result.replyDelivered = true;
    } catch (sendErr) {
      result.replyFailed = true;
      params.log?.error?.(`[qqbot:${params.accountId}] Failed to send custom interaction reply: ${sendErr}`);
    }
  }

  return result;
}

function logCustomInteractionGatewayResult(params: ApplyCustomInteractionGatewayEffectsParams): void {
  for (const item of params.result.logs ?? []) {
    if (item.level === "error") {
      params.log?.error?.(`[qqbot:${params.accountId}] ${item.message}`);
    } else {
      params.log?.info?.(`[qqbot:${params.accountId}] ${item.message}`);
    }
  }
}
