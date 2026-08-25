import type {
  CustomActor,
  CustomDeployConfirmation,
  CustomDeployConfirmationRuntimeState,
  CustomPeer,
} from "./types.js";

const DEFAULT_DEPLOY_CONFIRMATION_TTL_MS = 10 * 60_000;

export interface CustomDeployConfirmationDecision {
  allowed: boolean;
  reason: "allowed" | "not_found" | "not_pending" | "expired" | "invalid_command";
  confirmation?: CustomDeployConfirmation;
}

export class CustomDeployConfirmationRuntime {
  private readonly confirmations = new Map<string, CustomDeployConfirmation>();
  private seq = 0;

  create(params: {
    accountId: string;
    peer: CustomPeer;
    creator: CustomActor;
    command: string;
    now?: number;
    ttlMs?: number;
  }): CustomDeployConfirmationDecision {
    const command = normalizeDeployCommand(params.command);
    if (!command) return { allowed: false, reason: "invalid_command" };
    const now = params.now ?? Date.now();
    const confirmation: CustomDeployConfirmation = {
      id: this.nextConfirmationId(params.accountId, params.peer, now),
      accountId: params.accountId,
      peer: { ...params.peer },
      creator: { ...params.creator },
      command,
      status: "pending",
      createdAt: now,
      expiresAt: now + Math.max(1, params.ttlMs ?? DEFAULT_DEPLOY_CONFIRMATION_TTL_MS),
    };
    this.confirmations.set(confirmation.id, confirmation);
    return { allowed: true, reason: "allowed", confirmation: cloneConfirmation(confirmation) };
  }

  resolve(params: {
    confirmationId: string;
    actor: CustomActor;
    approved: boolean;
    now?: number;
  }): CustomDeployConfirmationDecision {
    const confirmation = this.confirmations.get(params.confirmationId);
    if (!confirmation) return { allowed: false, reason: "not_found" };
    const now = params.now ?? Date.now();
    if (confirmation.status !== "pending") {
      return { allowed: false, reason: "not_pending", confirmation: cloneConfirmation(confirmation) };
    }
    if (confirmation.expiresAt <= now) {
      confirmation.status = "expired";
      confirmation.resolvedAt = now;
      return { allowed: false, reason: "expired", confirmation: cloneConfirmation(confirmation) };
    }
    confirmation.status = params.approved ? "confirmed" : "cancelled";
    confirmation.resolvedBy = { ...params.actor };
    confirmation.resolvedAt = now;
    return { allowed: true, reason: "allowed", confirmation: cloneConfirmation(confirmation) };
  }

  get(confirmationId: string): CustomDeployConfirmation | null {
    const confirmation = this.confirmations.get(confirmationId);
    return confirmation ? cloneConfirmation(confirmation) : null;
  }

  list(params: {
    accountId?: string;
    peer?: CustomPeer;
    status?: CustomDeployConfirmation["status"] | "active";
    limit?: number;
    now?: number;
  } = {}): CustomDeployConfirmation[] {
    const now = params.now ?? Date.now();
    let confirmations = Array.from(this.confirmations.values()).map((confirmation) => {
      if (confirmation.status === "pending" && confirmation.expiresAt <= now) {
        confirmation.status = "expired";
      }
      return confirmation;
    });
    if (params.accountId) confirmations = confirmations.filter((item) => item.accountId === params.accountId);
    if (params.peer) confirmations = confirmations.filter((item) => item.peer.kind === params.peer!.kind && item.peer.id === params.peer!.id);
    if (params.status) {
      confirmations = params.status === "active"
        ? confirmations.filter((item) => item.status === "pending")
        : confirmations.filter((item) => item.status === params.status);
    }
    confirmations.sort((a, b) => b.createdAt - a.createdAt);
    return confirmations.slice(0, Math.max(1, params.limit ?? 10)).map(cloneConfirmation);
  }

  getState(): CustomDeployConfirmationRuntimeState {
    const confirmations: CustomDeployConfirmationRuntimeState["confirmations"] = {};
    for (const [id, confirmation] of this.confirmations) {
      confirmations[id] = cloneConfirmation(confirmation);
    }
    return { confirmations };
  }

  loadState(state: CustomDeployConfirmationRuntimeState, options?: { now?: number }): void {
    this.confirmations.clear();
    this.seq = 0;
    const now = options?.now ?? Date.now();
    for (const [id, confirmation] of Object.entries(state.confirmations ?? {})) {
      const next = cloneConfirmation(confirmation);
      if (next.status === "pending" && next.expiresAt <= now) next.status = "expired";
      this.confirmations.set(id, next);
      this.bumpSeq(id);
    }
  }

  private nextConfirmationId(accountId: string, peer: CustomPeer, now: number): string {
    return `deploy-${accountPart(accountId)}-${peer.kind}-${peerPart(peer)}-${now}-${++this.seq}`;
  }

  private bumpSeq(id: string): void {
    const m = id.match(/-(\d+)$/);
    if (!m) return;
    const n = Number.parseInt(m[1]!, 10);
    if (Number.isFinite(n) && n > this.seq) this.seq = n;
  }
}

export function normalizeDeployCommand(command: string): string | null {
  const value = command.trim().replace(/\s+/g, " ");
  if (!/^\/bot-upgrade(?:\s|$)/.test(value)) return null;
  if (value === "/bot-upgrade") return null;
  return value;
}

function cloneConfirmation(confirmation: CustomDeployConfirmation): CustomDeployConfirmation {
  return {
    ...confirmation,
    peer: { ...confirmation.peer },
    creator: { ...confirmation.creator },
    resolvedBy: confirmation.resolvedBy ? { ...confirmation.resolvedBy } : undefined,
  };
}

function sanitizePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function accountPart(accountId: string): string {
  return sanitizePart(accountId) || "default";
}

function peerPart(peer: CustomPeer): string {
  return sanitizePart(peer.id).slice(0, 16) || "peer";
}
