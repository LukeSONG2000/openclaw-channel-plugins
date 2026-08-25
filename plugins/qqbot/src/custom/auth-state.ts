import type {
  CustomAuthorizationApprovalRequest,
  CustomAuthorizationGrant,
  CustomGrantUse,
} from "./types.js";

export const DEFAULT_CUSTOM_AUTH_APPROVAL_TTL_MS = 10 * 60_000;

export function expiresAtForCustomGrantUse(use: CustomGrantUse, now: number, ttlMs?: number): number | undefined {
  if (ttlMs !== undefined) return now + Math.max(1, ttlMs);
  if (use === "timed" || use === "task") return now + DEFAULT_CUSTOM_AUTH_APPROVAL_TTL_MS;
  return undefined;
}

export function remainingUsesForCustomGrantUse(use: CustomGrantUse, count?: number): number | undefined {
  if (use === "once") return 1;
  if (use === "count") return Math.max(1, Math.floor(count ?? 1));
  return undefined;
}

export function matchesCustomAuthId(pattern: string, actual: string): boolean {
  return pattern === "*" || pattern.toUpperCase() === actual.toUpperCase();
}

export function isCustomAuthorizationGrantExpired(grant: CustomAuthorizationGrant, now: number): boolean {
  return (grant.expiresAt !== undefined && grant.expiresAt <= now)
    || (grant.remainingUses !== undefined && grant.remainingUses <= 0);
}

export function cloneCustomAuthorizationGrant(grant: CustomAuthorizationGrant): CustomAuthorizationGrant {
  return { ...grant };
}

export function cloneCustomAuthorizationRequest(request: CustomAuthorizationApprovalRequest): CustomAuthorizationApprovalRequest {
  return {
    ...request,
    peer: { ...request.peer },
    actor: { ...request.actor },
    admins: request.admins.slice(),
    requiredCapabilities: request.requiredCapabilities ? [...request.requiredCapabilities] : undefined,
  };
}

export function parseCustomAuthTrailingSeq(id: string): number {
  const m = id.match(/-(\d+)$/);
  if (!m) return 0;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : 0;
}
