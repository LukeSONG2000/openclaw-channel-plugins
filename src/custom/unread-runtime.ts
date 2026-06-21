import type {
  CustomAttachment,
  CustomInboundMessage,
  CustomRuntimeConfig,
  CustomSceneConfig,
  CustomUnreadConfig,
} from "./types.js";

export const DEFAULT_UNREAD_FOLLOWUP_DELAY_MS = 60_000;
export const DEFAULT_UNREAD_SLEEP_DELAY_MS = 10 * 60_000;
export const DEFAULT_UNREAD_HISTORY_LIMIT = 50;
export const CUSTOM_UNREAD_ACTOR_ID = "__qqbot_digest__";

export type CustomUnreadIntentKind =
  | "schedule-followup"
  | "schedule-sleep-digest"
  | "clear-followup"
  | "clear-sleep-digest"
  | "enqueue-catchup"
  | "policy-gated";

export type CustomUnreadCatchupSource =
  | "mention-followup"
  | "followup"
  | "sleep-timer"
  | "manual";

export interface CustomUnreadHistoryEntry {
  actorId: string;
  actorLabel?: string;
  body: string;
  timestamp: number;
  messageId: string;
  attachments?: CustomAttachment[];
}

export interface CustomUnreadCatchupSnapshot {
  id: string;
  peerId: string;
  source: CustomUnreadCatchupSource;
  entries: CustomUnreadHistoryEntry[];
  createdAt: number;
  policyGated: boolean;
  prompt: string;
}

export interface CustomUnreadIntent {
  kind: CustomUnreadIntentKind;
  peerId: string;
  dueAt?: number;
  source?: CustomUnreadCatchupSource;
  reason?: string;
  snapshot?: CustomUnreadCatchupSnapshot;
}

export interface CustomUnreadRecordResult {
  recorded: boolean;
  pendingCount: number;
  intents: CustomUnreadIntent[];
}

export interface CustomUnreadMentionResult {
  pendingCount: number;
  shouldCatchUpAfterReply: boolean;
  history: CustomUnreadHistoryEntry[];
  intents: CustomUnreadIntent[];
}

export interface CustomUnreadRuntimeState {
  peers: Record<string, {
    history: CustomUnreadHistoryEntry[];
    followupActive: boolean;
    catchupAnchor?: number;
    scheduledFollowupDueAt?: number;
    scheduledSleepDigestDueAt?: number;
  }>;
  snapshots: Record<string, CustomUnreadCatchupSnapshot>;
}

export interface CustomUnreadPeerInspection {
  peerId: string;
  pendingCount: number;
  oldestPendingAt?: number;
  newestPendingAt?: number;
  followupActive: boolean;
  scheduledFollowupDueAt?: number;
  scheduledSleepDigestDueAt?: number;
  snapshotCount: number;
  policyGatedSnapshotCount: number;
}

export interface CustomUnreadRuntimeInspection {
  peerCount: number;
  totalPendingCount: number;
  snapshotCount: number;
  policyGatedSnapshotCount: number;
  scheduledFollowupCount: number;
  scheduledSleepDigestCount: number;
  peers: CustomUnreadPeerInspection[];
}

export interface ResolvedCustomUnreadConfig {
  enabled: boolean;
  historyLimit: number;
  followupDelayMs: number;
  sleepDelayMs: number;
  allowAutonomousReply: boolean;
  allowProactiveSend: boolean;
}

interface PeerState {
  history: CustomUnreadHistoryEntry[];
  followupActive: boolean;
  catchupAnchor?: number;
  scheduledFollowupDueAt?: number;
  scheduledSleepDigestDueAt?: number;
}

export function resolveCustomUnreadConfig(params: {
  runtime?: CustomRuntimeConfig | null;
  scene?: CustomSceneConfig | null;
}): ResolvedCustomUnreadConfig {
  const runtimeUnread = params.runtime?.unread ?? {};
  const sceneUnread = params.scene?.unread ?? {};
  const enabled = sceneUnread.enabled ?? runtimeUnread.enabled ?? true;
  const historyLimit = normalizePositiveInt(
    sceneUnread.historyLimit ?? runtimeUnread.historyLimit,
    DEFAULT_UNREAD_HISTORY_LIMIT,
  );
  return {
    enabled,
    historyLimit,
    followupDelayMs: normalizePositiveInt(
      sceneUnread.followupDelayMs ?? runtimeUnread.followupDelayMs,
      DEFAULT_UNREAD_FOLLOWUP_DELAY_MS,
    ),
    sleepDelayMs: normalizePositiveInt(
      sceneUnread.sleepDelayMs ?? runtimeUnread.sleepDelayMs,
      DEFAULT_UNREAD_SLEEP_DELAY_MS,
    ),
    allowAutonomousReply:
      sceneUnread.allowAutonomousReply
      ?? params.scene?.allowAutonomousReply
      ?? runtimeUnread.allowAutonomousReply
      ?? false,
    allowProactiveSend:
      sceneUnread.allowProactiveSend
      ?? params.scene?.allowProactiveSend
      ?? runtimeUnread.allowProactiveSend
      ?? false,
  };
}

