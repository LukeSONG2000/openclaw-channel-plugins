import type {
  CustomActor,
  CustomAuthorizationApprovalRequest,
  CustomAuthorizationDecision,
  CustomAuthorizationGrant,
  CustomAuthorizationIntent,
  CustomAuthorizationRuntimeState,
  CustomCapability,
  CustomGrantUse,
  CustomPeer,
  CustomRuntimeConfig,
  CustomSceneConfig,
} from "./types.js";
import {
  applySceneDefaults,
  defaultSceneCapabilities,
} from "./scenes.js";

const DEFAULT_APPROVAL_TTL_MS = 10 * 60_000;

const ADMIN_CAPABILITIES: Exclude<CustomCapability, "*">[] = [
  "chat.send",
  "codex.run",
  "codex.longTask",
  "system.status",
  "system.restart",
  "config.read",
  "config.write",
  "auth.grant",
  "deploy.check",
  "deploy.apply",
  "proactive.send",
  "game.interact",
];

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

export { defaultSceneCapabilities };

export function evaluateCustomAuthorization(params: {
  runtime: CustomRuntimeConfig;
  scene: CustomSceneConfig;
  peer: CustomPeer;
  actor: CustomActor;
  capability: Exclude<CustomCapability, "*">;
}): CustomAuthorizationDecision {
  const { runtime, scene, peer, actor, capability } = params;

  if (runtime.enabled === false) {
    return { allowed: false, reason: "scene_disabled", capability, actorId: actor.id, peerId: peer.id };
  }

  const resolvedScene = applySceneDefaults(scene);
  if (!resolvedScene.enabled) {
    return { allowed: false, reason: "scene_disabled", capability, actorId: actor.id, peerId: peer.id };
  }

  if (isCustomRuntimeAdmin(runtime, actor)) {
    return {
      allowed: true,
      reason: "allowed",
      capability,
      actorId: actor.id,
      peerId: peer.id,
      source: "admin",
    };
  }

  const capabilities = resolvedScene.capabilities;
  const allowed = capabilities.includes("*") || capabilities.includes(capability);

  return {
    allowed,
    reason: allowed ? "allowed" : "missing_capability",
    capability,
    actorId: actor.id,
    peerId: peer.id,
    source: allowed ? "scene" : undefined,
  };
}

export interface CustomAuthorizationCheckResult {
  decision: CustomAuthorizationDecision;
  intents: CustomAuthorizationIntent[];
}

export class CustomAuthorizationRuntime {
  private readonly grants = new Map<string, CustomAuthorizationGrant>();
  private readonly requests = new Map<string, CustomAuthorizationApprovalRequest>();
  private grantSeq = 0;
  private requestSeq = 0;

  check(params: {
    runtime: CustomRuntimeConfig;
    scene: CustomSceneConfig;
    peer: CustomPeer;
    actor: CustomActor;
    capability: Exclude<CustomCapability, "*">;
    now?: number;
    taskId?: string;
    consumeGrant?: boolean;
    requestApproval?: boolean;
    approvalTtlMs?: number;
  }): CustomAuthorizationCheckResult {
    const now = params.now ?? Date.now();
    const intents = this.pruneExpired(now);
    const base = evaluateCustomAuthorization(params);
    if (base.allowed) return { decision: base, intents };

    const grant = this.findMatchingGrant({
      actorId: params.actor.id,
      peerId: params.peer.id,
      capability: params.capability,
      taskId: params.taskId,
      now,
    });
    if (grant) {
      if (params.consumeGrant !== false) {
        this.consumeGrant(grant, intents);
      }
      return {
        decision: {
          ...base,
          allowed: true,
          reason: "allowed",
          source: "temporary-grant",
          grantId: grant.id,
        },
        intents,
      };
    }

    if (params.requestApproval !== false) {
      const request = this.getOrCreatePendingRequest({
        peer: params.peer,
        actor: params.actor,
        capability: params.capability,
        scene: params.scene,
        reason: base.reason,
        admins: boundAdmins(params.runtime),
        adminGroup: resolveCustomAdminGroupKey(params.runtime.adminGroup),
        now,
        ttlMs: params.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
        taskId: params.taskId,
      });
      if (request) {
        intents.push({ kind: "request-approval", request: cloneRequest(request.request), deduped: request.deduped });
        return { decision: { ...base, requestId: request.request.id }, intents };
      }
    }

    return { decision: base, intents };
  }

