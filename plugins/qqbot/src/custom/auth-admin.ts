import type { CustomActor, CustomRuntimeConfig } from "./types.js";

export interface CustomAdminBindingStatus {
  enabled: boolean;
  admins: string[];
  adminGroup?: string;
  missing: Array<"admins" | "adminGroup">;
  ready: boolean;
}

export function isCustomRuntimeAdmin(runtime: CustomRuntimeConfig, actor: CustomActor): boolean {
  return normalizeCustomAdmins(runtime).some((admin) => admin === "*" || admin.toUpperCase() === actor.id.toUpperCase());
}

export function resolveCustomAdminGroupKey(raw?: string | null): string | undefined {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  if (value.startsWith("qqbot:group:")) return value;
  if (value.startsWith("qqbot:")) return undefined;
  if (value.startsWith("group:")) return `qqbot:${value}`;
  return `qqbot:group:${value}`;
}

export function inspectCustomAdminBindings(runtime: CustomRuntimeConfig): CustomAdminBindingStatus {
  const admins = normalizeCustomAdmins(runtime);
  const adminGroup = resolveCustomAdminGroupKey(runtime.adminGroup);
  const missing: CustomAdminBindingStatus["missing"] = [];
  if (runtime.enabled && admins.length === 0) missing.push("admins");
  if (runtime.enabled && !adminGroup) missing.push("adminGroup");
  return {
    enabled: runtime.enabled === true,
    admins,
    adminGroup,
    missing,
    ready: runtime.enabled !== true || missing.length === 0,
  };
}

export function boundCustomRuntimeAdmins(runtime: CustomRuntimeConfig): string[] {
  return normalizeCustomAdmins(runtime).filter((admin) => admin !== "*");
}

export function normalizeCustomAdmins(runtime: CustomRuntimeConfig): string[] {
  return (runtime.admins ?? [])
    .filter((admin): admin is string => typeof admin === "string")
    .map((admin) => admin.trim())
    .filter(Boolean);
}