export function inspectCustomUnreadRuntimeState(
  state: CustomUnreadRuntimeState,
  options: { limit?: number } = {},
): CustomUnreadRuntimeInspection {
  const snapshotCounts = new Map<string, { total: number; gated: number }>();
  let snapshotCount = 0;
  let policyGatedSnapshotCount = 0;
  for (const snapshot of Object.values(state.snapshots ?? {})) {
    snapshotCount++;
    if (snapshot.policyGated) policyGatedSnapshotCount++;
    const counts = snapshotCounts.get(snapshot.peerId) ?? { total: 0, gated: 0 };
    counts.total++;
    if (snapshot.policyGated) counts.gated++;
    snapshotCounts.set(snapshot.peerId, counts);
  }

  const peers = Object.entries(state.peers ?? {}).map(([peerId, peer]) => {
    const timestamps = (peer.history ?? [])
      .map((entry) => entry.timestamp)
      .filter((timestamp) => Number.isFinite(timestamp));
    const snapshotSummary = snapshotCounts.get(peerId);
    return {
      peerId,
      pendingCount: peer.history?.length ?? 0,
      oldestPendingAt: timestamps.length ? Math.min(...timestamps) : undefined,
      newestPendingAt: timestamps.length ? Math.max(...timestamps) : undefined,
      followupActive: peer.followupActive === true,
      scheduledFollowupDueAt: peer.scheduledFollowupDueAt,
      scheduledSleepDigestDueAt: peer.scheduledSleepDigestDueAt,
      snapshotCount: snapshotSummary?.total ?? 0,
      policyGatedSnapshotCount: snapshotSummary?.gated ?? 0,
    };
  });

  peers.sort((a, b) => {
    const nextA = Math.min(a.scheduledFollowupDueAt ?? Number.POSITIVE_INFINITY, a.scheduledSleepDigestDueAt ?? Number.POSITIVE_INFINITY);
    const nextB = Math.min(b.scheduledFollowupDueAt ?? Number.POSITIVE_INFINITY, b.scheduledSleepDigestDueAt ?? Number.POSITIVE_INFINITY);
    if (nextA !== nextB) return nextA - nextB;
    if (b.pendingCount !== a.pendingCount) return b.pendingCount - a.pendingCount;
    return a.peerId.localeCompare(b.peerId);
  });

  const limit = normalizeInspectionLimit(options.limit);
  const visiblePeers = peers.slice(0, limit);
  return {
    peerCount: peers.length,
    totalPendingCount: peers.reduce((sum, peer) => sum + peer.pendingCount, 0),
    snapshotCount,
    policyGatedSnapshotCount,
    scheduledFollowupCount: peers.filter((peer) => peer.scheduledFollowupDueAt !== undefined).length,
    scheduledSleepDigestCount: peers.filter((peer) => peer.scheduledSleepDigestDueAt !== undefined).length,
    peers: visiblePeers,
  };
}

export class CustomUnreadRuntime {
  private readonly peers = new Map<string, PeerState>();
  private readonly snapshots = new Map<string, CustomUnreadCatchupSnapshot>();

  recordNonMention(params: {
    message: CustomInboundMessage;
    cfg: ResolvedCustomUnreadConfig;
    now?: number;
  }): CustomUnreadRecordResult {
    const now = params.now ?? Date.now();
    if (!params.cfg.enabled || params.message.peer.kind !== "group") {
      return { recorded: false, pendingCount: 0, intents: [] };
    }
    if (params.message.actor.isBot) {
      return {
        recorded: false,
        pendingCount: this.getPendingCount(params.message.peer.id),
        intents: [],
      };
    }

    const peer = this.getPeer(params.message.peer.id);
    peer.history.push(toHistoryEntry(params.message));
    trimHistory(peer.history, params.cfg.historyLimit);

    const intents: CustomUnreadIntent[] = [];
    if (!peer.followupActive && !peer.scheduledSleepDigestDueAt) {
      const anchor = peer.catchupAnchor ?? now;
      peer.catchupAnchor = anchor;
      const periods = Math.floor(Math.max(0, now - anchor) / params.cfg.sleepDelayMs) + 1;
      const dueAt = anchor + periods * params.cfg.sleepDelayMs;
      peer.scheduledSleepDigestDueAt = dueAt;
      intents.push({ kind: "schedule-sleep-digest", peerId: params.message.peer.id, dueAt, source: "sleep-timer" });
    }

    return { recorded: true, pendingCount: peer.history.length, intents };
  }

