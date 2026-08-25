import assert from "node:assert";
import {
  CUSTOM_UNREAD_ACTOR_ID,
  CustomUnreadRuntime,
  DEFAULT_UNREAD_FOLLOWUP_DELAY_MS,
  DEFAULT_UNREAD_HISTORY_LIMIT,
  DEFAULT_UNREAD_SLEEP_DELAY_MS,
  inspectCustomUnreadRuntimeState,
  resolveCustomUnreadConfig,
} from "../src/custom/unread-runtime.js";
import {
  buildDefaultCatchupPrompt,
  buildMentionReplyScopePrompt,
} from "../src/custom/unread-catchup-prompt.js";
import { resolveCustomUnreadConfig as resolveCustomUnreadConfigDirect } from "../src/custom/unread-config.js";
import { inspectCustomUnreadRuntimeState as inspectCustomUnreadRuntimeStateDirect } from "../src/custom/unread-inspection.js";
import type { CustomInboundMessage, CustomRuntimeConfig, CustomSceneConfig } from "../src/custom/types.js";

const baseRuntime: CustomRuntimeConfig = {
  enabled: true,
  unread: {
    enabled: true,
    historyLimit: 3,
    followupDelayMs: 1_000,
    sleepDelayMs: 10_000,
    pollIntervalsMs: [60_000, 120_000, 300_000],
  },
};

const chatScene: CustomSceneConfig = {
  scene: "chat",
  allowAutonomousReply: true,
  allowProactiveSend: true,
};

function msg(overrides: Partial<CustomInboundMessage> = {}): CustomInboundMessage {
  return {
    accountId: "default",
    peer: { kind: "group", id: "GROUP_OPENID", label: "Master Luke" },
    actor: { id: "USER_OPENID", label: "Luke" },
    content: "hello",
    messageId: "msg-1",
    timestamp: 1_000,
    mentionedBot: false,
    ...overrides,
  };
}

const cfg = resolveCustomUnreadConfig({ runtime: baseRuntime, scene: chatScene });
assert.deepEqual(cfg, resolveCustomUnreadConfigDirect({ runtime: baseRuntime, scene: chatScene }));
assert.equal(cfg.enabled, true);
assert.equal(cfg.historyLimit, 3);
assert.equal(cfg.followupDelayMs, 1_000);
assert.equal(cfg.sleepDelayMs, 10_000);
assert.equal(cfg.allowAutonomousReply, true);
assert.equal(cfg.allowProactiveSend, true);

const defaults = resolveCustomUnreadConfig({ runtime: { enabled: true }, scene: { scene: "chat" } });
assert.equal(defaults.historyLimit, DEFAULT_UNREAD_HISTORY_LIMIT);
assert.equal(defaults.followupDelayMs, DEFAULT_UNREAD_FOLLOWUP_DELAY_MS);
assert.equal(defaults.sleepDelayMs, DEFAULT_UNREAD_SLEEP_DELAY_MS);
assert.equal(defaults.allowAutonomousReply, true);
assert.equal(defaults.allowProactiveSend, true);
assert.match(buildDefaultCatchupPrompt(), /dongwuyuan-skill/);
assert.match(buildDefaultCatchupPrompt(), /不要使用“开庭”/);
assert.match(buildDefaultCatchupPrompt("mention-followup"), /完全无关/);
assert.match(buildDefaultCatchupPrompt("mention-followup"), /NO_REPLY/);
assert.match(buildMentionReplyScopePrompt(), /正文只能直接回答当前 @ 消息/);

const runtime = new CustomUnreadRuntime();
const first = runtime.recordNonMention({ message: msg(), cfg, now: 2_000 });
assert.equal(first.recorded, true);
assert.equal(first.pendingCount, 1);
assert.equal(first.intents.length, 1);
assert.equal(first.intents[0]!.kind, "schedule-followup");
assert.equal(first.intents[0]!.dueAt, 302_000);

const botIgnored = runtime.recordNonMention({
  message: msg({ actor: { id: "BOT_OPENID", isBot: true }, messageId: "bot-msg" }),
  cfg,
  now: 2_500,
});
assert.equal(botIgnored.recorded, false);
assert.equal(botIgnored.pendingCount, 1);

