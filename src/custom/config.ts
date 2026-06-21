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
const LIKELY_RAW_QQ_NUMERIC_ID_PATTERN = /^[1-9]\d{4,12}$/;

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

export function isLikelyRawQQNumericId(raw: unknown): boolean {
  const value = stripCustomRuntimeBindingPrefix(String(raw ?? "").trim());
  return LIKELY_RAW_QQ_NUMERIC_ID_PATTERN.test(value);
}

export function findLikelyRawQQNumericAdminIds(raw: unknown): string[] {
  const values = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,;，；]+/g)
      : raw === null || raw === undefined
        ? []
        : [raw];

  const seen = new Set<string>();
  const matches: string[] = [];
  for (const value of values) {
    const candidate = String(value ?? "").trim();
    if (!candidate || !isLikelyRawQQNumericId(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    matches.push(candidate);
  }
  return matches;
}

export function validateCustomRuntimeAdminBindingIdentifiers(input: {
  admins?: unknown;
  adminGroup?: unknown;
}): string | null {
  const numericAdmins = findLikelyRawQQNumericAdminIds(input.admins);
  if (numericAdmins.length > 0) {
    return `customRuntime admins must use QQBot user_openid/member_openid, not raw QQ number: ${numericAdmins.join(", ")}`;
  }
  if (input.adminGroup !== undefined && input.adminGroup !== null && isLikelyRawQQNumericId(input.adminGroup)) {
    return "customRuntime adminGroup must use QQBot group_openid, not raw QQ group number";
  }
  return null;
}

export function normalizeCustomRuntimeAdminGroup(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  return resolveCustomAdminGroupKey(String(raw).trim());
}

function stripCustomRuntimeBindingPrefix(value: string): string {
  if (value.startsWith("qqbot:group:")) return value.slice("qqbot:group:".length).trim();
  if (value.startsWith("group:")) return value.slice("group:".length).trim();
  if (value.startsWith("qqbot:c2c:")) return value.slice("qqbot:c2c:".length).trim();
  if (value.startsWith("c2c:")) return value.slice("c2c:".length).trim();
  return value;
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
