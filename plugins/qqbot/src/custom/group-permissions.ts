import type {
  CustomGroupPermission,
  CustomPeer,
  CustomRuntimeConfig,
} from "./types.js";

export const DEFAULT_CUSTOM_GROUP_PERMISSION: CustomGroupPermission = "default";

export function resolveCustomGroupPermission(
  runtime: CustomRuntimeConfig,
  peer: CustomPeer,
): CustomGroupPermission | null {
  if (peer.kind !== "group" || !runtime.groupPermissions) return null;

  const peerKey = normalizeGroupBindingKey(peer.id);
  const adminGroupKey = normalizeGroupBindingKey(runtime.adminGroup);
  if (adminGroupKey && adminGroupKey === peerKey) return "admin";

  for (const [rawKey, rawPermission] of Object.entries(runtime.groupPermissions.bindings ?? {})) {
    if (normalizeGroupBindingKey(rawKey) !== peerKey) continue;
    return normalizeCustomGroupPermission(rawPermission) ?? DEFAULT_CUSTOM_GROUP_PERMISSION;
  }

  return normalizeCustomGroupPermission(runtime.groupPermissions.default)
    ?? DEFAULT_CUSTOM_GROUP_PERMISSION;
}

export function normalizeCustomGroupPermission(raw: unknown): CustomGroupPermission | null {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "free" || value === "admin" || value === "default") return value;
  return null;
}

export function formatCustomGroupPermission(permission: CustomGroupPermission): string {
  if (permission === "free") return "free（全量消息与轮询）";
  if (permission === "admin") return "admin（管理群）";
  return "default（仅 @）";
}

function normalizeGroupBindingKey(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  if (value.toLowerCase().startsWith("qqbot:group:")) {
    return value.slice("qqbot:group:".length).trim().toUpperCase();
  }
  if (value.toLowerCase().startsWith("group:")) {
    return value.slice("group:".length).trim().toUpperCase();
  }
  return value.toUpperCase();
}
