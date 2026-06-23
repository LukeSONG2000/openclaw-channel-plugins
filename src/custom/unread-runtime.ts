import type {
  CustomAttachment,
  CustomInboundMessage,
} from "./types.js";
import { buildDefaultCatchupPrompt } from "./unread-catchup-prompt.js";
import type { ResolvedCustomUnreadConfig } from "./unread-config.js";

export {
  DEFAULT_UNREAD_FOLLOWUP_DELAY_MS,
  DEFAULT_UNREAD_HISTORY_LIMIT,
  DEFAULT_UNREAD_SLEEP_DELAY_MS,
  resolveCustomUnreadConfig,
  type ResolvedCustomUnreadConfig,
} from "./unread-config.js";
export {
  inspectCustomUnreadRuntimeState,
  type CustomUnreadPeerInspection,
  type CustomUnreadRuntimeInspection,
} from "./unread-inspection.js";

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
    pollLevelIndex?: number;
  }>;
  snapshots: Record<string, CustomUnreadCatchupSnapshot>;
}

interface PeerState {
  history: CustomUnreadHistoryEntry[];
  followupActive: boolean;
  catchupAnchor?: number;
  scheduledFollowupDueAt?: number;
  scheduledSleepDigestDueAt?: number;
  pollLevelIndex?: number;
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
    if (!peer.followupActive && !peer.scheduledFollowupDueAt && !peer.scheduledSleepDigestDueAt) {
      const dueAt = now + currentPollIntervalMs(peer, params.cfg);
      peer.scheduledFollowupDueAt = dueAt;
      intents.push({ kind: "schedule-followup", peerId: params.message.peer.id, dueAt, source: "followup" });
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
    resetToMin?: boolean;
    now?: number;
  }): CustomUnreadIntent[] {
    if (!params.cfg.enabled) return [];
    const now = params.now ?? Date.now();
    const peer = this.getPeer(params.peerId);
    if (params.resetToMin !== false) peer.pollLevelIndex = 0;
    peer.catchupAnchor = now;
    peer.scheduledSleepDigestDueAt = undefined;
    peer.followupActive = true;
    peer.scheduledFollowupDueAt = now + currentPollIntervalMs(peer, params.cfg);
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
      increasePollInterval(peer, params.cfg);
      peer.followupActive = true;
      const now = params.now ?? Date.now();
      peer.scheduledFollowupDueAt = now + currentPollIntervalMs(peer, params.cfg);
      return [{
        kind: "schedule-followup",
        peerId: params.peerId,
        dueAt: peer.scheduledFollowupDueAt,
        source: "followup",
      }];
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
    if (peer.history.length === 0) {
      increasePollInterval(peer, params.cfg);
      peer.followupActive = true;
      const now = params.now ?? Date.now();
      peer.scheduledFollowupDueAt = now + currentPollIntervalMs(peer, params.cfg);
      return [{
        kind: "schedule-followup",
        peerId: params.peerId,
        dueAt: peer.scheduledFollowupDueAt,
        source: "followup",
      }];
    }
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
    if (peer.history.length > 0 && (params.source === "followup" || params.source === "sleep-timer")) {
      decreasePollInterval(peer);
    }

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
    source?: CustomUnreadCatchupSource;
  } {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) return { consumed: 0, remaining: 0 };
    this.snapshots.delete(snapshotId);
    const peer = this.getPeer(snapshot.peerId);
    const consumed = new Set(snapshot.entries);
    peer.history = peer.history.filter((entry) => !consumed.has(entry));
    return { consumed: snapshot.entries.length, remaining: peer.history.length, peerId: snapshot.peerId, source: snapshot.source };
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
        pollLevelIndex: peer.pollLevelIndex,
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
        pollLevelIndex: sanitizePollLevel(peer.pollLevelIndex),
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

function currentPollIntervalMs(peer: PeerState, cfg: ResolvedCustomUnreadConfig): number {
  const intervals = cfg.pollIntervalsMs.length ? cfg.pollIntervalsMs : [60_000];
  return intervals[sanitizePollLevel(peer.pollLevelIndex, intervals.length)] ?? intervals[0]!;
}

function increasePollInterval(peer: PeerState, cfg: ResolvedCustomUnreadConfig): void {
  const max = Math.max(0, cfg.pollIntervalsMs.length - 1);
  peer.pollLevelIndex = Math.min(max, sanitizePollLevel(peer.pollLevelIndex, cfg.pollIntervalsMs.length) + 1);
}

function decreasePollInterval(peer: PeerState): void {
  peer.pollLevelIndex = Math.max(0, sanitizePollLevel(peer.pollLevelIndex) - 1);
}

function sanitizePollLevel(value: unknown, length = 6): number {
  const fallback = Math.min(3, Math.max(0, length - 1));
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.max(0, Math.floor(n)), Math.max(0, length - 1));
}
