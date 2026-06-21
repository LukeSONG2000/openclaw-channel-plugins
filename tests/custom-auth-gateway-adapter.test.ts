import assert from "node:assert";
import { CustomAuthorizationRuntime } from "../src/custom/auth.js";
import { checkCustomTaskCommandAuthorization } from "../src/custom/task-auth-gateway-adapter.js";
import { CustomTaskSandboxRuntime } from "../src/custom/task-sandbox.js";
import {
  buildCustomAuthApprovalKeyboard,
  buildCustomAuthAdminGroupNotification,
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
assert.deepEqual(parseCustomAuthCommand("/bot-auth requests"), {
  matched: true,
  command: { kind: "requests", limit: 10 },
});
assert.deepEqual(parseCustomAuthCommand("/bot-auth requests 2"), {
  matched: true,
  command: { kind: "requests", limit: 2 },
});
assert.deepEqual(parseCustomAuthCommand("/bot-auth grants"), {
  matched: true,
  command: { kind: "grants", limit: 10 },
});
const invalidRequestLimit = parseCustomAuthCommand("/bot-auth requests 0");
assert.equal(invalidRequestLimit.matched, true);
assert.equal("error" in invalidRequestLimit && invalidRequestLimit.error?.includes("数量需要是 1 到 20"), true);

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
assert.equal(status.reply?.includes("查看详情：/bot-auth requests 或 /bot-auth grants"), true);

const pendingRequests = handleCustomAuthCommand({
  cfg: authCfg,
  auth,
  message: adminMessage,
  rawContent: "/bot-auth requests",
  now: 2_900,
});
assert.equal(pendingRequests.handled, true);
assert.equal(pendingRequests.reply?.includes("待审批授权申请"), true);
assert.equal(pendingRequests.reply?.includes("authreq-2000-1"), true);
assert.equal(pendingRequests.reply?.includes("能力：config.write"), true);
assert.equal(pendingRequests.reply?.includes("用户：Member"), true);
assert.equal(pendingRequests.reply?.includes("会话：group:GROUP_OPENID"), true);
assert.equal(pendingRequests.reply?.includes("/bot-auth approve authreq-2000-1 once"), true);
assert.equal(pendingRequests.reply?.includes(memberGroupMessage.content), false);

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

const activeGrants = handleCustomAuthCommand({
  cfg: authCfg,
  auth,
  message: adminMessage,
  rawContent: "/bot-auth grants",
  now: 3_100,
});
assert.equal(activeGrants.handled, true);
assert.equal(activeGrants.reply?.includes("临时授权列表"), true);
assert.equal(activeGrants.reply?.includes("grant-3000-1"), true);
assert.equal(activeGrants.reply?.includes("用户：MEMBER_OPENID"), true);
assert.equal(activeGrants.reply?.includes("会话：GROUP_OPENID"), true);
assert.equal(activeGrants.reply?.includes("能力：config.write"), true);
assert.equal(activeGrants.reply?.includes("剩余：1 次"), true);

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

const emptyAuth = new CustomAuthorizationRuntime();
const emptyRequests = handleCustomAuthCommand({
  cfg: authCfg,
  auth: emptyAuth,
  message: adminMessage,
  rawContent: "/bot-auth requests",
  now: 5_100,
});
assert.equal(emptyRequests.reply?.includes("暂无待审批授权申请。"), true);
const emptyGrants = handleCustomAuthCommand({
  cfg: authCfg,
  auth: emptyAuth,
  message: adminMessage,
  rawContent: "/bot-auth grants",
  now: 5_100,
});
assert.equal(emptyGrants.reply?.includes("暂无有效临时授权。"), true);

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
assert.equal(keyboard.content?.rows[0]?.buttons[2]?.action?.data, "custom-auth:authreq-10000-1:allow-timed");
assert.equal(keyboard.content?.rows[1]?.buttons[0]?.action?.data, "custom-auth:authreq-10000-1:deny");
const adminGroupNotification = buildCustomAuthAdminGroupNotification({
  request: cardRequest,
  sourcePeer: { kind: "c2c", id: "MEMBER_OPENID" },
  text: buildCustomAuthApprovalText(cardRequest),
  keyboard,
});
assert.equal(adminGroupNotification?.groupOpenid, "GROUP_OPENID");
assert.equal(adminGroupNotification?.requestId, "authreq-10000-1");
assert.equal(adminGroupNotification?.keyboard, keyboard);
assert.equal(buildCustomAuthAdminGroupNotification({
  request: cardRequest,
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  text: buildCustomAuthApprovalText(cardRequest),
  keyboard,
}), null);
assert.equal(buildCustomAuthAdminGroupNotification({
  request: { ...cardRequest, adminGroup: undefined },
  sourcePeer: { kind: "c2c", id: "MEMBER_OPENID" },
  text: "approval",
}), null);
assert.deepEqual(parseCustomAuthButtonData("custom-auth:authreq-10000-1:allow-count"), {
  requestId: "authreq-10000-1",
  decision: "allow-count",
});
assert.deepEqual(parseCustomAuthButtonData("custom-auth:authreq-10000-1:allow-timed"), {
  requestId: "authreq-10000-1",
  decision: "allow-timed",
});
assert.deepEqual(parseCustomAuthButtonData("custom-auth:authreq-10000-1:allow-task"), {
  requestId: "authreq-10000-1",
  decision: "allow-task",
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

const timedCardAuth = new CustomAuthorizationRuntime();
const timedDenied = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth: timedCardAuth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 20_000,
});
const timedRequest = firstCustomAuthApprovalRequest(timedDenied.result?.intents ?? []);
if (!timedRequest) throw new Error("expected timed custom auth request");
const timedButton = handleCustomAuthInteraction({
  cfg: authCfg,
  auth: timedCardAuth,
  buttonData: `custom-auth:${timedRequest.id}:allow-timed`,
  actorId: "ADMIN_OPENID",
  now: 21_000,
});
assert.equal(timedButton.handled, true);
assert.equal(timedButton.intent?.kind, "approval-resolved");
assert.equal(timedButton.intent?.kind === "approval-resolved" && timedButton.intent.grant?.expiresAt, 621_000);
const timedGrantUse = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth: timedCardAuth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 620_000,
});
assert.equal(timedGrantUse.allowed, true);
const timedGrantExpired = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth: timedCardAuth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 622_000,
});
assert.equal(timedGrantExpired.allowed, false);

