import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  describeCustomAuthorizationIntents,
  handleCustomAuthInteraction,
} from "./auth-gateway-adapter.js";
import { handleCustomGameInteraction } from "./game-gateway-adapter.js";
import { handleCustomPollInteraction } from "./poll-gateway-adapter.js";
import { handleCustomDeployInteraction } from "./deploy-confirmation-gateway-adapter.js";
import { handleCustomSceneInteraction } from "./scene-gateway-adapter.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import type { CustomPeer, CustomSceneConfig } from "./types.js";

export interface CustomInteractionActor {
  id: string;
  label?: string;
}

export interface CustomInteractionGatewayPersist {
  auth?: boolean;
  polls?: boolean;
  games?: boolean;
  deployConfirmations?: boolean;
  config?: { sceneKey: string; sceneConfig: CustomSceneConfig };
}

export interface CustomInteractionGatewayLog {
  level: "info" | "error";
  message: string;
}

export type CustomInteractionGatewayResult =
  | { handled: false }
  | {
      handled: true;
      reply?: string;
      persist?: CustomInteractionGatewayPersist;
      logs?: CustomInteractionGatewayLog[];
    };

export interface CustomInteractionRouterContext {
  cfg: OpenClawConfig;
  accountId?: string;
  runtime: Pick<CustomMessageFlowRuntime, "auth" | "polls" | "games" | "deployConfirmations">;
  buttonData: string;
  actor: CustomInteractionActor;
  sourcePeer?: CustomPeer;
  now?: number;
}

export interface CustomInteractionRoute {
  name: string;
  handle: (ctx: CustomInteractionRouterContext) => CustomInteractionGatewayResult;
}

const DEFAULT_CUSTOM_INTERACTION_ROUTES: readonly CustomInteractionRoute[] = [
  { name: "auth", handle: routeCustomAuthInteraction },
  { name: "scene", handle: routeCustomSceneInteraction },
  { name: "poll", handle: routeCustomPollInteraction },
  { name: "game", handle: routeCustomGameInteraction },
  { name: "deploy", handle: routeCustomDeployInteraction },
];

export function getDefaultCustomInteractionRoutes(): readonly CustomInteractionRoute[] {
  return DEFAULT_CUSTOM_INTERACTION_ROUTES;
}

export function routeCustomInteractionButton(
  params: CustomInteractionRouterContext & { routes?: readonly CustomInteractionRoute[] },
): CustomInteractionGatewayResult {
  for (const route of params.routes ?? DEFAULT_CUSTOM_INTERACTION_ROUTES) {
    const result = route.handle(params);
    if (result.handled) return result;
  }
  return { handled: false };
}

function routeCustomAuthInteraction(ctx: CustomInteractionRouterContext): CustomInteractionGatewayResult {
  const authResult = handleCustomAuthInteraction({
    cfg: ctx.cfg,
    auth: ctx.runtime.auth,
    buttonData: ctx.buttonData,
    actorId: ctx.actor.id,
    actorLabel: ctx.actor.label,
    sourcePeer: ctx.sourcePeer,
    now: ctx.now,
  });
  if (!authResult.handled) return { handled: false };

  const logs: CustomInteractionGatewayLog[] = [];
  const persist: CustomInteractionGatewayPersist = {};
  if (authResult.intent) {
    persist.auth = true;
    logs.push(...describeCustomAuthorizationIntents([authResult.intent]).map((message) => ({
      level: "info" as const,
      message: `custom auth: ${message}`,
    })));
  }
  return handled({
    reply: authResult.reply,
    persist,
    logs,
  });
}


function routeCustomSceneInteraction(ctx: CustomInteractionRouterContext): CustomInteractionGatewayResult {
  const sceneResult = handleCustomSceneInteraction({
    cfg: ctx.cfg,
    buttonData: ctx.buttonData,
    actor: ctx.actor,
    sourcePeer: ctx.sourcePeer,
  });
  if (!sceneResult.handled) return { handled: false };
  return handled({
    reply: sceneResult.reply,
    persist: sceneResult.changed && sceneResult.sceneKey && sceneResult.sceneConfig
      ? { config: { sceneKey: sceneResult.sceneKey, sceneConfig: sceneResult.sceneConfig } }
      : undefined,
    logs: sceneResult.changed && sceneResult.sceneKey
      ? [{ level: "info", message: `custom scene interaction persisted: key=${sceneResult.sceneKey} scene=${sceneResult.sceneConfig?.scene}` }]
      : undefined,
  });
}

function routeCustomPollInteraction(ctx: CustomInteractionRouterContext): CustomInteractionGatewayResult {
  const pollResult = handleCustomPollInteraction({
    accountId: ctx.accountId,
    polls: ctx.runtime.polls,
    buttonData: ctx.buttonData,
    actorId: ctx.actor.id,
    actorLabel: ctx.actor.label,
    sourcePeer: ctx.sourcePeer,
    now: ctx.now,
  });
  if (!pollResult.handled) return { handled: false };
  return handled({
    reply: pollResult.reply,
    persist: pollResult.changed ? { polls: true } : undefined,
  });
}

function routeCustomGameInteraction(ctx: CustomInteractionRouterContext): CustomInteractionGatewayResult {
  const gameResult = handleCustomGameInteraction({
    accountId: ctx.accountId,
    games: ctx.runtime.games,
    buttonData: ctx.buttonData,
    actorId: ctx.actor.id,
    actorLabel: ctx.actor.label,
    sourcePeer: ctx.sourcePeer,
    now: ctx.now,
  });
  if (!gameResult.handled) return { handled: false };
  return handled({
    reply: gameResult.reply,
    persist: gameResult.changed ? { games: true } : undefined,
  });
}

function routeCustomDeployInteraction(ctx: CustomInteractionRouterContext): CustomInteractionGatewayResult {
  const deployResult = handleCustomDeployInteraction({
    accountId: ctx.accountId,
    confirmations: ctx.runtime.deployConfirmations,
    buttonData: ctx.buttonData,
    actorId: ctx.actor.id,
    actorLabel: ctx.actor.label,
    sourcePeer: ctx.sourcePeer,
    now: ctx.now,
  });
  if (!deployResult.handled) return { handled: false };
  return handled({
    reply: deployResult.reply,
    persist: deployResult.changed ? { deployConfirmations: true } : undefined,
  });
}

function handled(params: {
  reply?: string;
  persist?: CustomInteractionGatewayPersist;
  logs?: CustomInteractionGatewayLog[];
}): CustomInteractionGatewayResult {
  return {
    handled: true,
    ...(params.reply ? { reply: params.reply } : {}),
    ...(hasPersist(params.persist) ? { persist: params.persist } : {}),
    ...(params.logs?.length ? { logs: params.logs } : {}),
  };
}

function hasPersist(persist?: CustomInteractionGatewayPersist): boolean {
  return Boolean(persist?.auth || persist?.config || persist?.polls || persist?.games || persist?.deployConfirmations);
}
