import type { HistoryEntry } from "../group-history.js";
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

function nonEmptyHistory(history?: HistoryEntry[]): HistoryEntry[] | undefined {
  return history && history.length > 0 ? history : undefined;
}
