import assert from "node:assert";
import { CustomAuthorizationRuntime } from "../src/custom/auth.js";
import {
  buildCustomAuthApprovalKeyboard,
  buildCustomAuthApprovalText,
  checkCustomDispatchAuthorization,
  checkCustomSlashAuthorization,
  firstCustomAuthApprovalRequest,
  formatCustomDispatchAuthorizationDeniedMessage,
  formatCustomAuthorizationDeniedMessage,
  handleCustomAuthCommand,
  handleCustomAuthInteraction,
  parseCustomAuthButtonData,
  parseCustomAuthCommand,
  resolveCustomDispatchCapability,
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
const authCfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        admins: ["ADMIN_OPENID"],
        adminGroup: "GROUP_OPENID",
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "chat",
            capabilities: ["chat.send"],
          },
        },
      },
    },
  },
} as any;

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
  cfg: authCfg,
  auth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 2_000,
});
assert.equal(denied.enabled, true);
assert.equal(denied.allowed, false);
assert.equal(denied.capability, "config.write");
assert.equal(denied.result?.decision.requestId, "authreq-2000-1");
assert.equal(denied.result?.intents[0]?.kind === "request-approval" && denied.result.intents[0].request.adminGroup, "qqbot:group:GROUP_OPENID");
assert.equal(formatCustomAuthorizationDeniedMessage(denied).includes("需要能力：config.write"), true);
assert.deepEqual(parseCustomAuthCommand("/bot-auth approve authreq-2000-1 count 3"), {
  matched: true,
  command: {
    kind: "resolve",
    requestId: "authreq-2000-1",
    approved: true,
    grantUse: "count",
    grantCount: 3,
    grantTtlMs: undefined,
  },
});
assert.deepEqual(parseCustomAuthCommand("/bot-auth allow-count authreq-2000-1 2"), {
  matched: true,
  command: {
    kind: "resolve",
    requestId: "authreq-2000-1",
    approved: true,
    grantUse: "count",
    grantCount: 2,
    grantTtlMs: undefined,
  },
});
assert.deepEqual(parseCustomAuthCommand("/bot-auth allow-timed authreq-2000-1 10m"), {
  matched: true,
  command: {
    kind: "resolve",
    requestId: "authreq-2000-1",
    approved: true,
    grantUse: "timed",
    grantCount: undefined,
    grantTtlMs: 600_000,
  },
});

const deniedAuthCommand = handleCustomAuthCommand({
  cfg: authCfg,
  auth,
  message: memberGroupMessage,
  rawContent: "/bot-auth approve authreq-2000-1 once",
  now: 2_500,
});
assert.equal(deniedAuthCommand.handled, true);
assert.equal(deniedAuthCommand.reply?.includes("只有 customRuntime.admins"), true);

const adminMessage: QueuedMessage = {
  ...memberGroupMessage,
  senderId: "ADMIN_OPENID",
  senderName: "Admin",
};
const status = handleCustomAuthCommand({
  cfg: authCfg,
  auth,
  message: adminMessage,
  rawContent: "/bot-auth status",
  now: 2_800,
});
assert.equal(status.handled, true);
assert.equal(status.reply?.includes("管理员：ADMIN_OPENID"), true);
assert.equal(status.reply?.includes("管理群：qqbot:group:GROUP_OPENID"), true);
assert.equal(status.reply?.includes("初始化：完整"), true);

const missingInitStatus = handleCustomAuthCommand({
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
  rawContent: "/bot-auth status",
  now: 2_900,
});
assert.equal(missingInitStatus.handled, true);
assert.equal(missingInitStatus.reply?.includes("管理群：未绑定"), true);
assert.equal(missingInitStatus.reply?.includes("初始化：缺少 adminGroup"), true);

const approved = handleCustomAuthCommand({
  cfg: authCfg,
  auth,
  message: adminMessage,
  rawContent: "/bot-auth approve authreq-2000-1 once",
  now: 3_000,
});
assert.equal(approved.handled, true);
assert.equal(approved.intent?.kind, "approval-resolved");
assert.equal(approved.reply?.includes("已批准临时授权"), true);

const allowedByGrant = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 4_000,
});
assert.equal(allowedByGrant.allowed, true);
assert.equal(allowedByGrant.result?.decision.source, "temporary-grant");

const secondUseAfterOnceGrant = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 5_000,
});
assert.equal(secondUseAfterOnceGrant.allowed, false);

