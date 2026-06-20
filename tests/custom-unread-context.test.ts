import assert from "node:assert";
import { selectCustomUnreadHistoryContext } from "../src/custom/unread-context.js";
import type { HistoryEntry } from "../src/group-history.js";

const legacyHistory: HistoryEntry[] = [{ sender: "Legacy", body: "legacy", timestamp: 1 }];
const mentionHistory: HistoryEntry[] = [{ sender: "Mention", body: "mention", timestamp: 2 }];
const snapshotHistory: HistoryEntry[] = [{ sender: "Snapshot", body: "snapshot", timestamp: 3 }];
const groupHistories = new Map<string, HistoryEntry[]>([["GROUP_OPENID", legacyHistory]]);

const snapshot = selectCustomUnreadHistoryContext({
  event: {
    groupOpenid: "GROUP_OPENID",
    _customUnreadSnapshot: snapshotHistory,
  },
  groupHistories,
  mentionHistory,
});
assert.equal(snapshot.source, "snapshot");
assert.notEqual(snapshot.historyMap, groupHistories);
assert.deepEqual(snapshot.historyMap.get("GROUP_OPENID"), snapshotHistory);

const mention = selectCustomUnreadHistoryContext({
  event: {
    groupOpenid: "GROUP_OPENID",
  },
  groupHistories,
  mentionHistory,
});
assert.equal(mention.source, "mention");
assert.notEqual(mention.historyMap, groupHistories);
assert.deepEqual(mention.historyMap.get("GROUP_OPENID"), mentionHistory);

const emptySnapshotFallsBackToMention = selectCustomUnreadHistoryContext({
  event: {
    groupOpenid: "GROUP_OPENID",
    _customUnreadSnapshot: [],
  },
  groupHistories,
  mentionHistory,
});
assert.equal(emptySnapshotFallsBackToMention.source, "mention");
assert.deepEqual(emptySnapshotFallsBackToMention.historyMap.get("GROUP_OPENID"), mentionHistory);

const legacy = selectCustomUnreadHistoryContext({
  event: {
    groupOpenid: "GROUP_OPENID",
  },
  groupHistories,
});
assert.equal(legacy.source, "legacy");
assert.equal(legacy.historyMap, groupHistories);
assert.deepEqual(legacy.historyMap.get("GROUP_OPENID"), legacyHistory);

console.log("custom unread context tests passed");
