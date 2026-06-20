export type CustomPeerKind = "c2c" | "group" | "channel" | "dm";

export type CustomSceneKind =
  | "codex-only"
  | "chat"
  | "system-admin"
  | "dev-lab"
  | "default-dm";

export type CustomCapability =
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
  capability: CustomCapability;
  actorId: string;
  peerId: string;
}
