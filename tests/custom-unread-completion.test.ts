import assert from "node:assert";
import { completeCustomUnreadAfterDispatch } from "../src/custom/unread-completion.js";
import { toCustomInboundGroupMessage } from "../src/custom/unread-gateway-adapter.js";
import { CustomUnreadRuntime, resolveCustomUnreadConfig } from "../src/custom/unread-runtime.js";

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

function runtimeWithHistory(): CustomUnreadRuntime {
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
  return runtime;
}

const snapshotRuntime = runtimeWithHistory();
const catchup = snapshotRuntime.createCatchup({
  peerId: "GROUP_OPENID",
  cfg,
  source: "sleep-timer",
  now: 2_000,
});
const snapshotId = catchup[0]?.snapshot?.id;
if (!snapshotId) throw new Error("expected snapshot");

const consumed = completeCustomUnreadAfterDispatch({
  accountId: "default",
  unread: snapshotRuntime,
  groupOpenid: "GROUP_OPENID",
  cfg,
  snapshotId,
  hasModelBlockOutput: true,
  shouldCatchUpAfterReply: false,
  wasMentioned: false,
});
assert.equal(consumed.handled, true);
assert.equal(consumed.persist, true);
assert.equal(consumed.logs[0]?.message.includes("consumed=1"), true);
assert.equal(consumed.effects.length, 1);
assert.equal(consumed.effects[0]?.kind, "set-timer");
assert.equal(Object.keys(snapshotRuntime.getState().snapshots).length, 0);

const keptRuntime = runtimeWithHistory();
const keptSnapshot = keptRuntime.createCatchup({
  peerId: "GROUP_OPENID",
  cfg,
  source: "sleep-timer",
  now: 3_000,
})[0]?.snapshot?.id;
if (!keptSnapshot) throw new Error("expected kept snapshot");
const kept = completeCustomUnreadAfterDispatch({
  accountId: "default",
  unread: keptRuntime,
  groupOpenid: "GROUP_OPENID",
  cfg,
  snapshotId: keptSnapshot,
  hasModelBlockOutput: false,
  shouldCatchUpAfterReply: false,
  wasMentioned: false,
});
assert.equal(kept.handled, true);
assert.equal(kept.persist, false);
assert.equal(kept.effects.length, 0);
assert.equal(Object.keys(keptRuntime.getState().snapshots).length, 1);

const mentionRuntime = runtimeWithHistory();
const mentionCatchup = completeCustomUnreadAfterDispatch({
  accountId: "default",
  unread: mentionRuntime,
  groupOpenid: "GROUP_OPENID",
  cfg,
  hasModelBlockOutput: true,
  shouldCatchUpAfterReply: true,
  wasMentioned: true,
});
assert.equal(mentionCatchup.handled, true);
assert.equal(mentionCatchup.persist, false);
assert.equal(mentionCatchup.effects[0]?.kind, "enqueue");

const outputRuntime = new CustomUnreadRuntime();
const outputComplete = completeCustomUnreadAfterDispatch({
  accountId: "default",
  unread: outputRuntime,
  groupOpenid: "GROUP_OPENID",
  cfg,
  hasModelBlockOutput: true,
  shouldCatchUpAfterReply: false,
  wasMentioned: true,
});
assert.equal(outputComplete.handled, true);
assert.equal(outputComplete.persist, false);
assert.equal(outputComplete.effects[0]?.kind, "set-timer");

const ignored = completeCustomUnreadAfterDispatch({
  accountId: "default",
  unread: outputRuntime,
  groupOpenid: "GROUP_OPENID",
  cfg,
  hasModelBlockOutput: false,
  shouldCatchUpAfterReply: false,
  wasMentioned: true,
});
assert.equal(ignored.handled, false);
assert.equal(ignored.effects.length, 0);

console.log("custom unread completion tests passed");
