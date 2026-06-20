import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { evaluateCustomAuthorization } from "./auth.js";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig } from "./config.js";
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

export interface CustomMessageFlowRuntime {
  unread: CustomUnreadRuntime;
}

export function createCustomMessageFlowRuntime(): CustomMessageFlowRuntime {
  return {
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

export { CustomUnreadRuntime, resolveCustomUnreadConfig } from "./unread-runtime.js";
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
