import type {
  CustomActor,
  CustomAuthorizationApprovalRequest,
  CustomAuthorizationDecision,
  CustomCapability,
  CustomPeer,
  CustomSceneConfig,
} from "./types.js";
import { cloneCustomAuthorizationRequest } from "./auth-state.js";

export interface CustomAuthorizationPendingRequestLookup {
  requests: Iterable<CustomAuthorizationApprovalRequest>;
  peer: CustomPeer;
  actor: CustomActor;
  capability: Exclude<CustomCapability, "*">;
  now: number;
  taskId?: string;
  requiredCapabilities?: Exclude<CustomCapability, "*">[];
  actionSummary?: string;
}

export interface CustomAuthorizationApprovalRequestBuildParams {
  id: string;
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
  requiredCapabilities?: Exclude<CustomCapability, "*">[];
  actionSummary?: string;
}

export function findMatchingPendingCustomAuthorizationRequest(
  params: CustomAuthorizationPendingRequestLookup,
): CustomAuthorizationApprovalRequest | null {
  for (const request of params.requests) {
    if (
      request.status === "pending"
      && request.expiresAt > params.now
      && request.peer.id === params.peer.id
      && request.actor.id.toUpperCase() === params.actor.id.toUpperCase()
      && request.capability === params.capability
      && request.taskId === params.taskId
    ) {
      return cloneCustomAuthorizationRequest(request);
    }
  }
  return null;
}

export function buildCustomAuthorizationApprovalRequest(
  params: CustomAuthorizationApprovalRequestBuildParams,
): CustomAuthorizationApprovalRequest {
  return {
    id: params.id,
    peer: { ...params.peer },
    actor: { ...params.actor },
    capability: params.capability,
    scene: params.scene.scene,
    sceneLabel: params.scene.label,
    reason: normalizeCustomAuthorizationRequestReason(params.reason),
    requestedAt: params.now,
    expiresAt: params.now + params.ttlMs,
    admins: params.admins.slice(),
    adminGroup: params.adminGroup,
    taskId: params.taskId,
    requiredCapabilities: params.requiredCapabilities?.length ? Array.from(new Set(params.requiredCapabilities)) : undefined,
    actionSummary: params.actionSummary,
    status: "pending",
  };
}

export function normalizeCustomAuthorizationRequestReason(
  reason: CustomAuthorizationDecision["reason"],
): CustomAuthorizationApprovalRequest["reason"] {
  return reason === "allowed" ? "missing_capability" : reason;
}
