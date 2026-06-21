import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  describeCustomAuthorizationIntents,
  handleCustomAuthInteraction,
} from "./auth-gateway-adapter.js";
import { handleCustomGameInteraction } from "./game-gateway-adapter.js";
import { handleCustomPollInteraction } from "./poll-gateway-adapter.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import type { CustomPeer } from "./types.js";

export interface CustomInteractionActor {
  id: string;
  label?: string;
}

export interface CustomInteractionGatewayPersist {
  auth?: boolean;
  polls?: boolean;
  games?: boolean;
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

export function handleCustomInteractionGatewayButton(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  runtime: Pick<CustomMessageFlowRuntime, "auth" | "polls" | "games">;
  buttonData: string;
  actor: CustomInteractionActor;
  sourcePeer?: CustomPeer;
  now?: number;
}): CustomInteractionGatewayResult {
  const authResult = handleCustomAuthInteraction({
    cfg: params.cfg,
    auth: params.runtime.auth,
    buttonData: params.buttonData,
    actorId: params.actor.id,
    actorLabel: params.actor.label,
    now: params.now,
  });
  if (authResult.handled) {
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

  const pollResult = handleCustomPollInteraction({
    accountId: params.accountId,
    polls: params.runtime.polls,
    buttonData: params.buttonData,
    actorId: params.actor.id,
    actorLabel: params.actor.label,
    sourcePeer: params.sourcePeer,
    now: params.now,
  });
  if (pollResult.handled) {
    return handled({
      reply: pollResult.reply,
      persist: pollResult.changed ? { polls: true } : undefined,
    });
  }

  const gameResult = handleCustomGameInteraction({
    accountId: params.accountId,
    games: params.runtime.games,
    buttonData: params.buttonData,
    actorId: params.actor.id,
    actorLabel: params.actor.label,
    sourcePeer: params.sourcePeer,
    now: params.now,
  });
  if (gameResult.handled) {
    return handled({
      reply: gameResult.reply,
      persist: gameResult.changed ? { games: true } : undefined,
    });
  }

  return { handled: false };
}

export function resolveCustomInteractionSourcePeer(input: {
  groupOpenid?: string;
  userOpenid?: string;
  channelId?: string;
  guildId?: string;
}): CustomPeer | undefined {
  if (input.groupOpenid) return { kind: "group", id: input.groupOpenid };
  if (input.userOpenid) return { kind: "c2c", id: input.userOpenid };
  if (input.channelId) return { kind: "channel", id: input.channelId };
  if (input.guildId) return { kind: "dm", id: input.guildId };
  return undefined;
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
  return Boolean(persist?.auth || persist?.polls || persist?.games);
}
