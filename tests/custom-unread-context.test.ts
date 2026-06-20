import assert from "node:assert";
import {
  buildCustomUnreadHistoryContextBody,
  clearLegacyGroupHistoryAfterDispatch,
  recordLegacyGroupHistoryBeforeDispatch,
  selectCustomUnreadHistoryContext,
} from "../src/custom/unread-context.js";
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

const legacyRecordHistories = new Map<string, HistoryEntry[]>();
const legacyRecord = recordLegacyGroupHistoryBeforeDispatch({
  event: {
    type: "group",
    groupOpenid: "GROUP_OPENID",
    senderId: "MEMBER_OPENID",
    senderName: "Member",
    timestamp: "2026-06-21T00:00:00.000Z",
    messageId: "msg-1",
    attachments: [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" }],
  },
  groupHistories: legacyRecordHistories,
  historyLimit: 10,
  content: "legacy body",
});
assert.equal(legacyRecord.recorded, true);
assert.equal(legacyRecord.pendingCount, 1);
assert.equal(legacyRecord.attachmentCount, 1);
assert.equal(legacyRecordHistories.get("GROUP_OPENID")?.[0]?.sender, "Member (MEMBER_OPENID)");
assert.equal(legacyRecordHistories.get("GROUP_OPENID")?.[0]?.attachments?.[0]?.type, "image");

const built = buildCustomUnreadHistoryContextBody({
  event: {
    groupOpenid: "GROUP_OPENID",
  },
  groupHistories: legacyRecordHistories,
  historyLimit: 10,
  currentMessage: "current body",
  formatEnvelope: (entry) => `[${entry.sender}] ${entry.body}`,
});
assert.equal(built.source, "legacy");
assert.equal(built.body.includes("[上次回复后的聊天消息 - 作为上下文]"), true);
assert.equal(built.body.includes("[Member (MEMBER_OPENID)] legacy body MEDIA:https://example.com/a.png"), true);
assert.equal(built.body.endsWith("current body"), true);

clearLegacyGroupHistoryAfterDispatch({
  groupHistories: legacyRecordHistories,
  groupOpenid: "GROUP_OPENID",
  historyLimit: 10,
});
assert.deepEqual(legacyRecordHistories.get("GROUP_OPENID"), []);

console.log("custom unread context tests passed");
