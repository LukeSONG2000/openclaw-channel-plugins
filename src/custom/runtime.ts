import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { evaluateCustomAuthorization } from "./auth.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import type { CustomAuthorizationDecision, CustomCapability, CustomInboundMessage, CustomSceneConfig } from "./types.js";

export interface CustomRuntimeDecision {
  enabled: boolean;
  scene: CustomSceneConfig;
  authorization?: CustomAuthorizationDecision;
}

export function inspectCustomRuntimeMessage(params: {
  cfg: OpenClawConfig;
  message: CustomInboundMessage;
  capability?: CustomCapability;
}): CustomRuntimeDecision {
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  const scene = resolveCustomSceneConfig(params.cfg, params.message.peer);
  if (!runtime.enabled) {
    return { enabled: false, scene };
  }

  const capability = params.capability ?? "chat.send";
  return {
    enabled: true,
    scene,
    authorization: evaluateCustomAuthorization({
      runtime,
      scene,
      peer: params.message.peer,
      actor: params.message.actor,
      capability,
    }),
  };
}
