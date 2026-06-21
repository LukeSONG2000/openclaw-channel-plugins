import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { CustomPeer, CustomRuntimeConfig, CustomSceneConfig } from "./types.js";
import {
  formatCustomPeerKey,
  resolveCustomScene,
  resolveCustomSceneConfigFromRuntime,
  type ResolvedCustomScene,
} from "./scenes.js";

const DEFAULT_RUNTIME_CONFIG: Required<Pick<CustomRuntimeConfig, "enabled" | "defaultScene">> = {
  enabled: false,
  defaultScene: "default-dm",
};

function qqbotChannelConfig(cfg: OpenClawConfig): Record<string, unknown> {
  return ((cfg.channels?.qqbot ?? {}) as Record<string, unknown>);
}

export function resolveCustomRuntimeConfig(cfg: OpenClawConfig): CustomRuntimeConfig {
  const raw = qqbotChannelConfig(cfg).customRuntime;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_RUNTIME_CONFIG };
  }
  const runtime = raw as CustomRuntimeConfig;
  return {
    enabled: runtime.enabled ?? DEFAULT_RUNTIME_CONFIG.enabled,
    defaultScene: runtime.defaultScene ?? DEFAULT_RUNTIME_CONFIG.defaultScene,
    scenes: runtime.scenes ?? {},
    admins: runtime.admins ?? [],
    adminGroup: runtime.adminGroup,
    unread: runtime.unread,
    proactive: runtime.proactive,
    tasks: runtime.tasks,
  };
}

export function resolveCustomSceneConfig(
  cfg: OpenClawConfig,
  peer: CustomPeer,
): CustomSceneConfig {
  const runtime = resolveCustomRuntimeConfig(cfg);
  return resolveCustomSceneConfigFromRuntime(runtime, peer);
}

export function resolveCustomSceneState(
  cfg: OpenClawConfig,
  peer: CustomPeer,
): ResolvedCustomScene {
  return resolveCustomScene(resolveCustomRuntimeConfig(cfg), peer);
}

export { formatCustomPeerKey };
