import assert from "node:assert";
import { CustomAuthorizationRuntime } from "../src/custom/auth.js";
import {
  checkCustomSlashAuthorization,
  formatCustomAuthorizationDeniedMessage,
  toCustomActorFromQueuedMessage,
  toCustomPeerFromQueuedMessage,
} from "../src/custom/auth-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const memberGroupMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/bot-streaming on",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

assert.deepEqual(toCustomPeerFromQueuedMessage(memberGroupMessage), {
  kind: "group",
  id: "GROUP_OPENID",
});
assert.deepEqual(toCustomActorFromQueuedMessage(memberGroupMessage), {
  id: "MEMBER_OPENID",
  label: "Member",
  isBot: undefined,
});

const auth = new CustomAuthorizationRuntime();
const disabled = checkCustomSlashAuthorization({
  cfg: { channels: { qqbot: {} } } as any,
  auth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 1_000,
});
assert.equal(disabled.enabled, false);
assert.equal(disabled.allowed, true);

const denied = checkCustomSlashAuthorization({
  cfg: {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: true,
          admins: ["ADMIN_OPENID"],
          scenes: {
            "qqbot:group:GROUP_OPENID": {
              scene: "chat",
              capabilities: ["chat.send"],
            },
          },
        },
      },
    },
  } as any,
  auth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 2_000,
});
assert.equal(denied.enabled, true);
assert.equal(denied.allowed, false);
assert.equal(denied.capability, "config.write");
assert.equal(denied.result?.decision.requestId, "authreq-2000-1");
assert.equal(formatCustomAuthorizationDeniedMessage(denied).includes("需要能力：config.write"), true);

const allowedByGrant = checkCustomSlashAuthorization({
  cfg: {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: true,
          admins: ["ADMIN_OPENID"],
          scenes: {
            "qqbot:group:GROUP_OPENID": {
              scene: "chat",
              capabilities: ["chat.send"],
            },
          },
        },
      },
    },
  } as any,
  auth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 3_000,
});
assert.equal(allowedByGrant.allowed, false);

const adminMessage: QueuedMessage = {
  ...memberGroupMessage,
  senderId: "ADMIN_OPENID",
  senderName: "Admin",
};
const allowedAdmin = checkCustomSlashAuthorization({
  cfg: {
    channels: {
      qqbot: {
        customRuntime: {
          enabled: true,
          admins: ["ADMIN_OPENID"],
        },
      },
    },
  } as any,
  auth,
  message: adminMessage,
  rawContent: "/bot-upgrade --latest",
  now: 4_000,
});
assert.equal(allowedAdmin.allowed, true);
assert.equal(allowedAdmin.capability, "deploy.apply");
assert.equal(allowedAdmin.result?.decision.source, "admin");

console.log("custom auth gateway adapter tests passed");