runtime.recordNonMention({ message: msg({ messageId: "msg-2", content: "second", timestamp: 3_000 }), cfg, now: 3_000 });
runtime.recordNonMention({ message: msg({ messageId: "msg-3", content: "third", timestamp: 4_000 }), cfg, now: 4_000 });
const fourth = runtime.recordNonMention({ message: msg({ messageId: "msg-4", content: "fourth", timestamp: 5_000 }), cfg, now: 5_000 });
assert.equal(fourth.intents.length, 0);
assert.equal(runtime.getPendingCount("GROUP_OPENID"), 3);
assert.deepEqual(runtime.getState().peers.GROUP_OPENID!.history.map((entry) => entry.messageId), ["msg-2", "msg-3", "msg-4"]);

const mention = runtime.observeMention({ message: msg({ mentionedBot: true, messageId: "mention-1" }), cfg });
assert.equal(mention.pendingCount, 3);
assert.equal(mention.shouldCatchUpAfterReply, true);
assert.equal(mention.intents.length, 1);
assert.equal(mention.intents[0]!.kind, "clear-followup");
assert.equal(runtime.getState().peers.GROUP_OPENID!.scheduledFollowupDueAt, undefined);

const mentionFollowup = runtime.createCatchup({
  peerId: "GROUP_OPENID",
  cfg,
  source: "mention-followup",
  now: 6_000,
});
assert.equal(mentionFollowup.length, 1);
assert.equal(mentionFollowup[0]!.kind, "enqueue-catchup");
assert.equal(mentionFollowup[0]!.snapshot!.entries.length, 3);
assert.equal(mentionFollowup[0]!.snapshot!.policyGated, false);
assert.equal(mentionFollowup[0]!.snapshot!.prompt, buildDefaultCatchupPrompt("mention-followup"));

const consume = runtime.consumeSnapshot(mentionFollowup[0]!.snapshot!.id);
assert.equal(consume.consumed, 3);
assert.equal(consume.remaining, 0);

const restoredSnapshotRuntime = runtimeWithRestorableSnapshot();
const restoredSnapshotState = restoredSnapshotRuntime.getState();
const restoredSnapshotId = Object.keys(restoredSnapshotState.snapshots)[0];
if (!restoredSnapshotId) throw new Error("expected restorable snapshot");
const reloadedSnapshotRuntime = new CustomUnreadRuntime();
reloadedSnapshotRuntime.loadState(restoredSnapshotState);
const restoredConsume = reloadedSnapshotRuntime.consumeSnapshot(restoredSnapshotId);
assert.equal(restoredConsume.consumed, 1);
assert.equal(restoredConsume.remaining, 0);

const scheduled = runtime.markOutputComplete({ peerId: "GROUP_OPENID", cfg, now: 10_000 });
assert.equal(scheduled.length, 1);
assert.equal(scheduled[0]!.kind, "schedule-followup");
assert.equal(scheduled[0]!.dueAt, 70_000);
assert.equal(runtime.getState().peers.GROUP_OPENID!.followupActive, true);

runtime.recordNonMention({ message: msg({ messageId: "msg-5", timestamp: 10_500 }), cfg, now: 10_500 });
const followup = runtime.fireScheduledFollowup({
  peerId: "GROUP_OPENID",
  cfg,
  now: 70_000,
});
assert.equal(followup.length, 1);
assert.equal(followup[0]!.snapshot!.entries.map((entry) => entry.messageId).join(","), "msg-5");
runtime.consumeSnapshot(followup[0]!.snapshot!.id);

const gatedRuntime = new CustomUnreadRuntime();
const gatedCfg = resolveCustomUnreadConfig({
  runtime: { enabled: true, unread: { enabled: true } },
  scene: { scene: "chat", allowAutonomousReply: false, allowProactiveSend: false },
});
gatedRuntime.recordNonMention({
  message: msg({ peer: { kind: "group", id: "GATED_GROUP" }, messageId: "gated-1" }),
  cfg: gatedCfg,
  now: 20_000,
});
const gated = gatedRuntime.createCatchup({
  peerId: "GATED_GROUP",
  cfg: gatedCfg,
  source: "sleep-timer",
  now: 30_000,
});
assert.equal(gated.length, 1);
assert.equal(gated[0]!.kind, "policy-gated");
assert.equal(gated[0]!.snapshot!.policyGated, true);

