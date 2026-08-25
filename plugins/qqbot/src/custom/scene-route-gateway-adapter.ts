import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveCustomSceneState } from "./config.js";
import { applyCustomSceneAgentRoute, type CustomAgentRoute, type CustomRoutePeer, type CustomRoutingRuntime } from "./route.js";
import { buildCustomSceneSystemPrompt, type ResolvedCustomScene } from "./scenes.js";
import type { CustomPeer } from "./types.js";

export interface CustomSceneRouteGatewayLogger {
  info?: (msg: string) => void;
}

export interface ApplyCustomSceneRouteGatewayParams {
  cfg: OpenClawConfig;
  accountId: string;
  senderId: string;
  baseRoute: CustomAgentRoute;
  routePeer: CustomRoutePeer;
  customScenePeer: CustomPeer;
  routing?: CustomRoutingRuntime | null;
  customRuntimeEnabled: boolean;
  accountSystemPrompt?: string;
  log?: CustomSceneRouteGatewayLogger;
}

export type ApplyCustomSceneRouteGatewayResult =
  | {
      action: "stop";
      reason: "scene_disabled";
      route: CustomAgentRoute;
      scene: ResolvedCustomScene;
      systemPrompts: string[];
    }
  | {
      action: "continue";
      route: CustomAgentRoute;
      scene: ResolvedCustomScene | null;
      systemPrompts: string[];
    };

export function applyCustomSceneRouteGateway(
  params: ApplyCustomSceneRouteGatewayParams,
): ApplyCustomSceneRouteGatewayResult {
  const systemPrompts = params.accountSystemPrompt ? [params.accountSystemPrompt] : [];
  const scene = params.customRuntimeEnabled
    ? resolveCustomSceneState(params.cfg, params.customScenePeer)
    : null;

  if (scene && !scene.enabled) {
    params.log?.info?.(`[qqbot:${params.accountId}] Custom scene disabled for ${scene.key}, skipping message from ${params.senderId}`);
    return {
      action: "stop",
      reason: "scene_disabled",
      route: params.baseRoute,
      scene,
      systemPrompts,
    };
  }

  const route = applyCustomSceneAgentRoute({
    route: params.baseRoute,
    scene,
    routing: params.routing,
    peer: params.routePeer,
    cfg: params.cfg as Record<string, unknown>,
  });
  if (scene?.config.agentId) {
    params.log?.info?.(`[qqbot:${params.accountId}] Custom scene route: scene=${scene.key}, agentId=${route.agentId}, sessionKey=${route.sessionKey}`);
  }
  if (scene) {
    systemPrompts.push(buildCustomSceneSystemPrompt(scene));
  }

  return {
    action: "continue",
    route,
    scene,
    systemPrompts,
  };
}