const dispatchAuth = new CustomAuthorizationRuntime();
const dispatchDenied = checkCustomDispatchAuthorization({
  cfg: authCfg,
  auth: dispatchAuth,
  message: {
    ...memberGroupMessage,
    content: "/new",
  },
  rawContent: "/new",
  now: 5_500,
});
assert.equal(dispatchDenied.enabled, true);
assert.equal(dispatchDenied.allowed, false);
assert.equal(dispatchDenied.capability, "codex.run");
assert.equal(dispatchDenied.result?.decision.requestId, "authreq-5500-1");
assert.equal(formatCustomDispatchAuthorizationDeniedMessage(dispatchDenied).includes("需要能力：codex.run"), true);

const dispatchRequest = firstCustomAuthApprovalRequest(dispatchDenied.result?.intents ?? []);
if (!dispatchRequest) throw new Error("expected dispatch auth request");
const dispatchApproved = dispatchAuth.resolveApproval({
  requestId: dispatchRequest.id,
  approved: true,
  resolvedBy: "ADMIN_OPENID",
  grantUse: "once",
  now: 5_600,
});
assert.equal(dispatchApproved?.kind, "approval-resolved");
const dispatchAllowedByGrant = checkCustomDispatchAuthorization({
  cfg: authCfg,
  auth: dispatchAuth,
  message: {
    ...memberGroupMessage,
    content: "/new",
  },
  rawContent: "/new",
  now: 5_700,
});
assert.equal(dispatchAllowedByGrant.allowed, true);
assert.equal(dispatchAllowedByGrant.result?.decision.source, "temporary-grant");
const dispatchSecondUse = checkCustomDispatchAuthorization({
  cfg: authCfg,
  auth: dispatchAuth,
  message: {
    ...memberGroupMessage,
    content: "/new",
  },
  rawContent: "/new",
  now: 5_800,
});
assert.equal(dispatchSecondUse.allowed, false);

const codexOnlyCfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "codex-only",
          },
        },
      },
    },
  },
} as any;
assert.equal(resolveCustomDispatchCapability({
  cfg: codexOnlyCfg,
  message: {
    ...memberGroupMessage,
    content: "帮我看一下这个 repo",
  },
  rawContent: "帮我看一下这个 repo",
}), "codex.run");
assert.equal(resolveCustomDispatchCapability({
  cfg: authCfg,
  message: {
    ...memberGroupMessage,
    content: "闲聊一下",
  },
  rawContent: "闲聊一下",
}), "chat.send");

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

const cardAuth = new CustomAuthorizationRuntime();
const cardDenied = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth: cardAuth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 10_000,
});
const cardRequest = firstCustomAuthApprovalRequest(cardDenied.result?.intents ?? []);
assert.equal(cardRequest?.id, "authreq-10000-1");
if (!cardRequest) throw new Error("expected custom auth request");
assert.equal(buildCustomAuthApprovalText(cardRequest).includes("自定义权限申请"), true);
const keyboard = buildCustomAuthApprovalKeyboard(cardRequest.id);
assert.equal(keyboard.content?.rows[0]?.buttons[0]?.action?.data, "custom-auth:authreq-10000-1:allow-once");
assert.deepEqual(parseCustomAuthButtonData("custom-auth:authreq-10000-1:allow-count"), {
  requestId: "authreq-10000-1",
  decision: "allow-count",
});
assert.equal(parseCustomAuthButtonData("approve:abc:allow-once"), null);

const nonAdminButton = handleCustomAuthInteraction({
  cfg: authCfg,
  auth: cardAuth,
  buttonData: "custom-auth:authreq-10000-1:allow-once",
  actorId: "MEMBER_OPENID",
  now: 11_000,
});
assert.equal(nonAdminButton.handled, true);
assert.equal(nonAdminButton.reply?.includes("只有 customRuntime.admins"), true);

const adminButton = handleCustomAuthInteraction({
  cfg: authCfg,
  auth: cardAuth,
  buttonData: "custom-auth:authreq-10000-1:allow-count",
  actorId: "ADMIN_OPENID",
  now: 12_000,
});
assert.equal(adminButton.handled, true);
assert.equal(adminButton.intent?.kind, "approval-resolved");
assert.equal(adminButton.reply?.includes("已批准临时授权"), true);

const cardGrantUseOne = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth: cardAuth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 13_000,
});
assert.equal(cardGrantUseOne.allowed, true);
const cardGrantUseTwo = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth: cardAuth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 14_000,
});
assert.equal(cardGrantUseTwo.allowed, true);
const cardGrantUseThree = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth: cardAuth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 15_000,
});
assert.equal(cardGrantUseThree.allowed, true);
const cardGrantUseFour = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth: cardAuth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 16_000,
});
assert.equal(cardGrantUseFour.allowed, false);

console.log("custom auth gateway adapter tests passed");
