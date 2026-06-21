import {
  buildPendingHistoryContext,
  clearPendingHistory,
  formatAttachmentTags,
  recordPendingHistoryEntry,
  toAttachmentSummaries,
  type HistoryEntry,
} from "../group-history.js";
import type { QueuedMessage } from "../message-queue.js";

export interface CustomUnreadHistoryContextInput {
  event: Pick<QueuedMessage, "groupOpenid" | "_customUnreadSnapshot">;
  groupHistories: Map<string, HistoryEntry[]>;
  mentionHistory?: HistoryEntry[];
}

export interface CustomUnreadHistoryContextSelection {
  historyMap: Map<string, HistoryEntry[]>;
  source: "snapshot" | "mention" | "legacy";
}

export interface CustomUnreadHistoryEnvelopeEntry {
  sender: string;
  timestamp?: number;
  body: string;
  source: HistoryEntry;
}

export interface CustomUnreadHistoryContextBuildResult {
  body: string;
  source: CustomUnreadHistoryContextSelection["source"];
}

export interface CustomUnreadAgentBodyHistoryResult extends CustomUnreadHistoryContextBuildResult {
  applied: boolean;
}

export interface LegacyGroupHistoryRecordResult {
  pendingCount: number;
  attachmentCount: number;
  recorded: boolean;
}

export function selectCustomUnreadHistoryContext(
  params: CustomUnreadHistoryContextInput,
): CustomUnreadHistoryContextSelection {
  const groupOpenid = params.event.groupOpenid;
  const customHistory = nonEmptyHistory(params.event._customUnreadSnapshot)
    ?? nonEmptyHistory(params.mentionHistory);

  if (customHistory && groupOpenid) {
    return {
      historyMap: new Map<string, HistoryEntry[]>([[groupOpenid, customHistory]]),
      source: params.event._customUnreadSnapshot?.length ? "snapshot" : "mention",
    };
  }

  return {
    historyMap: params.groupHistories,
    source: "legacy",
  };
}

export function buildCustomUnreadHistoryContextBody(params: {
  event: Pick<QueuedMessage, "groupOpenid" | "_customUnreadSnapshot">;
  groupHistories: Map<string, HistoryEntry[]>;
  mentionHistory?: HistoryEntry[];
  historyLimit: number;
  currentMessage: string;
  formatEnvelope: (entry: CustomUnreadHistoryEnvelopeEntry) => string;
  lineBreak?: string;
}): CustomUnreadHistoryContextBuildResult {
  const selection = selectCustomUnreadHistoryContext({
    event: params.event,
    groupHistories: params.groupHistories,
    mentionHistory: params.mentionHistory,
  });
  return {
    source: selection.source,
    body: buildPendingHistoryContext({
      historyMap: selection.historyMap,
      historyKey: params.event.groupOpenid ?? "",
      limit: params.historyLimit,
      currentMessage: params.currentMessage,
      lineBreak: params.lineBreak,
      formatEntry: (entry) => params.formatEnvelope({
        sender: entry.sender,
        timestamp: entry.timestamp,
        body: withAttachmentTags(entry),
        source: entry,
      }),
    }),
  };
}

export function applyCustomUnreadHistoryContextToAgentBody(params: {
  event: Pick<QueuedMessage, "type" | "groupOpenid" | "_customUnreadSnapshot">;
  groupHistories: Map<string, HistoryEntry[]>;
  mentionHistory?: HistoryEntry[];
  historyLimit: number;
  currentMessage: string;
  formatEnvelope: (entry: CustomUnreadHistoryEnvelopeEntry) => string;
  lineBreak?: string;
}): CustomUnreadAgentBodyHistoryResult {
  if (params.event.type !== "group" || !params.event.groupOpenid) {
    return {
      body: params.currentMessage,
      source: "legacy",
      applied: false,
    };
  }

  const result = buildCustomUnreadHistoryContextBody({
    event: params.event,
    groupHistories: params.groupHistories,
    mentionHistory: params.mentionHistory,
    historyLimit: params.historyLimit,
    currentMessage: params.currentMessage,
    formatEnvelope: params.formatEnvelope,
    lineBreak: params.lineBreak,
  });
  return {
    ...result,
    applied: result.body !== params.currentMessage,
  };
}

export function recordLegacyGroupHistoryBeforeDispatch(params: {
  event: Pick<QueuedMessage, "type" | "groupOpenid" | "senderName" | "senderId" | "timestamp" | "messageId" | "attachments">;
  groupHistories: Map<string, HistoryEntry[]>;
  historyLimit: number;
  content: string;
}): LegacyGroupHistoryRecordResult {
  if (params.event.type !== "group" || !params.event.groupOpenid) {
    return { pendingCount: 0, attachmentCount: 0, recorded: false };
  }

  const sender = params.event.senderName
    ? `${params.event.senderName} (${params.event.senderId})`
    : params.event.senderId;
  const attachments = toAttachmentSummaries(params.event.attachments);
  recordPendingHistoryEntry({
    historyMap: params.groupHistories,
    historyKey: params.event.groupOpenid,
    limit: params.historyLimit,
    entry: {
      sender,
      body: params.content,
      timestamp: new Date(params.event.timestamp).getTime(),
      messageId: params.event.messageId,
      attachments,
    },
  });

  return {
    pendingCount: (params.groupHistories.get(params.event.groupOpenid) ?? []).length,
    attachmentCount: attachments?.length ?? 0,
    recorded: params.historyLimit > 0,
  };
}

export function clearLegacyGroupHistoryAfterDispatch(params: {
  groupHistories: Map<string, HistoryEntry[]>;
  groupOpenid?: string;
  historyLimit: number;
}): void {
  if (!params.groupOpenid) return;
  clearPendingHistory({
    historyMap: params.groupHistories,
    historyKey: params.groupOpenid,
    limit: params.historyLimit,
  });
}

function nonEmptyHistory(history?: HistoryEntry[]): HistoryEntry[] | undefined {
  return history && history.length > 0 ? history : undefined;
}

function withAttachmentTags(entry: HistoryEntry): string {
  const attachmentDesc = formatAttachmentTags(entry.attachments);
  return attachmentDesc ? `${entry.body} ${attachmentDesc}` : entry.body;
}
