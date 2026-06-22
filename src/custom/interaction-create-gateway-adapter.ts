import type { InteractionEvent } from "../types.js";
import { getKnownUser as defaultGetKnownUser } from "../known-users.js";
import type { CustomConfigInteractionConfigApi, CustomConfigInteractionRoutingApi } from "./config-interaction-gateway-adapter.js";
import {
  handleCustomConfigInteractionGateway,
  type HandleCustomConfigInteractionResult,
} from "./config-interaction-gateway-adapter.js";
import {
  applyCustomInteractionGatewayEffects,
  type ApplyCustomInteractionGatewayEffectsResult,
} from "./interaction-effects-gateway-adapter.js";
import {
  handleCustomInteractionGatewayButton,
  type CustomInteractionGatewayResult,
} from "./interaction-gateway-adapter.js";
import {
  normalizeQQBotInteractionEvent,
  parseLegacyApprovalInteractionButton,
  type CustomInteractionReplyTarget,
} from "./interaction-event-normalizer.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import { resolveKnownCustomActorLabel } from "./identity-presentation.js";

export interface CustomInteractionCreateGatewayLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface CustomLegacyApprovalInteractionHandler {
  resolveApproval: (approvalId: string, decision: "allow-once" | "allow-always" | "deny") => unknown;
}

export type CustomInteractionCreateRuntime = Pick<
  CustomMessageFlowRuntime,
  "auth" | "polls" | "games" | "deployConfirmations"
>;

export interface HandleCustomInteractionCreateGatewayParams {
  accountId: string;
  event: InteractionEvent;
  cfg: unknown;
  runtime?: CustomInteractionCreateRuntime;
  persistAuthState?: () => void;
  persistPollState?: () => void;
  persistGameState?: () => void;
  persistDeployConfirmationState?: () => void;
  getConfigApi: () => CustomConfigInteractionConfigApi;
  routing?: CustomConfigInteractionRoutingApi;
  acknowledge: (code?: 0, payload?: { claw_cfg: Record<string, unknown> }) => Promise<void>;
  pluginVersion: string;
  frameworkVersion: string;
  sendReply: (target: CustomInteractionReplyTarget, text: string) => Promise<void> | void;
  getLegacyApprovalHandler?: (accountId: string) => CustomLegacyApprovalInteractionHandler | undefined;
  now?: number;
  log?: CustomInteractionCreateGatewayLogger;
  handleConfigInteraction?: typeof handleCustomConfigInteractionGateway;
  handleButton?: typeof handleCustomInteractionGatewayButton;
  applyEffects?: typeof applyCustomInteractionGatewayEffects;
  getKnownUser?: typeof defaultGetKnownUser;
}

export type HandleCustomInteractionCreateGatewayResult =
  | {
      kind: "config";
      interactionId: string;
      configInteraction: Extract<HandleCustomConfigInteractionResult, { handled: true }>;
    }
  | {
      kind: "custom-button";
      interactionId: string;
      customInteraction: Extract<CustomInteractionGatewayResult, { handled: true }>;
      effects: ApplyCustomInteractionGatewayEffectsResult;
    }
  | {
      kind: "legacy-approval";
      interactionId: string;
      approvalId: string;
      decision: "allow-once" | "allow-always" | "deny";
      handlerFound: boolean;
    }
  | {
      kind: "ack-only";
      interactionId: string;
    };

export async function handleCustomInteractionCreateGateway(
  params: HandleCustomInteractionCreateGatewayParams,
): Promise<HandleCustomInteractionCreateGatewayResult> {
  const interaction = normalizeQQBotInteractionEvent(params.event);
  const handleConfigInteraction = params.handleConfigInteraction ?? handleCustomConfigInteractionGateway;
  const configInteraction = await handleConfigInteraction({
    accountId: params.accountId,
    interaction,
    getConfigApi: params.getConfigApi,
    routing: params.routing,
    acknowledge: (code, payload) => params.acknowledge(code, payload),
    pluginVersion: params.pluginVersion,
    frameworkVersion: params.frameworkVersion,
    log: params.log,
  });
  if (configInteraction.handled) {
    return {
      kind: "config",
      interactionId: interaction.id,
      configInteraction,
    };
  }

  await params.acknowledge();
  params.log?.debug?.(`[qqbot:${params.accountId}] Interaction ACK sent: ${interaction.id}`);

  const handleButton = params.handleButton ?? handleCustomInteractionGatewayButton;
  const actorLabel = resolveKnownCustomActorLabel({
    accountId: params.accountId,
    actorId: interaction.actorId,
    peer: interaction.sourcePeer,
    getKnownUser: params.getKnownUser ?? defaultGetKnownUser,
  });
  const customInteraction = params.runtime ? handleButton({
    cfg: params.cfg as any,
    accountId: params.accountId,
    runtime: params.runtime,
    buttonData: interaction.buttonData,
    actor: {
      id: interaction.actorId,
      label: actorLabel,
    },
    sourcePeer: interaction.sourcePeer,
    now: params.now ?? Date.now(),
  }) : { handled: false } as CustomInteractionGatewayResult;

  if (customInteraction.handled) {
    const applyEffects = params.applyEffects ?? applyCustomInteractionGatewayEffects;
    const effects = await applyEffects({
      accountId: params.accountId,
      result: customInteraction,
      cfg: params.cfg as any,
      getConfigApi: params.getConfigApi,
      replyTarget: interaction.replyTarget,
      persistAuthState: params.persistAuthState,
      persistPollState: params.persistPollState,
      persistGameState: params.persistGameState,
      persistDeployConfirmationState: params.persistDeployConfirmationState,
      sendReply: params.sendReply,
      log: params.log,
    });
    return {
      kind: "custom-button",
      interactionId: interaction.id,
      customInteraction,
      effects,
    };
  }

  const legacyApproval = parseLegacyApprovalInteractionButton(interaction.buttonData);
  if (legacyApproval) {
    params.log?.info?.(`[qqbot:${params.accountId}] Approval button clicked: approvalId=${legacyApproval.approvalId}, decision=${legacyApproval.decision}, user=${interaction.actorId}, buttonData=${interaction.buttonData}`);
    const handler = params.getLegacyApprovalHandler?.(params.accountId);
    if (handler) {
      void handler.resolveApproval(legacyApproval.approvalId, legacyApproval.decision);
    } else {
      params.log?.error?.(`[qqbot:${params.accountId}] Approval button: no handler found for accountId=${params.accountId}`);
    }
    return {
      kind: "legacy-approval",
      interactionId: interaction.id,
      approvalId: legacyApproval.approvalId,
      decision: legacyApproval.decision,
      handlerFound: Boolean(handler),
    };
  }

  return {
    kind: "ack-only",
    interactionId: interaction.id,
  };
}
