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
export { resolveCustomInteractionSourcePeer } from "./interaction-event-normalizer.js";

export type {
  CustomInteractionActor,
  CustomInteractionGatewayPersist,
  CustomInteractionGatewayLog,
  CustomInteractionGatewayResult,
};

export function handleCustomInteractionGatewayButton(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  runtime: Pick<CustomMessageFlowRuntime, "auth" | "polls" | "games" | "deployConfirmations">;
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
