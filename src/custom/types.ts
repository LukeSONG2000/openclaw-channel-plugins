export type CustomPeerKind = "c2c" | "group" | "channel" | "dm";

export type CustomSceneKind =
  | "codex-only"
  | "chat"
  | "system-admin"
  | "dev-lab"
  | "default-dm";

export type CustomCapability =
  | "*"
  | "chat.send"
  | "codex.run"
  | "codex.longTask"
  | "system.status"
  | "system.restart"
  | "config.read"
  | "config.write"
  | "auth.grant"
  | "deploy.check"
  | "deploy.apply"
  | "proactive.send"
  | "game.interact";

export interface CustomPeer {
  kind: CustomPeerKind;
  id: string;
  label?: string;
}

export interface CustomActor {
  id: string;
  label?: string;
  isBot?: boolean;
}

export interface CustomAttachment {
  contentType: string;
  filename?: string;
  size?: number;
  url?: string;
  transcript?: string;
}

export interface CustomInboundMessage {
  accountId: string;
  peer: CustomPeer;
  actor: CustomActor;
  content: string;
  messageId: string;
  timestamp: number;
  mentionedBot: boolean;
  implicitMention?: boolean;
  attachments?: CustomAttachment[];
}

export interface CustomSceneConfig {
  scene: CustomSceneKind;
  label?: string;
  agentId?: string;
  allowAutonomousReply?: boolean;
  allowProactiveSend?: boolean;
  unread?: CustomUnreadConfig;
  capabilities?: CustomCapability[];
}

export interface CustomRuntimeConfig {
  enabled?: boolean;
  scenes?: Record<string, CustomSceneConfig>;
  admins?: string[];
  defaultScene?: CustomSceneKind;
  unread?: CustomUnreadConfig;
}

export interface CustomUnreadConfig {
  enabled?: boolean;
  historyLimit?: number;
  followupDelayMs?: number;
  sleepDelayMs?: number;
  allowAutonomousReply?: boolean;
  allowProactiveSend?: boolean;
}

export interface CustomAuthorizationDecision {
  allowed: boolean;
  reason: "allowed" | "missing_capability" | "unauthorized" | "scene_disabled";
  capability: Exclude<CustomCapability, "*">;
  actorId: string;
  peerId: string;
  source?: "admin" | "scene" | "temporary-grant";
  grantId?: string;
  requestId?: string;
}

export type CustomGrantUse = "once" | "count" | "timed" | "task";

export interface CustomAuthorizationGrant {
  id: string;
  peerId: string;
  actorId: string;
  capability: CustomCapability;
  grantedBy: string;
  createdAt: number;
  expiresAt?: number;
  remainingUses?: number;
  taskId?: string;
  note?: string;
}

export interface CustomAuthorizationApprovalRequest {
  id: string;
  peer: CustomPeer;
  actor: CustomActor;
  capability: Exclude<CustomCapability, "*">;
  scene: CustomSceneKind;
  sceneLabel?: string;
  reason: "missing_capability" | "unauthorized" | "scene_disabled";
  requestedAt: number;
  expiresAt: number;
  admins: string[];
  taskId?: string;
  status: "pending" | "approved" | "denied" | "expired";
  resolvedBy?: string;
  resolvedAt?: number;
}

export type CustomAuthorizationIntent =
  | { kind: "request-approval"; request: CustomAuthorizationApprovalRequest; deduped: boolean }
  | { kind: "approval-resolved"; request: CustomAuthorizationApprovalRequest; approved: boolean; grant?: CustomAuthorizationGrant }
  | { kind: "grant-consumed"; grantId: string; remainingUses?: number }
  | { kind: "grant-expired"; grantId: string };

export interface CustomAuthorizationRuntimeState {
  grants: Record<string, CustomAuthorizationGrant>;
  requests: Record<string, CustomAuthorizationApprovalRequest>;
}
