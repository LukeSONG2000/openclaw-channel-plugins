import type { QueuedMessage } from "../message-queue.js";
import type { AttachmentSummary, HistoryEntry } from "../group-history.js";
import type { CustomInboundMessage, CustomPeer } from "./types.js";
import {
  CUSTOM_UNREAD_ACTOR_ID,
  type CustomUnreadCatchupSnapshot,
  type CustomUnreadHistoryEntry,
  type CustomUnreadIntent,
} from "./unread-runtime.js";

export type CustomUnreadGatewayEffect =
  | { kind: "set-timer"; timer: "followup" | "sleep-digest"; peerId: string; dueAt: number }
  | { kind: "clear-timer"; timer: "followup" | "sleep-digest"; peerId: string }
  | { kind: "enqueue"; message: QueuedMessage }
  | { kind: "policy-gated"; peerId: string; source?: string; reason?: string; snapshotId?: string };

export function toCustomInboundGroupMessage(params: {
  accountId: string;
  groupOpenid: string;
  senderId: string;
  senderName?: string;
  senderIsBot?: boolean;
  content: string;
  messageId: string;
  timestamp: string | number;
  mentionedBot: boolean;
  implicitMention?: boolean;
  attachments?: QueuedMessage["attachments"];
}): CustomInboundMessage {
  return {
    accountId: params.accountId,
    peer: { kind: "group", id: params.groupOpenid },
    actor: {
      id: params.senderId,
      label: params.senderName,
      isBot: params.senderIsBot,
    },
    content: params.content,
    messageId: params.messageId,
    timestamp: typeof params.timestamp === "number" ? params.timestamp : new Date(params.timestamp).getTime(),
    mentionedBot: params.mentionedBot,
    implicitMention: params.implicitMention,
    attachments: params.attachments?.map((att) => ({
      contentType: att.content_type,
      filename: att.filename,
      url: att.url,
      transcript: att.asr_refer_text,
    })),
  };
}

export function historyEntryFromCustomUnread(entry: CustomUnreadHistoryEntry): HistoryEntry {
  return {
    sender: entry.actorLabel ? `${entry.actorLabel} (${entry.actorId})` : entry.actorId,
    body: entry.body,
    timestamp: entry.timestamp,
    messageId: entry.messageId,
    attachments: entry.attachments?.map((att) => ({
      type: inferAttachmentType(att.contentType),
      filename: att.filename,
      transcript: att.transcript,
      url: att.url,
    })),
  };
}

export function historySnapshotFromCustomUnread(snapshot?: CustomUnreadCatchupSnapshot): HistoryEntry[] | undefined {
  if (!snapshot) return undefined;
  return snapshot.entries.map(historyEntryFromCustomUnread);
}

export function historyEntriesFromCustomUnread(entries: CustomUnreadHistoryEntry[]): HistoryEntry[] {
  return entries.map(historyEntryFromCustomUnread);
}

export function buildCustomUnreadCatchupMessage(params: {
  accountId: string;
  peer: CustomPeer;
  snapshot: CustomUnreadCatchupSnapshot;
  now?: number;
}): QueuedMessage {
  const now = params.now ?? Date.now();
  const latestTs = params.snapshot.entries[params.snapshot.entries.length - 1]?.timestamp ?? now;
  const syntheticMessageId = `qqbot-digest-${params.accountId}-${params.peer.id}-${now}`;
  return {
    type: "group",
    senderId: CUSTOM_UNREAD_ACTOR_ID,
    senderName: "未读群聊",
    senderIsBot: true,
    content: params.snapshot.prompt,
    messageId: syntheticMessageId,
    timestamp: new Date(latestTs).toISOString(),
    groupOpenid: params.peer.id,
    eventType: "GROUP_AT_MESSAGE_CREATE",
    mentions: [{ is_you: true }],
    _customUnreadSnapshotId: params.snapshot.id,
    _customUnreadSnapshot: historySnapshotFromCustomUnread(params.snapshot),
    _noMerge: true,
  };
}

export function effectsFromCustomUnreadIntents(params: {
  accountId: string;
  peer: CustomPeer;
  intents: CustomUnreadIntent[];
  now?: number;
}): CustomUnreadGatewayEffect[] {
  const effects: CustomUnreadGatewayEffect[] = [];
  for (const intent of params.intents) {
    if (intent.kind === "schedule-followup" && intent.dueAt) {
      effects.push({ kind: "set-timer", timer: "followup", peerId: intent.peerId, dueAt: intent.dueAt });
      continue;
    }
    if (intent.kind === "schedule-sleep-digest" && intent.dueAt) {
      effects.push({ kind: "set-timer", timer: "sleep-digest", peerId: intent.peerId, dueAt: intent.dueAt });
      continue;
    }
    if (intent.kind === "clear-followup") {
      effects.push({ kind: "clear-timer", timer: "followup", peerId: intent.peerId });
      continue;
    }
    if (intent.kind === "clear-sleep-digest") {
      effects.push({ kind: "clear-timer", timer: "sleep-digest", peerId: intent.peerId });
      continue;
    }
    if (intent.kind === "enqueue-catchup" && intent.snapshot) {
      effects.push({
        kind: "enqueue",
        message: buildCustomUnreadCatchupMessage({
          accountId: params.accountId,
          peer: params.peer,
          snapshot: intent.snapshot,
          now: params.now,
        }),
      });
      continue;
    }
    if (intent.kind === "policy-gated") {
      effects.push({
        kind: "policy-gated",
        peerId: intent.peerId,
        source: intent.source,
        reason: intent.reason,
        snapshotId: intent.snapshot?.id,
      });
    }
  }
  return effects;
}

export function getCustomUnreadSnapshotId(message: Pick<QueuedMessage, "_customUnreadSnapshotId">): string | undefined {
  return message._customUnreadSnapshotId;
}

function inferAttachmentType(contentType?: string): AttachmentSummary["type"] {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return "image";
  if (ct === "voice" || ct.startsWith("audio/") || ct.includes("silk") || ct.includes("amr")) return "voice";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("application/") || ct.startsWith("text/")) return "file";
  return "unknown";
}
