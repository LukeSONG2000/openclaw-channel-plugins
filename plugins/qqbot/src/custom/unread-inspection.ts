import type { CustomUnreadRuntimeState } from "./unread-runtime.js";

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

function normalizeInspectionLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 20;
  return Math.floor(n);
}
