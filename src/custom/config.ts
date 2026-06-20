import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { CustomPeer, CustomRuntimeConfig, CustomSceneConfig, CustomSceneKind } from "./types.js";

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
  };
}

export function formatCustomPeerKey(peer: CustomPeer): string {
  return `qqbot:${peer.kind}:${peer.id}`;
}

export function resolveCustomSceneConfig(
  cfg: OpenClawConfig,
  peer: CustomPeer,
): CustomSceneConfig {
  const runtime = resolveCustomRuntimeConfig(cfg);
  const key = formatCustomPeerKey(peer);
  const scene = runtime.scenes?.[key] ?? runtime.scenes?.["*"];
  if (scene) return scene;
  const defaultScene: CustomSceneKind = peer.kind === "group" ? "chat" : (runtime.defaultScene ?? "default-dm");
  return { scene: defaultScene };
}