  observeMention(params: {
    message: CustomInboundMessage;
    cfg: ResolvedCustomUnreadConfig;
  }): CustomUnreadMentionResult {
    if (!params.cfg.enabled || params.message.peer.kind !== "group") {
      return { pendingCount: 0, shouldCatchUpAfterReply: false, history: [], intents: [] };
    }
    if (params.message.actor.id === CUSTOM_UNREAD_ACTOR_ID) {
      return {
        pendingCount: this.getPendingCount(params.message.peer.id),
        shouldCatchUpAfterReply: false,
        history: [],
        intents: [],
      };
    }

    const peer = this.getPeer(params.message.peer.id);
    const pendingCount = peer.history.length;
    const history = peer.history.slice();
    const hadFollowup = peer.scheduledFollowupDueAt !== undefined;
    const hadSleepDigest = peer.scheduledSleepDigestDueAt !== undefined;
    this.cancelWindows(peer);
    const intents: CustomUnreadIntent[] = [];
    if (hadFollowup) intents.push({ kind: "clear-followup", peerId: params.message.peer.id });
    if (hadSleepDigest) intents.push({ kind: "clear-sleep-digest", peerId: params.message.peer.id });
    return {
      pendingCount,
      shouldCatchUpAfterReply: pendingCount > 0,
      history,
      intents,
    };
  }

  markOutputComplete(params: {
    peerId: string;
    cfg: ResolvedCustomUnreadConfig;
    now?: number;
  }): CustomUnreadIntent[] {
    if (!params.cfg.enabled) return [];
    const now = params.now ?? Date.now();
    const peer = this.getPeer(params.peerId);
    peer.catchupAnchor = now;
    peer.scheduledSleepDigestDueAt = undefined;
    peer.followupActive = true;
    peer.scheduledFollowupDueAt = now + params.cfg.followupDelayMs;
    return [{
      kind: "schedule-followup",
      peerId: params.peerId,
      dueAt: peer.scheduledFollowupDueAt,
      source: "followup",
    }];
  }

  fireScheduledFollowup(params: {
    peerId: string;
    cfg: ResolvedCustomUnreadConfig;
    now?: number;
  }): CustomUnreadIntent[] {
    const peer = this.getPeer(params.peerId);
    peer.scheduledFollowupDueAt = undefined;
    if (!params.cfg.enabled) {
      peer.followupActive = false;
      return [];
    }
    if (peer.history.length === 0) {
      peer.followupActive = false;
      return [];
    }
    return this.createCatchup({
      peerId: params.peerId,
      cfg: params.cfg,
      source: "followup",
      now: params.now,
    });
  }

  fireSleepDigest(params: {
    peerId: string;
    cfg: ResolvedCustomUnreadConfig;
    now?: number;
  }): CustomUnreadIntent[] {
    const peer = this.getPeer(params.peerId);
    peer.scheduledSleepDigestDueAt = undefined;
    if (!params.cfg.enabled) return [];
    return this.createCatchup({
      peerId: params.peerId,
      cfg: params.cfg,
      source: "sleep-timer",
      now: params.now,
    });
  }

  createCatchup(params: {
    peerId: string;
    cfg: ResolvedCustomUnreadConfig;
    source: CustomUnreadCatchupSource;
    allowEmpty?: boolean;
    now?: number;
  }): CustomUnreadIntent[] {
    if (!params.cfg.enabled) return [];
    const peer = this.getPeer(params.peerId);
    if (peer.history.length === 0 && !params.allowEmpty) return [];

    const now = params.now ?? Date.now();
    const snapshot: CustomUnreadCatchupSnapshot = {
      id: `custom-unread-${params.peerId}-${now}-${this.snapshots.size + 1}`,
      peerId: params.peerId,
      source: params.source,
      entries: peer.history.slice(),
      createdAt: now,
      policyGated: !params.cfg.allowAutonomousReply || !params.cfg.allowProactiveSend,
      prompt: buildDefaultCatchupPrompt(),
    };
    this.snapshots.set(snapshot.id, snapshot);

    const enqueueIntent: CustomUnreadIntent = {
      kind: "enqueue-catchup",
      peerId: params.peerId,
      source: params.source,
      snapshot,
    };
    if (!snapshot.policyGated) return [enqueueIntent];
    return [
      {
        kind: "policy-gated",
        peerId: params.peerId,
        source: params.source,
        reason: "autonomous or proactive reply is disabled for this scene",
        snapshot,
      },
    ];
  }