const gatedSleep = gatedRuntime.fireSleepDigest({
  peerId: "GATED_GROUP",
  cfg: gatedCfg,
  now: 40_000,
});
assert.equal(gatedSleep.length, 1);
assert.equal(gatedSleep[0]!.kind, "policy-gated");

const inspection = inspectCustomUnreadRuntimeState(gatedRuntime.getState());
assert.deepEqual(inspection, inspectCustomUnreadRuntimeStateDirect(gatedRuntime.getState()));
assert.equal(inspection.peerCount, 1);
assert.equal(inspection.totalPendingCount, 1);
assert.equal(inspection.snapshotCount, 0);
assert.equal(inspection.policyGatedSnapshotCount, 0);
assert.equal(inspection.scheduledSleepDigestCount, 0);
assert.deepEqual(inspection.peers[0], {
  peerId: "GATED_GROUP",
  pendingCount: 1,
  oldestPendingAt: 1_000,
  newestPendingAt: 1_000,
  followupActive: false,
  scheduledFollowupDueAt: 620_000,
  scheduledSleepDigestDueAt: undefined,
  snapshotCount: 0,
  policyGatedSnapshotCount: 0,
});
assert.equal(JSON.stringify(inspection).includes("hello"), false);

const digestActorMention = gatedRuntime.observeMention({
  message: msg({
    peer: { kind: "group", id: "GATED_GROUP" },
    actor: { id: CUSTOM_UNREAD_ACTOR_ID, isBot: true },
    messageId: "synthetic",
    mentionedBot: true,
  }),
  cfg: gatedCfg,
});
assert.equal(digestActorMention.shouldCatchUpAfterReply, false);

const restoredRuntime = new CustomUnreadRuntime();
const stateBeforeRestore = gatedRuntime.getState();
restoredRuntime.loadState(stateBeforeRestore);
assert.equal(restoredRuntime.getPendingCount("GATED_GROUP"), 1);
assert.equal(Object.keys(restoredRuntime.getState().snapshots).length, Object.keys(stateBeforeRestore.snapshots).length);
stateBeforeRestore.peers.GATED_GROUP!.history[0]!.body = "mutated outside";
assert.equal(restoredRuntime.getState().peers.GATED_GROUP!.history[0]!.body, "hello");
restoredRuntime.clear("GATED_GROUP");
assert.equal(restoredRuntime.getPendingCount("GATED_GROUP"), 0);

const orderedRuntime = new CustomUnreadRuntime();
orderedRuntime.recordNonMention({
  message: msg({ peer: { kind: "group", id: "B_GROUP" }, messageId: "b-1", timestamp: 100 }),
  cfg,
  now: 100,
});
orderedRuntime.recordNonMention({
  message: msg({ peer: { kind: "group", id: "A_GROUP" }, messageId: "a-1", timestamp: 200 }),
  cfg,
  now: 200,
});
const orderedInspection = inspectCustomUnreadRuntimeState(orderedRuntime.getState(), { limit: 1 });
assert.equal(orderedInspection.peerCount, 2);
assert.equal(orderedInspection.peers.length, 1);
assert.equal(orderedInspection.peers[0]?.peerId, "B_GROUP");

const stuckRuntime = new CustomUnreadRuntime();
stuckRuntime.loadState({
  peers: {
    GROUP_OPENID: {
      history: [{
        actorId: "USER_OPENID",
        actorLabel: "Luke",
        body: "pending before crash",
        timestamp: 90_000,
        messageId: "stuck-old",
      }],
      followupActive: true,
    },
  },
  snapshots: {},
});
const recovered = stuckRuntime.recordNonMention({
  message: msg({ messageId: "stuck-new", timestamp: 100_000 }),
  cfg,
  now: 100_000,
});
assert.equal(recovered.intents.length, 1);
assert.equal(recovered.intents[0]?.kind, "schedule-followup");
assert.equal(recovered.intents[0]?.dueAt, 160_000);

console.log("unread runtime tests passed");

function runtimeWithRestorableSnapshot(): CustomUnreadRuntime {
  const candidate = new CustomUnreadRuntime();
  const now = Date.now();
  candidate.recordNonMention({
    message: msg({ messageId: "restorable-1", timestamp: now - 1_000 }),
    cfg,
    now: now - 1_000,
  });
  candidate.createCatchup({
    peerId: "GROUP_OPENID",
    cfg,
    source: "mention-followup",
    now,
  });
  return candidate;
}