  grant(params: {
    peerId: string;
    actorId: string;
    capability: CustomCapability;
    grantedBy: string;
    use: CustomGrantUse;
    now?: number;
    id?: string;
    count?: number;
    ttlMs?: number;
    expiresAt?: number;
    taskId?: string;
    note?: string;
  }): CustomAuthorizationGrant {
    const now = params.now ?? Date.now();
    if (params.use === "task" && !params.taskId) {
      throw new Error("task grant requires taskId");
    }
    const grant: CustomAuthorizationGrant = {
      id: params.id ?? `grant-${now}-${++this.grantSeq}`,
      peerId: params.peerId,
      actorId: params.actorId,
      capability: params.capability,
      grantedBy: params.grantedBy,
      createdAt: now,
      expiresAt: params.expiresAt ?? expiresAtForUse(params.use, now, params.ttlMs),
      remainingUses: remainingUsesForUse(params.use, params.count),
      taskId: params.taskId,
      note: params.note,
    };
    this.grants.set(grant.id, grant);
    return cloneGrant(grant);
  }

  resolveApproval(params: {
    requestId: string;
    approved: boolean;
    resolvedBy: string;
    now?: number;
    grantUse?: CustomGrantUse;
    grantCount?: number;
    grantTtlMs?: number;
    note?: string;
  }): CustomAuthorizationIntent | null {
    const now = params.now ?? Date.now();
    const request = this.requests.get(params.requestId);
    if (!request || request.status !== "pending") return null;

    request.status = params.approved ? "approved" : "denied";
    request.resolvedBy = params.resolvedBy;
    request.resolvedAt = now;

    let grant: CustomAuthorizationGrant | undefined;
    if (params.approved) {
      grant = this.grant({
        peerId: request.peer.id,
        actorId: request.actor.id,
        capability: request.capability,
        grantedBy: params.resolvedBy,
        use: params.grantUse ?? "once",
        count: params.grantCount,
        ttlMs: params.grantTtlMs,
        taskId: request.taskId,
        now,
        note: params.note,
      });
    }

    return {
      kind: "approval-resolved",
      request: cloneRequest(request),
      approved: params.approved,
      grant,
    };
  }

  getState(): CustomAuthorizationRuntimeState {
    const grants: CustomAuthorizationRuntimeState["grants"] = {};
    for (const [id, grant] of this.grants) grants[id] = cloneGrant(grant);
    const requests: CustomAuthorizationRuntimeState["requests"] = {};
    for (const [id, request] of this.requests) requests[id] = cloneRequest(request);
    return { grants, requests };
  }

  loadState(state: CustomAuthorizationRuntimeState, options?: { now?: number; pruneExpired?: boolean }): CustomAuthorizationIntent[] {
    this.clear();
    for (const [id, grant] of Object.entries(state.grants ?? {})) {
      this.grants.set(id, cloneGrant(grant));
      this.bumpGrantSeq(id);
    }
    for (const [id, request] of Object.entries(state.requests ?? {})) {
      this.requests.set(id, cloneRequest(request));
      this.bumpRequestSeq(id);
    }
    if (options?.pruneExpired === false) return [];
    return this.pruneExpired(options?.now ?? Date.now());
  }

  clear(): void {
    this.grants.clear();
    this.requests.clear();
  }

  private findMatchingGrant(params: {
    actorId: string;
    peerId: string;
    capability: Exclude<CustomCapability, "*">;
    taskId?: string;
    now: number;
  }): CustomAuthorizationGrant | null {
    for (const grant of this.grants.values()) {
      if (isGrantExpired(grant, params.now)) continue;
      if (!matchesId(grant.actorId, params.actorId)) continue;
      if (!matchesId(grant.peerId, params.peerId)) continue;
      if (grant.capability !== "*" && grant.capability !== params.capability) continue;
      if (grant.taskId && grant.taskId !== params.taskId) continue;
      return grant;
    }
    return null;
  }

  private consumeGrant(grant: CustomAuthorizationGrant, intents: CustomAuthorizationIntent[]): void {
    if (grant.remainingUses === undefined) return;
    grant.remainingUses = Math.max(0, grant.remainingUses - 1);
    intents.push({ kind: "grant-consumed", grantId: grant.id, remainingUses: grant.remainingUses });
    if (grant.remainingUses <= 0) {
      this.grants.delete(grant.id);
    }
  }

