import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveCustomRuntimeConfig, resolveCustomSceneConfig, resolveCustomSceneState } from "./config.js";
import { CustomAuthorizationRuntime, evaluateCustomAuthorization } from "./auth.js";
import { CustomUnreadRuntime, resolveCustomUnreadConfig, type ResolvedCustomUnreadConfig } from "./unread-runtime.js";
import { CustomProactiveBudgetRuntime, resolveCustomProactiveConfig, type ResolvedCustomProactiveConfig } from "./proactive-budget.js";
import type { CustomAuthorizationDecision, CustomCapability, CustomInboundMessage, CustomSceneConfig } from "./types.js";
import { buildCustomSceneSystemPrompt, type ResolvedCustomScene } from "./scenes.js";

export interface CustomRuntimeDecision {
  enabled: boolean;
  scene: CustomSceneConfig;
  sceneState: ResolvedCustomScene;
  sceneSystemPrompt?: string;
  authorization?: CustomAuthorizationDecision;
}

export function inspectCustomRuntimeMessage(params: {
  cfg: OpenClawConfig;
  message: CustomInboundMessage;
  capability?: Exclude<CustomCapability, "*">;
}): CustomRuntimeDecision {
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  const sceneState = resolveCustomSceneState(params.cfg, params.message.peer);
  const scene = sceneState.config;
  const sceneSystemPrompt = buildCustomSceneSystemPrompt(sceneState);
  if (!runtime.enabled || !sceneState.enabled) {
    return { enabled: false, scene, sceneState, sceneSystemPrompt };
  }

  const capability = params.capability ?? "chat.send";
  return {
    enabled: true,
    scene,
    sceneState,
    sceneSystemPrompt,
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
  proactiveBudget: CustomProactiveBudgetRuntime;
}

export function createCustomMessageFlowRuntime(): CustomMessageFlowRuntime {
  return {
    auth: new CustomAuthorizationRuntime(),
    unread: new CustomUnreadRuntime(),
    proactiveBudget: new CustomProactiveBudgetRuntime(),
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

export function inspectCustomProactiveConfig(params: {
  cfg: OpenClawConfig;
  message: CustomInboundMessage;
}): ResolvedCustomProactiveConfig {
  const runtime = resolveCustomRuntimeConfig(params.cfg);
  const scene = resolveCustomSceneConfig(params.cfg, params.message.peer);
  return resolveCustomProactiveConfig({ runtime, scene });
}

export {
  CustomAuthorizationRuntime,
  defaultSceneCapabilities,
  evaluateCustomAuthorization,
  isCustomRuntimeAdmin,
} from "./auth.js";
export {
  applySceneDefaults,
  buildCustomSceneSystemPrompt,
  formatCustomPeerKey,
  formatCustomPeerKindWildcard,
  getCustomSceneProfile,
  resolveCustomScene,
} from "./scenes.js";
export { CustomUnreadRuntime, resolveCustomUnreadConfig } from "./unread-runtime.js";
export {
  CustomProactiveBudgetRuntime,
  resolveCustomProactiveConfig,
} from "./proactive-budget.js";
export type { CustomAuthorizationCheckResult } from "./auth.js";
export type { CustomSceneProfile, ResolvedCustomScene } from "./scenes.js";
export type {
  CustomProactiveBudgetDecision,
  ResolvedCustomProactiveConfig,
} from "./proactive-budget.js";
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
