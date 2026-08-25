import assert from "node:assert";
import {
  observeCustomUnreadMentionBeforeDispatch,
  recordCustomUnreadNonMentionBeforeDispatch,
  resolveCustomUnreadForQueuedGroupMessage,
} from "../src/custom/unread-ingress.js";
import { CustomUnreadRuntime } from "../src/custom/unread-runtime.js";
import type { QueuedMessage } from "../src/message-queue.js";

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

const disabledUnreadCfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "chat",
            unread: {
              enabled: false,
            },
          },
        },
      },
    },
  },
} as any;

assert.equal(resolveCustomUnreadForQueuedGroupMessage({
  cfg: disabledCfg,
  accountId: "default",
  event,
}), null);

assert.equal(resolveCustomUnreadForQueuedGroupMessage({
  cfg: disabledUnreadCfg,
  accountId: "default",
  event,
}), null);

const unread = new CustomUnreadRuntime();
const record = recordCustomUnreadNonMentionBeforeDispatch({
  cfg,
  accountId: "default",
  unread,
  event,
  content: "hello with attachment",
  mentionedBot: false,
});
assert.equal(record.handled, true);
assert.equal(record.recorded, true);
assert.equal(record.pendingCount, 1);
assert.equal(record.persist, true);
assert.equal(record.effects[0]?.kind, "set-timer");
assert.equal(unread.getState().peers.GROUP_OPENID?.history[0]?.body, "hello with attachment");
assert.equal(unread.getState().peers.GROUP_OPENID?.history[0]?.attachments?.[0]?.contentType, "image/png");

const mention = observeCustomUnreadMentionBeforeDispatch({
  cfg,
  accountId: "default",
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
});
assert.equal(mention.handled, true);
assert.equal(mention.pendingCount, 1);
assert.equal(mention.shouldCatchUpAfterReply, true);
assert.equal(mention.persist, true);
assert.equal(mention.history?.[0]?.body, "hello with attachment");
assert.equal(mention.history?.[0]?.sender, "Member (MEMBER_OPENID)");
assert.equal(mention.history?.[0]?.attachments?.[0]?.type, "image");
assert.equal(mention.effects[0]?.kind, "clear-timer");

const ignored = recordCustomUnreadNonMentionBeforeDispatch({
  cfg: disabledCfg,
  accountId: "default",
  unread,
  event,
  content: "ignored",
  mentionedBot: false,
});
assert.equal(ignored.handled, false);
assert.equal(ignored.persist, false);
assert.equal(ignored.effects.length, 0);

console.log("custom unread ingress tests passed");