const normalTaskAuth = new CustomAuthorizationRuntime();
const normalTaskDenied = checkCustomSlashAuthorization({
  cfg: authCfg,
  auth: normalTaskAuth,
  message: memberGroupMessage,
  rawContent: "/bot-streaming on",
  now: 28_000,
});
const normalTaskRequest = firstCustomAuthApprovalRequest(normalTaskDenied.result?.intents ?? []);
if (!normalTaskRequest) throw new Error("expected normal custom auth request");
const normalTaskDecision = handleCustomAuthInteraction({
  cfg: authCfg,
  auth: normalTaskAuth,
  buttonData: `custom-auth:${normalTaskRequest.id}:allow-task`,
  actorId: "ADMIN_OPENID",
  now: 29_000,
});
assert.equal(normalTaskDecision.handled, true);
assert.equal(normalTaskDecision.reply?.includes("不是任务级申请"), true);

const taskAuth = new CustomAuthorizationRuntime();
const taskRuntime = new CustomTaskSandboxRuntime({ workspaceRoot: "/tmp/openclaw-qqbot-auth-card-task" });
const task = taskRuntime.createTask({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "OWNER_OPENID", label: "Owner" },
  prompt: "Build task auth card",
  now: 30_000,
}).task!;
const taskDenied = checkCustomTaskCommandAuthorization({
  cfg: authCfg,
  accountId: "default",
  auth: taskAuth,
  tasks: taskRuntime,
  message: memberGroupMessage,
  rawContent: `/bot-task add ${task.id} extra requirement`,
  now: 30_500,
});
assert.equal(taskDenied.allowed, false);
const taskRequest = firstCustomAuthApprovalRequest(taskDenied.result?.intents ?? []);
if (!taskRequest) throw new Error("expected task custom auth request");
const taskKeyboard = buildCustomAuthApprovalKeyboard(taskRequest);
assert.equal(taskKeyboard.content?.rows[0]?.buttons[0]?.render_data?.label, "允许此任务");
assert.equal(taskKeyboard.content?.rows[0]?.buttons[0]?.action?.data, `custom-auth:${taskRequest.id}:allow-task`);
const taskButton = handleCustomAuthInteraction({
  cfg: authCfg,
  auth: taskAuth,
  buttonData: `custom-auth:${taskRequest.id}:allow-task`,
  actorId: "ADMIN_OPENID",
  now: 31_000,
});
assert.equal(taskButton.handled, true);
assert.equal(taskButton.intent?.kind, "approval-resolved");
assert.equal(taskButton.intent?.kind === "approval-resolved" && taskButton.intent.grant?.taskId, task.id);
assert.equal(taskButton.intent?.kind === "approval-resolved" && taskButton.intent.grant?.remainingUses, undefined);

console.log("custom auth gateway adapter tests passed");
