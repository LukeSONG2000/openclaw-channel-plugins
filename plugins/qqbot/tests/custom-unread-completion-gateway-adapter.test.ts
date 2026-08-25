import assert from "node:assert";
import { applyCustomUnreadCompletionGateway } from "../src/custom/unread-completion-gateway-adapter.js";
import { CustomUnreadRuntime, resolveCustomUnreadConfig } from "../src/custom/unread-runtime.js";
import { toCustomInboundGroupMessage } from "../src/custom/unread-gateway-adapter.js";
import type { HistoryEntry } from "../src/group-history.js";

const cfg = resolveCustomUnreadConfig({
  runtime: {
    enabled: true,
    unread: {
      enabled: true,
      followupDelayMs: 1_000,
      sleepDelayMs: 10_000,
    },
  },
  scene: {
    scene: "chat",
    allowAutonomousReply: true,
    allowProactiveSend: true,
  },
});

function runtimeWithSnapshot(): { runtime: CustomUnreadRuntime; snapshotId: string } {
  const runtime = new CustomUnreadRuntime();
  runtime.recordNonMention({
    message: toCustomInboundGroupMessage({
      accountId: "default",
      groupOpenid: "GROUP_OPENID",
      senderId: "MEMBER_OPENID",
      senderName: "Member",
      content: "hello",
      messageId: "msg-1",
      timestamp: 1_000,
      mentionedBot: false,
    }),
    cfg,
    now: 1_000,
  });
  const snapshotId = runtime.createCatchup({
    peerId: "GROUP_OPENID",
    cfg,
    source: "sleep-timer",
    now: 2_000,
  })[0]?.snapshot?.id;
  if (!snapshotId) throw new Error("expected snapshot");
  return { runtime, snapshotId };
}

const { runtime, snapshotId } = runtimeWithSnapshot();
let persistCount = 0;
let scheduledEffects = 0;
const logs: string[] = [];
const handled = applyCustomUnreadCompletionGateway({
  accountId: "default",
  unread: runtime,
  groupOpenid: "GROUP_OPENID",
  cfg,
  snapshotId,
  hasModelBlockOutput: true,
  shouldCatchUpAfterReply: false,
  wasMentioned: false,
  groupHistories: new Map(),
  resolveHistoryLimit: () => {
    throw new Error("custom handled should not clear legacy history");
  },
  persistCustomUnreadState: () => { persistCount += 1; },
  applySchedulerEffects: (effects) => { scheduledEffects += effects.length; },
  log: { info: (msg) => logs.push(msg) },
});
assert.equal(handled.kind, "custom-handled");
assert.equal(persistCount, 1);
assert.equal(scheduledEffects, 1);
assert.equal(logs[0]?.includes("custom unread catch-up completed"), true);

const groupHistories = new Map<string, HistoryEntry[]>([[
  "GROUP_OPENID",
  [{ sender: "Member", body: "pending", timestamp: 1_000, messageId: "msg-pending" }],
]]);
const legacy = applyCustomUnreadCompletionGateway({
  accountId: "default",
  unread: new CustomUnreadRuntime(),
  groupOpenid: "GROUP_OPENID",
  cfg: null,
  hasModelBlockOutput: false,
  shouldCatchUpAfterReply: false,
  wasMentioned: false,
  groupHistories,
  resolveHistoryLimit: (groupOpenid, accountId) => {
    assert.equal(groupOpenid, "GROUP_OPENID");
    assert.equal(accountId, "default");
    return 10;
  },
  persistCustomUnreadState: () => {
    throw new Error("legacy clear should not persist custom unread");
  },
});
assert.equal(legacy.kind, "legacy-cleared");
assert.equal(legacy.kind === "legacy-cleared" && legacy.historyLimit, 10);
assert.equal(groupHistories.get("GROUP_OPENID")?.length, 0);

const nonGroup = applyCustomUnreadCompletionGateway({
  accountId: "default",
  unread: new CustomUnreadRuntime(),
  cfg,
  hasModelBlockOutput: true,
  shouldCatchUpAfterReply: false,
  wasMentioned: true,
  groupHistories: new Map(),
  resolveHistoryLimit: () => {
    throw new Error("non-group should not resolve history");
  },
  persistCustomUnreadState: () => {
    throw new Error("non-group should not persist");
  },
});
assert.equal(nonGroup.kind, "non-group");

console.log("custom unread completion gateway adapter tests passed");
