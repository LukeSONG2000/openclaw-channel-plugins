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
  boundCustomRuntimeAdmins,
  isCustomRuntimeAdmin,
  resolveCustomAdminGroupKey,
} from "./auth-admin.js";
import {
  buildCustomAuthorizationApprovalRequest,
  findMatchingPendingCustomAuthorizationRequest,
} from "./auth-requests.js";
import {
  DEFAULT_CUSTOM_AUTH_APPROVAL_TTL_MS,
  cloneCustomAuthorizationGrant,
  cloneCustomAuthorizationRequest,
  expiresAtForCustomGrantUse,
  isCustomAuthorizationGrantExpired,
  matchesCustomAuthId,
  parseCustomAuthTrailingSeq,
  remainingUsesForCustomGrantUse,
} from "./auth-state.js";
import {
  applySceneDefaults,
  defaultSceneCapabilities,
} from "./scenes.js";

export {
  boundCustomRuntimeAdmins,
  inspectCustomAdminBindings,
  isCustomRuntimeAdmin,
  normalizeCustomAdmins,
  resolveCustomAdminGroupKey,
  type CustomAdminBindingStatus,
} from "./auth-admin.js";

export {
  buildCustomAuthorizationApprovalRequest,
  findMatchingPendingCustomAuthorizationRequest,
  normalizeCustomAuthorizationRequestReason,
  type CustomAuthorizationApprovalRequestBuildParams,
  type CustomAuthorizationPendingRequestLookup,
} from "./auth-requests.js";

export {
  DEFAULT_CUSTOM_AUTH_APPROVAL_TTL_MS,
  cloneCustomAuthorizationGrant,
  cloneCustomAuthorizationRequest,
  expiresAtForCustomGrantUse,
  isCustomAuthorizationGrantExpired,
  matchesCustomAuthId,
  parseCustomAuthTrailingSeq,
  remainingUsesForCustomGrantUse,
} from "./auth-state.js";

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
        admins: boundCustomRuntimeAdmins(params.runtime),
        adminGroup: resolveCustomAdminGroupKey(params.runtime.adminGroup),
        now,
        ttlMs: params.approvalTtlMs ?? DEFAULT_CUSTOM_AUTH_APPROVAL_TTL_MS,
        taskId: params.taskId,
      });
      if (request) {
        intents.push({ kind: "request-approval", request: cloneCustomAuthorizationRequest(request.request), deduped: request.deduped });
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
      expiresAt: params.expiresAt ?? expiresAtForCustomGrantUse(params.use, now, params.ttlMs),
      remainingUses: remainingUsesForCustomGrantUse(params.use, params.count),
      taskId: params.taskId,
      note: params.note,
    };
    this.grants.set(grant.id, grant);
    return cloneCustomAuthorizationGrant(grant);
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
      request: cloneCustomAuthorizationRequest(request),
      approved: params.approved,
      grant,
    };
  }

  getState(): CustomAuthorizationRuntimeState {
    const grants: CustomAuthorizationRuntimeState["grants"] = {};
    for (const [id, grant] of this.grants) grants[id] = cloneCustomAuthorizationGrant(grant);
    const requests: CustomAuthorizationRuntimeState["requests"] = {};
    for (const [id, request] of this.requests) requests[id] = cloneCustomAuthorizationRequest(request);
    return { grants, requests };
  }

  loadState(state: CustomAuthorizationRuntimeState, options?: { now?: number; pruneExpired?: boolean }): CustomAuthorizationIntent[] {
    this.clear();
    for (const [id, grant] of Object.entries(state.grants ?? {})) {
      this.grants.set(id, cloneCustomAuthorizationGrant(grant));
      this.bumpGrantSeq(id);
    }
    for (const [id, request] of Object.entries(state.requests ?? {})) {
      this.requests.set(id, cloneCustomAuthorizationRequest(request));
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
      if (isCustomAuthorizationGrantExpired(grant, params.now)) continue;
      if (!matchesCustomAuthId(grant.actorId, params.actorId)) continue;
      if (!matchesCustomAuthId(grant.peerId, params.peerId)) continue;
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
      if (isCustomAuthorizationGrantExpired(grant, now)) {
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
    const pending = findMatchingPendingCustomAuthorizationRequest({
      requests: this.requests.values(),
      peer: params.peer,
      actor: params.actor,
      capability: params.capability,
      now: params.now,
      taskId: params.taskId,
    });
    if (pending) {
      return { request: pending, deduped: true };
    }

    const request = buildCustomAuthorizationApprovalRequest({
      id: `authreq-${params.now}-${++this.requestSeq}`,
      peer: params.peer,
      actor: params.actor,
      capability: params.capability,
      scene: params.scene,
      reason: params.reason,
      admins: params.admins,
      adminGroup: params.adminGroup,
      now: params.now,
      ttlMs: params.ttlMs,
      taskId: params.taskId,
    });
    this.requests.set(request.id, request);
    return { request: cloneCustomAuthorizationRequest(request), deduped: false };
  }

  private bumpGrantSeq(id: string): void {
    const seq = parseCustomAuthTrailingSeq(id);
    if (seq > this.grantSeq) this.grantSeq = seq;
  }

  private bumpRequestSeq(id: string): void {
    const seq = parseCustomAuthTrailingSeq(id);
    if (seq > this.requestSeq) this.requestSeq = seq;
  }
}