  private pruneExpired(now: number): CustomAuthorizationIntent[] {
    const intents: CustomAuthorizationIntent[] = [];
    for (const [id, grant] of this.grants) {
      if (isGrantExpired(grant, now)) {
        this.grants.delete(id);
        intents.push({ kind: "grant-expired", grantId: id });
      }
    }
    for (const request of this.requests.values()) {
      if (request.status === "pending" && request.expiresAt <= now) {
        request.status = "expired";
      }
    }
    return intents;
  }

  private getOrCreatePendingRequest(params: {
    peer: CustomPeer;
    actor: CustomActor;
    capability: Exclude<CustomCapability, "*">;
    scene: CustomSceneConfig;
    reason: CustomAuthorizationDecision["reason"];
    admins: string[];
    adminGroup?: string;
    now: number;
    ttlMs: number;
    taskId?: string;
  }): { request: CustomAuthorizationApprovalRequest; deduped: boolean } | null {
    if (params.admins.length === 0) return null;
    const reason = params.reason === "allowed" ? "missing_capability" : params.reason;
    for (const request of this.requests.values()) {
      if (
        request.status === "pending"
        && request.expiresAt > params.now
        && request.peer.id === params.peer.id
        && request.actor.id.toUpperCase() === params.actor.id.toUpperCase()
        && request.capability === params.capability
        && request.taskId === params.taskId
      ) {
        return { request, deduped: true };
      }
    }

    const request: CustomAuthorizationApprovalRequest = {
      id: `authreq-${params.now}-${++this.requestSeq}`,
      peer: { ...params.peer },
      actor: { ...params.actor },
      capability: params.capability,
      scene: params.scene.scene,
      sceneLabel: params.scene.label,
      reason,
      requestedAt: params.now,
      expiresAt: params.now + params.ttlMs,
      admins: params.admins.slice(),
      adminGroup: params.adminGroup,
      taskId: params.taskId,
      status: "pending",
    };
    this.requests.set(request.id, request);
    return { request, deduped: false };
  }

  private bumpGrantSeq(id: string): void {
    const seq = parseTrailingSeq(id);
    if (seq > this.grantSeq) this.grantSeq = seq;
  }

  private bumpRequestSeq(id: string): void {
    const seq = parseTrailingSeq(id);
    if (seq > this.requestSeq) this.requestSeq = seq;
  }
}

function boundAdmins(runtime: CustomRuntimeConfig): string[] {
  return normalizeCustomAdmins(runtime).filter((admin) => admin !== "*");
}

function normalizeCustomAdmins(runtime: CustomRuntimeConfig): string[] {
  return (runtime.admins ?? [])
    .filter((admin): admin is string => typeof admin === "string")
    .map((admin) => admin.trim())
    .filter(Boolean);
}

function expiresAtForUse(use: CustomGrantUse, now: number, ttlMs?: number): number | undefined {
  if (ttlMs !== undefined) return now + Math.max(1, ttlMs);
  if (use === "timed" || use === "task") return now + DEFAULT_APPROVAL_TTL_MS;
  return undefined;
}

function remainingUsesForUse(use: CustomGrantUse, count?: number): number | undefined {
  if (use === "once") return 1;
  if (use === "count") return Math.max(1, Math.floor(count ?? 1));
  return undefined;
}

function matchesId(pattern: string, actual: string): boolean {
  return pattern === "*" || pattern.toUpperCase() === actual.toUpperCase();
}

function isGrantExpired(grant: CustomAuthorizationGrant, now: number): boolean {
  return (grant.expiresAt !== undefined && grant.expiresAt <= now)
    || (grant.remainingUses !== undefined && grant.remainingUses <= 0);
}

function cloneGrant(grant: CustomAuthorizationGrant): CustomAuthorizationGrant {
  return { ...grant };
}

function cloneRequest(request: CustomAuthorizationApprovalRequest): CustomAuthorizationApprovalRequest {
  return {
    ...request,
    peer: { ...request.peer },
    actor: { ...request.actor },
    admins: request.admins.slice(),
  };
}

function parseTrailingSeq(id: string): number {
  const m = id.match(/-(\d+)$/);
  if (!m) return 0;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : 0;
}