  consumeSnapshot(snapshotId: string): {
    consumed: number;
    remaining: number;
    peerId?: string;
  } {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) return { consumed: 0, remaining: 0 };
    this.snapshots.delete(snapshotId);
    const peer = this.getPeer(snapshot.peerId);
    const consumed = new Set(snapshot.entries);
    peer.history = peer.history.filter((entry) => !consumed.has(entry));
    return { consumed: snapshot.entries.length, remaining: peer.history.length, peerId: snapshot.peerId };
  }

  getPendingCount(peerId: string): number {
    return this.peers.get(peerId)?.history.length ?? 0;
  }

  getState(): CustomUnreadRuntimeState {
    const peers: CustomUnreadRuntimeState["peers"] = {};
    for (const [peerId, peer] of this.peers) {
      peers[peerId] = {
        history: peer.history.slice(),
        followupActive: peer.followupActive,
        catchupAnchor: peer.catchupAnchor,
        scheduledFollowupDueAt: peer.scheduledFollowupDueAt,
        scheduledSleepDigestDueAt: peer.scheduledSleepDigestDueAt,
      };
    }
    const snapshots: CustomUnreadRuntimeState["snapshots"] = {};
    for (const [id, snapshot] of this.snapshots) {
      snapshots[id] = {
        ...snapshot,
        entries: snapshot.entries.slice(),
      };
    }
    return { peers, snapshots };
  }

  loadState(state: CustomUnreadRuntimeState): void {
    this.clear();
    for (const [peerId, peer] of Object.entries(state.peers ?? {})) {
      this.peers.set(peerId, {
        history: (peer.history ?? []).map(cloneHistoryEntry),
        followupActive: peer.followupActive === true,
        catchupAnchor: peer.catchupAnchor,
        scheduledFollowupDueAt: peer.scheduledFollowupDueAt,
        scheduledSleepDigestDueAt: peer.scheduledSleepDigestDueAt,
      });
    }
    for (const [id, snapshot] of Object.entries(state.snapshots ?? {})) {
      this.snapshots.set(id, {
        ...snapshot,
        entries: (snapshot.entries ?? []).map(cloneHistoryEntry),
      });
    }
  }

  clear(peerId?: string): void {
    if (peerId) {
      this.peers.delete(peerId);
      for (const [snapshotId, snapshot] of this.snapshots) {
        if (snapshot.peerId === peerId) this.snapshots.delete(snapshotId);
      }
      return;
    }
    this.peers.clear();
    this.snapshots.clear();
  }

  private getPeer(peerId: string): PeerState {
    let peer = this.peers.get(peerId);
    if (!peer) {
      peer = { history: [], followupActive: false };
      this.peers.set(peerId, peer);
    }
    return peer;
  }

  private cancelWindows(peer: PeerState): void {
    peer.followupActive = false;
    peer.scheduledFollowupDueAt = undefined;
    peer.scheduledSleepDigestDueAt = undefined;
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function normalizeInspectionLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.floor(n);
}

function toHistoryEntry(message: CustomInboundMessage): CustomUnreadHistoryEntry {
  return {
    actorId: message.actor.id,
    actorLabel: message.actor.label,
    body: message.content,
    timestamp: message.timestamp,
    messageId: message.messageId,
    attachments: message.attachments?.slice(),
  };
}

function cloneHistoryEntry(entry: CustomUnreadHistoryEntry): CustomUnreadHistoryEntry {
  return {
    ...entry,
    attachments: entry.attachments?.map((attachment) => ({ ...attachment })),
  };
}

function trimHistory(history: CustomUnreadHistoryEntry[], limit: number): void {
  if (history.length <= limit) return;
  history.splice(0, history.length - limit);
}

function buildDefaultCatchupPrompt(): string {
  return [
    "你刚刚看了一眼这个QQ群过去一会儿的未读消息。",
    "请结合群聊历史，像群里的真人成员一样自然接一句。",
    "只发一条简短回复；不要逐条总结；不要提到任务、定时器、机制、系统提示或自己在查看历史。",
    "不要使用工具，除非群友明确求助。",
  ].join("");
}
