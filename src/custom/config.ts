import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { CustomPeer, CustomRuntimeConfig, CustomSceneConfig } from "./types.js";
import { resolveCustomAdminGroupKey } from "./auth.js";
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
    fallbackAlerts: runtime.fallbackAlerts,
  };
}

export function normalizeCustomRuntimeAdminList(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,;，；]+/g)
      : raw === null || raw === undefined
        ? []
        : [raw];

  const seen = new Set<string>();
  const admins: string[] = [];
  for (const value of values) {
    const admin = String(value ?? "").trim();
    if (!admin) continue;
    const key = admin.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    admins.push(admin);
  }
  return admins;
}

export function normalizeCustomRuntimeAdminGroup(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  return resolveCustomAdminGroupKey(String(raw).trim());
}

export function applyCustomRuntimeAdminGroupSceneBinding(
  runtime: Record<string, unknown>,
  adminGroup: string | undefined,
): Record<string, unknown> {
  if (!adminGroup) return runtime;
  const scenes = runtime.scenes && typeof runtime.scenes === "object" && !Array.isArray(runtime.scenes)
    ? { ...(runtime.scenes as Record<string, unknown>) }
    : {};
  if (scenes[adminGroup]) {
    return {
      ...runtime,
      scenes,
    };
  }
  return {
    ...runtime,
    scenes: {
      ...scenes,
      [adminGroup]: { scene: "system-admin" },
    },
  };
}

export function applyCustomRuntimeAdminBindingsToConfig(
  cfg: OpenClawConfig,
  input: {
    admins?: unknown;
    adminGroup?: unknown;
    enabled?: boolean;
  },
): OpenClawConfig {
  const qqbot = qqbotChannelConfig(cfg);
  const currentRuntime = qqbot.customRuntime;
  const runtime = currentRuntime && typeof currentRuntime === "object" && !Array.isArray(currentRuntime)
    ? { ...(currentRuntime as Record<string, unknown>) }
    : {};

  const admins = normalizeCustomRuntimeAdminList(input.admins);
  const adminGroup = normalizeCustomRuntimeAdminGroup(input.adminGroup);

  if (admins.length > 0) runtime.admins = admins;
  if (adminGroup) runtime.adminGroup = adminGroup;
  if (typeof input.enabled === "boolean") runtime.enabled = input.enabled;
  const nextRuntime = applyCustomRuntimeAdminGroupSceneBinding(runtime, adminGroup);

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      qqbot: {
        ...qqbot,
        customRuntime: nextRuntime,
      },
    },
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
