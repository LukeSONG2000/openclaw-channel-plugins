import assert from "node:assert";
import type {
  DeliverAccountContext,
  DeliverEventContext,
} from "../src/outbound-deliver.js";
import {
  applyCustomGuardedMediaAutoSend,
} from "../src/custom/guarded-media-send-gateway-adapter.js";

const account = {
  accountId: "default",
  appId: "APPID",
  clientSecret: "SECRET",
} as any;

const baseEvent: DeliverEventContext = {
  type: "group",
  senderId: "MEMBER_OPENID",
  messageId: "MSG_ID",
  groupOpenid: "GROUP_OPENID",
};

const anchored = await applyCustomGuardedMediaAutoSend({
  mediaUrl: "https://example.com/a.png",
  label: "Anchored media",
  event: { ...baseEvent, replyToId: "MSG_ID" },
  accountContext: {
    account,
    qualifiedTarget: "qqbot:group:GROUP_OPENID",
    proactiveGuard: () => {
      throw new Error("anchored passive replies should not call proactive guard");
    },
  },
  sendMedia: async (input) => {
    assert.equal(input.to, "qqbot:group:GROUP_OPENID");
    assert.equal(input.text, "");
    assert.equal(input.mediaUrl, "https://example.com/a.png");
    assert.equal(input.accountId, "default");
    assert.equal(input.replyToId, "MSG_ID");
    assert.equal(input.account, account);
    return { channel: "qqbot" };
  },
});
assert.deepEqual(anchored, { channel: "qqbot" });

let guardPayload: unknown;
let committed = false;
let sendCalled = false;
const allowedActx: DeliverAccountContext = {
  account,
  qualifiedTarget: "qqbot:group:GROUP_OPENID",
  proactiveGuard: (payload) => {
    guardPayload = payload;
    return {
      allowed: true,
      commit: () => {
        committed = true;
      },
    };
  },
};
const allowed = await applyCustomGuardedMediaAutoSend({
  mediaUrl: "https://example.com/b.png",
  label: "Tool media",
  event: baseEvent,
  accountContext: allowedActx,
  sendMedia: async (input) => {
    sendCalled = true;
    assert.equal(input.replyToId, undefined);
    assert.equal(input.mediaUrl, "https://example.com/b.png");
    return { channel: "qqbot" };
  },
});
assert.deepEqual(allowed, { channel: "qqbot" });
assert.equal(sendCalled, true);
assert.equal(committed, true);
assert.deepEqual(guardPayload, {
  targetType: "group",
  targetId: "GROUP_OPENID",
  kind: "media",
  mediaUrl: "https://example.com/b.png",
  text: "[media] https://example.com/b.png",
});

const errors: string[] = [];
const blocked = await applyCustomGuardedMediaAutoSend({
  mediaUrl: "https://example.com/c.png",
  label: "Tool fallback media",
  event: baseEvent,
  accountContext: {
    account,
    qualifiedTarget: "qqbot:group:GROUP_OPENID",
    log: {
      info: () => {},
      error: (msg) => errors.push(msg),
    },
    proactiveGuard: () => ({ allowed: false, reason: "budget exceeded" }),
  },
  sendMedia: async () => {
    throw new Error("blocked media should not be sent");
  },
});
assert.equal(blocked.channel, "qqbot");
assert.equal(blocked.error, "Tool fallback media blocked by custom proactive guard: budget exceeded");
assert.equal(errors[0]?.includes("[qqbot:default] Tool fallback media blocked"), true);

let failedCommit = false;
const failed = await applyCustomGuardedMediaAutoSend({
  mediaUrl: "https://example.com/d.png",
  label: "Failed media",
  event: baseEvent,
  accountContext: {
    account,
    qualifiedTarget: "qqbot:group:GROUP_OPENID",
    proactiveGuard: () => ({
      allowed: true,
      commit: () => {
        failedCommit = true;
      },
    }),
  },
  sendMedia: async () => ({ channel: "qqbot", error: "send failed" }),
});
assert.deepEqual(failed, { channel: "qqbot", error: "send failed" });
assert.equal(failedCommit, false);

console.log("custom guarded media send gateway adapter tests passed");
