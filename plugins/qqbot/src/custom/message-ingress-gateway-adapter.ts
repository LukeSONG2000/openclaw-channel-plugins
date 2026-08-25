import type { QueuedMessage } from "../message-queue.js";
import type { ResolvedQQBotAccount } from "../types.js";
import { applyCustomSceneRouteGateway, type ApplyCustomSceneRouteGatewayResult } from "./scene-route-gateway-adapter.js";
import { resolveCustomGatewayMessageRouteContext, type CustomGatewayMessageRouteContext } from "./gateway-message-routing.js";
import { startCustomC2CInputNotifyKeepAlive, type CustomC2CInputNotifyKeepAliveSession } from "./typing-keepalive-gateway-adapter.js";
import type { CustomAgentRoute, CustomRoutingRuntime } from "./route.js";

export interface CustomMessageIngressGatewayLogger {
  info?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface RunCustomMessageIngressGatewayParams<TEnvelopeOptions> {
  account: ResolvedQQBotAccount;
  event: QueuedMessage;
  cfg: unknown;
  getToken: () => Promise<string>;
  clearTokenCache: () => void;
  recordInboundActivity: () => void;
  resolveBaseRoute: (input: {
    cfg: unknown;
    channel: "qqbot";
    accountId: string;
    peer: CustomGatewayMessageRouteContext["routePeer"];
  }) => CustomAgentRoute;
  routing?: CustomRoutingRuntime | null;
  customRuntimeEnabled: boolean;
  resolveEnvelopeOptions: (cfg: unknown) => TEnvelopeOptions;
  log?: CustomMessageIngressGatewayLogger;
}

export type RunCustomMessageIngressGatewayResult<TEnvelopeOptions> =
  | {
      action: "stop";
      reason: Extract<ApplyCustomSceneRouteGatewayResult, { action: "stop" }>["reason"];
      typing: CustomC2CInputNotifyKeepAliveSession;
      messageRoute: CustomGatewayMessageRouteContext;
      sceneRoute: Extract<ApplyCustomSceneRouteGatewayResult, { action: "stop" }>;
    }
  | {
      action: "continue";
      typing: CustomC2CInputNotifyKeepAliveSession;
      messageRoute: CustomGatewayMessageRouteContext;
      baseRoute: CustomAgentRoute;
      route: CustomAgentRoute;
      envelopeOptions: TEnvelopeOptions;
      systemPrompts: string[];
      sceneRoute: Extract<ApplyCustomSceneRouteGatewayResult, { action: "continue" }>;
    };

export function runCustomMessageIngressGateway<TEnvelopeOptions>(
  params: RunCustomMessageIngressGatewayParams<TEnvelopeOptions>,
): RunCustomMessageIngressGatewayResult<TEnvelopeOptions> {
  const { account, event, log } = params;
  log?.debug?.(`[qqbot:${account.accountId}] Received message: ${JSON.stringify(event)}`);
  log?.info?.(`[qqbot:${account.accountId}] Processing message from ${event.senderId}: ${event.content}`);
  if (event.attachments?.length) {
    log?.info?.(`[qqbot:${account.accountId}] Attachments: ${event.attachments.length}`);
  }

  params.recordInboundActivity();

  const typing = startCustomC2CInputNotifyKeepAlive({
    accountId: account.accountId,
    message: event,
    getToken: params.getToken,
    clearTokenCache: params.clearTokenCache,
    log,
  });

  const messageRoute = resolveCustomGatewayMessageRouteContext(event);
  const baseRoute = params.resolveBaseRoute({
    cfg: params.cfg,
    channel: "qqbot",
    accountId: account.accountId,
    peer: messageRoute.routePeer,
  });

  const sceneRoute = applyCustomSceneRouteGateway({
    cfg: params.cfg as any,
    accountId: account.accountId,
    senderId: event.senderId,
    baseRoute,
    routePeer: messageRoute.routePeer,
    customScenePeer: messageRoute.customScenePeer,
    routing: params.routing,
    customRuntimeEnabled: params.customRuntimeEnabled,
    accountSystemPrompt: account.systemPrompt,
    log,
  });

  if (sceneRoute.action === "stop") {
    return {
      action: "stop",
      reason: sceneRoute.reason,
      typing,
      messageRoute,
      sceneRoute,
    };
  }

  return {
    action: "continue",
    typing,
    messageRoute,
    baseRoute,
    route: sceneRoute.route,
    envelopeOptions: params.resolveEnvelopeOptions(params.cfg),
    systemPrompts: sceneRoute.systemPrompts,
    sceneRoute,
  };
}
