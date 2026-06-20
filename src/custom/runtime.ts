import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
import { CustomAuthorizationRuntime, evaluateCustomAuthorization } from "./auth.js";
import { CustomUnreadRuntime, resolveCustomUnreadConfig, type ResolvedCustomUnreadConfig } from "./unread-runtime.js";
import type { CustomAuthorizationDecision, CustomCapability, CustomInboundMessage, CustomSceneConfig } from "./types.js";

export interface CustomRuntimeDecision {
  enabled: boolean;
  scene: CustomSceneConfig;
  authorization?: CustomAuthorizationDecision;
}

export function inspectCustomRuntimeMessage(params: {
  cfg: OpenClawConfig;
  message: CustomInboundMessage;
  capability?: Exclude<CustomCapability, "*">;
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

export interface CustomMessageFlowRuntime {
  auth: CustomAuthorizationRuntime;
  unread: CustomUnreadRuntime;
}

export function createCustomMessageFlowRuntime(): CustomMessageFlowRuntime {
  return {
    auth: new CustomAuthorizationRuntime(),
    unread: new CustomUnreadRuntime(),
  };
}

export function inspectCustomUnreadConfig(params: {
  cfg: OpenClawConfig;
  message: CustomInboundMessage;
}): ResolvedCustomUnreadConfig {
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  const scene = resolveCustomSceneConfig(params.cfg, params.message.peer);
  return resolveCustomUnreadConfig({ runtime, scene });
}

export {
  CustomAuthorizationRuntime,
  defaultSceneCapabilities,
  evaluateCustomAuthorization,
  isCustomRuntimeAdmin,
} from "./auth.js";
export { CustomUnreadRuntime, resolveCustomUnreadConfig } from "./unread-runtime.js";
export type { CustomAuthorizationCheckResult } from "./auth.js";
export type {
  CustomUnreadCatchupSnapshot,
  CustomUnreadCatchupSource,
  CustomUnreadHistoryEntry,
  CustomUnreadIntent,
  CustomUnreadIntentKind,
  CustomUnreadRecordResult,
  CustomUnreadMentionResult,
  CustomUnreadRuntimeState,
  ResolvedCustomUnreadConfig,
} from "./unread-runtime.js";
