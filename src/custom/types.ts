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
  enabled?: boolean;
  label?: string;
  description?: string;
  systemPrompt?: string;
  agentId?: string;
  allowAutonomousReply?: boolean;
  allowProactiveSend?: boolean;
  unread?: CustomUnreadConfig;
  proactive?: CustomProactiveConfig;
  tasks?: CustomTaskRuntimeConfig;
  capabilities?: CustomCapability[];
}

export interface CustomRuntimeConfig {
  enabled?: boolean;
  scenes?: Record<string, CustomSceneConfig>;
  admins?: string[];
  auth?: CustomRuntimeAuthConfig;
  /**
   * Management group bound during custom runtime initialization.
   *
   * Accepts either a raw QQ group_openid or a full peer key such as
   * `qqbot:group:<group_openid>`.
   */
  adminGroup?: string;
  defaultScene?: CustomSceneKind;
  unread?: CustomUnreadConfig;
  proactive?: CustomProactiveConfig;
  tasks?: CustomTaskRuntimeConfig;
  fallbackAlerts?: CustomFallbackAlertConfig;
  initBind?: CustomRuntimeInitBindConfig;
}

export interface CustomRuntimeAuthConfig {
  /** Whether auth requests from non-admin-group peers are also copied to the admin group. Defaults to true. */
  copyRequestsToAdminGroup?: boolean;
}

export interface CustomRuntimeInitBindConfig {
  code?: string;
  createdAt?: number;
  expiresAt?: number;
  enableRuntimeOnComplete?: boolean;
}

export interface CustomUnreadConfig {
  enabled?: boolean;
  historyLimit?: number;
  followupDelayMs?: number;
  sleepDelayMs?: number;
  allowAutonomousReply?: boolean;
  allowProactiveSend?: boolean;
}

export interface CustomProactiveConfig {
  enabled?: boolean;
  monthlyLimit?: number;
  rateLimitWindowMs?: number;
  rateLimitMax?: number;
}

export interface CustomTaskRuntimeConfig {
  workspaceRoot?: string;
  maxActiveTasksPerPeer?: number;
  commandExecutor?: CustomTaskCommandExecutorConfig;
}

export interface CustomFallbackAlertConfig {
  enabled?: boolean;
  windowMs?: number;
  threshold?: number;
  cooldownMs?: number;
  kinds?: string[];
}

export interface CustomTaskCommandExecutorConfig {
  enabled?: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  forwardRequirementsToStdin?: boolean;
  timeoutMs?: number;
  maxOutputChars?: number;
  notifyAudiences?: Array<"peer" | "owner">;
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
  adminGroup?: string;
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

export interface CustomProactiveBudgetEntry {
  period: string;
  count: number;
  recent: number[];
  updatedAt: number;
}

export interface CustomProactiveAcceptanceEntry {
  accepted: boolean;
  updatedAt: number;
  updatedBy?: string;
}

export interface CustomProactiveBudgetRuntimeState {
  entries: Record<string, CustomProactiveBudgetEntry>;
  acceptance: Record<string, CustomProactiveAcceptanceEntry>;
}

export type CustomTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface CustomTaskRequirement {
  id: string;
  actor: CustomActor;
  content: string;
  createdAt: number;
}

export interface CustomSandboxTask {
  id: string;
  accountId: string;
  peer: CustomPeer;
  owner: CustomActor;
  title: string;
  prompt: string;
  status: CustomTaskStatus;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  requirements: CustomTaskRequirement[];
  execution?: {
    executorId?: string;
    runId?: string;
    agentId?: string;
    startedAt?: number;
    completedAt?: number;
    lastHeartbeatAt?: number;
  };
  progress?: {
    phase?: string;
    message?: string;
    percent?: number;
    updatedAt: number;
  };
  result?: string;
  error?: string;
}

export type CustomTaskIntent =
  | { kind: "start-requested"; task: CustomSandboxTask }
  | { kind: "requirement-added"; task: CustomSandboxTask; requirement: CustomTaskRequirement }
  | { kind: "cancel-requested"; task: CustomSandboxTask }
  | { kind: "status-updated"; task: CustomSandboxTask };

export interface CustomTaskSandboxRuntimeState {
  tasks: Record<string, CustomSandboxTask>;
}

export interface CustomPollOption {
  id: string;
  label: string;
}

export interface CustomPollVote {
  actor: CustomActor;
  /** Legacy single-choice field kept for old persisted state compatibility. */
  optionId: string;
  optionIds?: string[];
  votedAt: number;
}

export interface CustomPoll {
  id: string;
  accountId: string;
  peer: CustomPeer;
  creator: CustomActor;
  question: string;
  options: CustomPollOption[];
  votes: Record<string, CustomPollVote>;
  status: "open" | "closed";
  multiple?: boolean;
  anonymous?: boolean;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  closedAt?: number;
  closeReason?: "manual" | "expired";
  resultAnnouncedAt?: number;
}

export interface CustomPollRuntimeState {
  polls: Record<string, CustomPoll>;
}

export interface CustomGuessGameGuess {
  actor: CustomActor;
  value: number;
  correct: boolean;
  guessedAt: number;
}

export interface CustomGuessGame {
  id: string;
  accountId: string;
  peer: CustomPeer;
  creator: CustomActor;
  secret: number;
  guesses: Record<string, CustomGuessGameGuess>;
  status: "open" | "won" | "closed";
  createdAt: number;
  updatedAt: number;
  winner?: CustomActor;
  closedAt?: number;
}

export interface CustomGameRuntimeState {
  guessGames: Record<string, CustomGuessGame>;
}

export type CustomDeployConfirmationStatus = "pending" | "confirmed" | "cancelled" | "expired";

export interface CustomDeployConfirmation {
  id: string;
  accountId: string;
  peer: CustomPeer;
  creator: CustomActor;
  command: string;
  status: CustomDeployConfirmationStatus;
  createdAt: number;
  expiresAt: number;
  resolvedBy?: CustomActor;
  resolvedAt?: number;
}

export interface CustomDeployConfirmationRuntimeState {
  confirmations: Record<string, CustomDeployConfirmation>;
}
