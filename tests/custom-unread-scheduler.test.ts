import assert from "node:assert";
import { CustomUnreadScheduler } from "../src/custom/unread-scheduler.js";
import { effectsFromCustomUnreadIntents, toCustomInboundGroupMessage } from "../src/custom/unread-gateway-adapter.js";
import { CustomUnreadRuntime, resolveCustomUnreadConfig } from "../src/custom/unread-runtime.js";
import type { QueuedMessage } from "../src/message-queue.js";

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

let now = 1_000;
let nextTimerId = 0;
const scheduled = new Map<number, { callback: () => void; delayMs: number }>();
const enqueued: QueuedMessage[] = [];
const persisted: string[] = [];
const logs: string[] = [];

const unread = new CustomUnreadRuntime();
const scheduler = new CustomUnreadScheduler({
  accountId: "default",
  unread,
  enqueue: (message) => {
    enqueued.push(message);
  },
  persist: () => {
    persisted.push("persist");
  },
  resolveConfigForPeer: (peerId) => peerId === "GROUP_OPENID" ? cfg : null,
  log: {
    info: (msg) => logs.push(msg),
    debug: (msg) => logs.push(msg),
    error: (msg) => logs.push(msg),
  },
  now: () => now,
  setTimer: (callback, delayMs) => {
    const id = ++nextTimerId;
    scheduled.set(id, { callback, delayMs });
    return id;
  },
  clearTimer: (timer) => {
    scheduled.delete(timer as number);
  },
});

const inbound = toCustomInboundGroupMessage({
  accountId: "default",
  groupOpenid: "GROUP_OPENID",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "hello",
  messageId: "msg-1",
  timestamp: 1_000,
  mentionedBot: false,
});

const record = unread.recordNonMention({ message: inbound, cfg, now });
scheduler.apply(
  effectsFromCustomUnreadIntents({
    accountId: "default",
    peer: inbound.peer,
    intents: record.intents,
    now,
  }),
  cfg,
);
assert.equal(scheduler.timerCount("sleep-digest"), 1);
assert.equal([...scheduled.values()][0]?.delayMs, 10_000);
assert.equal(persisted.length, 1);
assert.equal(logs.some((line) => line.includes("sleep-digest timer set")), true);

const mention = unread.observeMention({
  message: { ...inbound, mentionedBot: true, messageId: "mention-1" },
  cfg,
});
scheduler.apply(
  effectsFromCustomUnreadIntents({
    accountId: "default",
    peer: inbound.peer,
    intents: mention.intents,
    now,
  }),
  cfg,
);
assert.equal(scheduler.timerCount(), 0);
assert.equal(scheduled.size, 0);

const followup = unread.markOutputComplete({ peerId: "GROUP_OPENID", cfg, now: 2_000 });
scheduler.apply(
  effectsFromCustomUnreadIntents({
    accountId: "default",
    peer: inbound.peer,
    intents: followup,
    now: 2_000,
  }),
  cfg,
);
assert.equal(scheduler.timerCount("followup"), 1);
unread.recordNonMention({
  message: { ...inbound, messageId: "msg-2", timestamp: 2_500 },
  cfg,
  now: 2_500,
});
now = 3_000;
const fireFollowup = [...scheduled.values()][0]?.callback;
if (!fireFollowup) throw new Error("expected followup timer");
fireFollowup();
assert.equal(enqueued.length, 1);
assert.equal(enqueued[0]?._customUnreadSnapshotId?.startsWith("custom-unread-GROUP_OPENID-"), true);
assert.equal(scheduler.timerCount(), 0);

const restoredRuntime = new CustomUnreadRuntime();
restoredRuntime.loadState({
  peers: {
    GROUP_OPENID: {
      history: [],
      followupActive: false,
      scheduledFollowupDueAt: 5_000,
      scheduledSleepDigestDueAt: 10_000,
    },
  },
  snapshots: {},
});
const restoredScheduled = new Map<number, { callback: () => void; delayMs: number }>();
const restoredScheduler = new CustomUnreadScheduler({
  accountId: "default",
  unread: restoredRuntime,
  enqueue: () => undefined,
  persist: () => undefined,
  resolveConfigForPeer: () => cfg,
  now: () => 4_000,
  setTimer: (callback, delayMs) => {
    const id = ++nextTimerId;
    restoredScheduled.set(id, { callback, delayMs });
    return id;
  },
  clearTimer: (timer) => {
    restoredScheduled.delete(timer as number);
  },
});
restoredScheduler.restore(restoredRuntime.getState());
assert.equal(restoredScheduler.timerCount("followup"), 1);
assert.equal(restoredScheduler.timerCount("sleep-digest"), 1);
assert.deepEqual([...restoredScheduled.values()].map((item) => item.delayMs).sort((a, b) => a - b), [1_000, 6_000]);
restoredScheduler.dispose();
assert.equal(restoredScheduled.size, 0);

console.log("custom unread scheduler tests passed");
