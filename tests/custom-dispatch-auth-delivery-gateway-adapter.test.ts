import assert from "node:assert";
import { applyCustomDispatchAuthDenialDelivery } from "../src/custom/dispatch-auth-delivery-gateway-adapter.js";
import type { CustomDispatchAuthorizationDecision } from "../src/custom/auth-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";
import type { CustomAuthorizationApprovalRequest } from "../src/custom/types.js";

const request: CustomAuthorizationApprovalRequest = {
  id: "authreq-1",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "MEMBER_OPENID", label: "Member" },
  capability: "config.write",
  scene: "chat",
  sceneLabel: "Chat",
  reason: "missing_capability",
  requestedAt: 1_000,
  expiresAt: Date.now() + 60_000,
  admins: ["ADMIN_OPENID"],
  adminGroup: "qqbot:group:ADMIN_GROUP",
  status: "pending",
};

const groupMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "change config",
  messageId: "MSG_GROUP",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

const deniedDecision: CustomDispatchAuthorizationDecision = {
  enabled: true,
  allowed: false,
  capability: "config.write",
  peer: request.peer,
  actor: request.actor,
  reason: "denied",
  result: {
    decision: {
      allowed: false,
      reason: "missing_capability",
      capability: "config.write",
      actorId: "MEMBER_OPENID",
      peerId: "GROUP_OPENID",
      requestId: "authreq-1",
    },
    intents: [{ kind: "request-approval", request, deduped: false }],
  },
};

const cards: Array<{ target: unknown; text: string }> = [];
const texts: string[] = [];
const cardResult = await applyCustomDispatchAuthDenialDelivery({
  decision: deniedDecision,
  message: groupMessage,
  sendText: async (text) => { texts.push(text); },
  sendApprovalCard: async (target, text) => { cards.push({ target, text }); },
});

assert.equal(cardResult.handled, true);
assert.equal(cardResult.delivery, "approval-card");
assert.equal(cardResult.requestId, "authreq-1");
assert.deepEqual(cards[0]?.target, { kind: "group", groupOpenid: "GROUP_OPENID", messageId: "MSG_GROUP" });
assert.equal(cards[0]?.text.startsWith("<@ADMIN_OPENID>\n"), true);
assert.equal(cards[0]?.text.includes("用户：<@MEMBER_OPENID> Member（member_openid：MEMBER_OPENID）"), true);
assert.equal(cards[0]?.text.includes("自定义权限申请"), true);
assert.equal(texts.length, 0);
assert.equal(cardResult.adminGroupNotification?.groupOpenid, "ADMIN_GROUP");
assert.equal(cardResult.adminGroupNotification?.text.startsWith("<@ADMIN_OPENID>\n"), true);
assert.equal(cardResult.adminGroupNotification?.text.includes("用户：<@MEMBER_OPENID> Member（member_openid：MEMBER_OPENID）"), true);

const fallbackTexts: string[] = [];
const errors: string[] = [];
const fallbackResult = await applyCustomDispatchAuthDenialDelivery({
  decision: deniedDecision,
  message: { ...groupMessage, type: "c2c", groupOpenid: undefined },
  sendText: async (text) => { fallbackTexts.push(text); },
  sendApprovalCard: async () => { throw new Error("card unavailable"); },
  log: { error: (msg) => errors.push(msg) },
});

assert.equal(fallbackResult.handled, true);
assert.equal(fallbackResult.delivery, "text");
assert.equal(fallbackResult.adminGroupNotification?.requestId, "authreq-1");
assert.equal(fallbackResult.adminGroupNotification?.text.startsWith("<@ADMIN_OPENID>\n"), true);
assert.equal(fallbackTexts[0]?.includes("需要能力：config.write"), true);
assert.equal(fallbackTexts[0]?.startsWith("<@MEMBER_OPENID>\n"), true);
assert.equal(errors[0]?.includes("falling back to text"), true);

const noCopyResult = await applyCustomDispatchAuthDenialDelivery({
  cfg: { channels: { qqbot: { customRuntime: { auth: { copyRequestsToAdminGroup: false } } } } } as any,
  decision: deniedDecision,
  message: groupMessage,
  sendText: async () => {},
  sendApprovalCard: async () => {},
});
assert.equal(noCopyResult.adminGroupNotification, null);

const noRequestTexts: string[] = [];
const noRequest = await applyCustomDispatchAuthDenialDelivery({
  decision: {
    enabled: true,
    allowed: false,
    capability: "chat.send",
    peer: { kind: "c2c", id: "USER_OPENID" },
    actor: { id: "USER_OPENID" },
    reason: "denied",
    result: {
      decision: {
        allowed: false,
        reason: "unauthorized",
        capability: "chat.send",
        actorId: "USER_OPENID",
        peerId: "USER_OPENID",
      },
      intents: [],
    },
  },
  message: { ...groupMessage, type: "dm", groupOpenid: undefined, senderId: "USER_OPENID" },
  sendText: async (text) => { noRequestTexts.push(text); },
});

assert.equal(noRequest.handled, true);
assert.equal(noRequest.delivery, "text");
assert.equal(noRequest.adminGroupNotification, null);
assert.equal(noRequestTexts[0]?.includes("需要能力：chat.send"), true);

assert.deepEqual(await applyCustomDispatchAuthDenialDelivery({
  decision: { enabled: false, allowed: true, reason: "runtime_disabled" },
  message: groupMessage,
  sendText: async () => {},
} as any), { handled: false });

console.log("custom dispatch auth delivery gateway adapter tests passed");
