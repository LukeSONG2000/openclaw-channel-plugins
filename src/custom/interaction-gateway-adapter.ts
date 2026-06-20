import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  describeCustomAuthorizationIntents,
  handleCustomAuthInteraction,
} from "./auth-gateway-adapter.js";
import { handleCustomPollInteraction } from "./poll-gateway-adapter.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";

export interface CustomInteractionActor {
  id: string;
  label?: string;
}

export interface CustomInteractionGatewayPersist {
  auth?: boolean;
  polls?: boolean;
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
  runtime: Pick<CustomMessageFlowRuntime, "auth" | "polls">;
  buttonData: string;
  actor: CustomInteractionActor;
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
    polls: params.runtime.polls,
    buttonData: params.buttonData,
    actorId: params.actor.id,
    actorLabel: params.actor.label,
    now: params.now,
  });
  if (pollResult.handled) {
    return handled({
      reply: pollResult.reply,
      persist: pollResult.changed ? { polls: true } : undefined,
    });
  }

  return { handled: false };
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
  return Boolean(persist?.auth || persist?.polls);
}
