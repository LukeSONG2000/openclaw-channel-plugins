import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  routeCustomInteractionButton,
  type CustomInteractionActor,
  type CustomInteractionGatewayPersist,
  type CustomInteractionGatewayLog,
  type CustomInteractionGatewayResult,
} from "./interaction-router.js";
import type { CustomMessageFlowRuntime } from "./runtime.js";
import type { CustomPeer } from "./types.js";

export type {
  CustomInteractionActor,
  CustomInteractionGatewayPersist,
  CustomInteractionGatewayLog,
  CustomInteractionGatewayResult,
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
  return routeCustomInteractionButton({
    cfg: params.cfg,
    buttonData: params.buttonData,
    accountId: params.accountId,
    runtime: params.runtime,
    actor: params.actor,
    sourcePeer: params.sourcePeer,
    now: params.now,
  });
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
