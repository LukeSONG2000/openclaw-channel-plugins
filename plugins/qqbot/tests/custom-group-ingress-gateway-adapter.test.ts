import assert from "node:assert";
import {
  applyCustomGroupMentionIngress,
  applyCustomGroupSkippedMessageIngress,
} from "../src/custom/group-ingress-gateway-adapter.js";
import { CustomUnreadRuntime } from "../src/custom/unread-runtime.js";
import type { HistoryEntry } from "../src/group-history.js";
import type { QueuedMessage } from "../src/message-queue.js";

const cfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        unread: {
          enabled: true,
          followupDelayMs: 1_000,
          sleepDelayMs: 10_000,
        },
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "chat",
            allowAutonomousReply: true,
            allowProactiveSend: true,
          },
        },
      },
    },
  },
} as any;

const disabledCfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: false,
      },
    },
  },
} as any;

const event: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "hello",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
  attachments: [{ content_type: "image/png", url: "https://example.com/a.png", filename: "a.png" }],
};

{
  const unread = new CustomUnreadRuntime();
  const logs: string[] = [];
  let persistCount = 0;
  let scheduledEffects = 0;
  const result = applyCustomGroupSkippedMessageIngress({
    accountId: "default",
    cfg,
    unread,
    event,
    content: "hello",
    mentionedBot: false,
    groupHistories: new Map(),
    historyLimit: 10,
    reason: "drop_other_mention",
    applySchedulerEffects: (effects) => { scheduledEffects += effects.length; },
    persistCustomUnreadState: () => { persistCount += 1; },
    log: { info: (msg) => logs.push(msg) },
  });

  assert.equal(result.kind, "custom-unread");
  assert.equal(result.kind === "custom-unread" && result.pendingCount, 1);
  assert.equal(scheduledEffects, 1);
  assert.equal(persistCount, 1);
  assert.equal(logs.some((line) => line.includes("drop other mention, recorded by custom unread runtime")), true);
}

{
  const groupHistories = new Map<string, HistoryEntry[]>();
  const logs: string[] = [];
  let persistCount = 0;
  let scheduledEffects = 0;
  const result = applyCustomGroupSkippedMessageIngress({
    accountId: "default",
    cfg: disabledCfg,
    unread: new CustomUnreadRuntime(),
    event,
    content: "hello with attachment",
    mentionedBot: false,
    groupHistories,
    historyLimit: 10,
    reason: "skip_no_mention",
    activation: "mention",
    configRequireMention: true,
    applySchedulerEffects: (effects) => { scheduledEffects += effects.length; },
    persistCustomUnreadState: () => { persistCount += 1; },
    log: { info: (msg) => logs.push(msg) },
  });

  assert.equal(result.kind, "legacy-history");
  assert.equal(result.kind === "legacy-history" && result.pendingCount, 1);
  assert.equal(result.kind === "legacy-history" && result.attachmentCount, 1);
  assert.equal(groupHistories.get("GROUP_OPENID")?.[0]?.body, "hello with attachment");
  assert.equal(groupHistories.get("GROUP_OPENID")?.[0]?.attachments?.[0]?.type, "image");
  assert.equal(scheduledEffects, 0);
  assert.equal(persistCount, 0);
  assert.equal(logs.some((line) => line.includes("activation=mention (configRequireMention=true) not mentioned, recorded to history")), true);
}

{
  const unread = new CustomUnreadRuntime();
  let persistCount = 0;
  let scheduledEffects = 0;
  const logs: string[] = [];
  applyCustomGroupSkippedMessageIngress({
    accountId: "default",
    cfg,
    unread,
    event,
    content: "previous message",
    mentionedBot: false,
    groupHistories: new Map(),
    historyLimit: 10,
    reason: "skip_no_mention",
  });

  const result = applyCustomGroupMentionIngress({
    accountId: "default",
    cfg,
    unread,
    event: {
      ...event,
      content: "@bot what did I miss?",
      messageId: "mention-1",
      eventType: "GROUP_AT_MESSAGE_CREATE",
      mentions: [{ is_you: true }],
    },
    content: "what did I miss?",
    mentionedBot: true,
    applySchedulerEffects: (effects) => { scheduledEffects += effects.length; },
    persistCustomUnreadState: () => { persistCount += 1; },
    log: { info: (msg) => logs.push(msg) },
  });

  assert.equal(result.handled, true);
  assert.equal(result.shouldCatchUpAfterReply, true);
  assert.equal(result.history?.[0]?.body, "previous message");
  assert.equal(scheduledEffects, 1);
  assert.equal(persistCount, 1);
  assert.equal(logs.some((line) => line.includes("mention with 1 custom unread message(s); will catch up after reply")), true);
}

{
  let persistCount = 0;
  let scheduledEffects = 0;
  const logs: string[] = [];
  const result = applyCustomGroupMentionIngress({
    accountId: "default",
    cfg: disabledCfg,
    unread: new CustomUnreadRuntime(),
    event,
    content: "hello",
    mentionedBot: true,
    applySchedulerEffects: (effects) => { scheduledEffects += effects.length; },
    persistCustomUnreadState: () => { persistCount += 1; },
    log: { info: (msg) => logs.push(msg) },
  });

  assert.equal(result.handled, false);
  assert.equal(result.persist, false);
  assert.equal(scheduledEffects, 0);
  assert.equal(persistCount, 0);
  assert.deepEqual(logs, []);
}

console.log("custom group ingress gateway adapter tests passed");
