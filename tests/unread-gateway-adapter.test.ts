import assert from "node:assert";
import {
  buildCustomUnreadCatchupMessage,
  effectsFromCustomUnreadIntents,
  getCustomUnreadSnapshotId,
  historySnapshotFromCustomUnread,
  toCustomInboundGroupMessage,
} from "../src/custom/unread-gateway-adapter.js";
import { CustomUnreadRuntime, resolveCustomUnreadConfig } from "../src/custom/unread-runtime.js";
import type { CustomPeer } from "../src/custom/types.js";

const inbound = toCustomInboundGroupMessage({
  accountId: "default",
  groupOpenid: "GROUP_OPENID",
  senderId: "MEMBER_OPENID",
  senderName: "Luke",
  content: "看这个",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  mentionedBot: false,
  attachments: [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" }],
});
assert.equal(inbound.peer.kind, "group");
assert.equal(inbound.peer.id, "GROUP_OPENID");
assert.equal(inbound.actor.id, "MEMBER_OPENID");
assert.equal(inbound.actor.label, "Luke");
assert.equal(inbound.attachments?.[0]?.contentType, "image/png");

const runtime = new CustomUnreadRuntime();
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

const record = runtime.recordNonMention({ message: inbound, cfg, now: 1_000 });
const peer: CustomPeer = { kind: "group", id: "GROUP_OPENID" };
const timerEffects = effectsFromCustomUnreadIntents({
  accountId: "default",
  peer,
  intents: record.intents,
  now: 1_000,
});
assert.equal(timerEffects.length, 1);
assert.deepEqual(timerEffects[0], {
  kind: "set-timer",
  timer: "sleep-digest",
  peerId: "GROUP_OPENID",
  dueAt: 11_000,
});

const catchupIntent = runtime.fireSleepDigest({
  peerId: "GROUP_OPENID",
  cfg,
  now: 11_000,
});
const enqueueEffects = effectsFromCustomUnreadIntents({
  accountId: "default",
  peer,
  intents: catchupIntent,
  now: 11_000,
});
assert.equal(enqueueEffects.length, 1);
assert.equal(enqueueEffects[0]!.kind, "enqueue");
if (enqueueEffects[0]!.kind !== "enqueue") throw new Error("expected enqueue effect");
assert.equal(enqueueEffects[0].message.senderId, "__qqbot_digest__");
assert.equal(enqueueEffects[0].message.groupOpenid, "GROUP_OPENID");
assert.equal(enqueueEffects[0].message._noMerge, true);
assert.equal(enqueueEffects[0].message._customUnreadSnapshot?.length, 1);
assert.equal(enqueueEffects[0].message._customUnreadSnapshot?.[0]?.attachments?.[0]?.type, "image");

const snapshot = catchupIntent[0]!.snapshot!;
const historySnapshot = historySnapshotFromCustomUnread(snapshot);
assert.equal(historySnapshot?.[0]?.sender, "Luke (MEMBER_OPENID)");
assert.equal(historySnapshot?.[0]?.attachments?.[0]?.url, "https://example.com/a.png");

const synthetic = buildCustomUnreadCatchupMessage({
  accountId: "default",
  peer,
  snapshot,
  now: 12_000,
});
assert.equal(synthetic.messageId, "qqbot-digest-default-GROUP_OPENID-12000");
assert.equal(synthetic._customUnreadSnapshotId, snapshot.id);
assert.equal(getCustomUnreadSnapshotId(synthetic), snapshot.id);

const gatedCfg = resolveCustomUnreadConfig({
  runtime: { enabled: true, unread: { enabled: true } },
  scene: { scene: "chat" },
});
const gatedRuntime = new CustomUnreadRuntime();
gatedRuntime.recordNonMention({ message: inbound, cfg: gatedCfg, now: 1_000 });
const gatedEffects = effectsFromCustomUnreadIntents({
  accountId: "default",
  peer,
  intents: gatedRuntime.fireSleepDigest({ peerId: "GROUP_OPENID", cfg: gatedCfg, now: 11_000 }),
  now: 11_000,
});
assert.equal(gatedEffects.length, 1);
assert.equal(gatedEffects[0]!.kind, "policy-gated");
if (gatedEffects[0]!.kind !== "policy-gated") throw new Error("expected policy-gated effect");
assert.equal(gatedEffects[0].peerId, "GROUP_OPENID");
assert.equal(gatedEffects[0].source, "sleep-timer");

console.log("unread gateway adapter tests passed");
