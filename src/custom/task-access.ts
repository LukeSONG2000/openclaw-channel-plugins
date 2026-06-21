import type { CustomActor, CustomPeer, CustomSandboxTask } from "./types.js";

export type CustomTaskAccessOperation = "read" | "mutate";

export type CustomTaskAccessReason =
  | "owner"
  | "same-peer"
  | "account-mismatch"
  | "cross-peer";

export interface CustomTaskAccessDecision {
  allowed: boolean;
  reason: CustomTaskAccessReason;
  operation: CustomTaskAccessOperation;
  isOwner: boolean;
  isSamePeer: boolean;
  isSameAccount: boolean;
}

export function evaluateCustomTaskPeerAccess(params: {
  task: CustomSandboxTask;
  accountId: string;
  peer: CustomPeer;
  actor: CustomActor;
  operation: CustomTaskAccessOperation;
}): CustomTaskAccessDecision {
  const isSameAccount = params.task.accountId === params.accountId;
  const isOwner = matchesActor(params.task.owner.id, params.actor.id);
  const isSamePeer = params.task.peer.kind === params.peer.kind && params.task.peer.id === params.peer.id;

  if (!isSameAccount) {
    return {
      allowed: false,
      reason: "account-mismatch",
      operation: params.operation,
      isOwner,
      isSamePeer,
      isSameAccount,
    };
  }
  if (isOwner) {
    return {
      allowed: true,
      reason: "owner",
      operation: params.operation,
      isOwner,
      isSamePeer,
      isSameAccount,
    };
  }
  if (isSamePeer) {
    return {
      allowed: true,
      reason: "same-peer",
      operation: params.operation,
      isOwner,
      isSamePeer,
      isSameAccount,
    };
  }
  return {
    allowed: false,
    reason: "cross-peer",
    operation: params.operation,
    isOwner,
    isSamePeer,
    isSameAccount,
  };
}

export function formatCustomTaskOutOfScope(taskId: string): string {
  return `⚠️ 未找到任务，或该任务不属于当前会话：${taskId}`;
}

function matchesActor(expected: string, actual: string): boolean {
  return expected.toUpperCase() === actual.toUpperCase();
}
