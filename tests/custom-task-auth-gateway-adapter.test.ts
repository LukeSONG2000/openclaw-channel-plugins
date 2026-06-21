import assert from "node:assert";
import { CustomAuthorizationRuntime } from "../src/custom/auth.js";
import { checkCustomTaskCommandAuthorization } from "../src/custom/task-auth-gateway-adapter.js";
import { CustomTaskSandboxRuntime } from "../src/custom/task-sandbox.js";
import type { QueuedMessage } from "../src/message-queue.js";

const ownerMessage: QueuedMessage = {
  type: "group",
  senderId: "OWNER_OPENID",
  senderName: "Owner",
  content: "/bot-task create Build task auth",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

const memberMessage: QueuedMessage = {
  ...ownerMessage,
  senderId: "MEMBER_OPENID",
  senderName: "Member",
};

const adminMessage: QueuedMessage = {
  ...ownerMessage,
  senderId: "ADMIN_OPENID",
  senderName: "Admin",
};

const cfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        admins: ["ADMIN_OPENID"],
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "dev-lab",
            capabilities: ["chat.send", "codex.longTask", "system.status"],
          },
        },
      },
    },
  },
} as any;

const tasks = new CustomTaskSandboxRuntime({ workspaceRoot: "/tmp/openclaw-qqbot-task-auth" });
const created = tasks.createTask({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "OWNER_OPENID", label: "Owner" },
  prompt: "Build task auth",
  now: 1_000,
});
const taskId = created.task!.id;
const auth = new CustomAuthorizationRuntime();

assert.deepEqual(checkCustomTaskCommandAuthorization({
  cfg,
  auth,
  tasks,
  message: memberMessage,
  rawContent: "/bot-task list",
  now: 1_500,
}), {
  handled: false,
  allowed: true,
  reason: "not_task_mutation",
});

const ownerAllowed = checkCustomTaskCommandAuthorization({
  cfg,
  auth,
  tasks,
  message: ownerMessage,
  rawContent: `/bot-task add ${taskId} extra owner requirement`,
  now: 2_000,
});
assert.equal(ownerAllowed.handled, true);
assert.equal(ownerAllowed.allowed, true);
assert.equal(ownerAllowed.reason, "owner");

const adminAllowed = checkCustomTaskCommandAuthorization({
  cfg,
  auth,
  tasks,
  message: adminMessage,
  rawContent: `/bot-task cancel ${taskId}`,
  now: 2_500,
});
assert.equal(adminAllowed.handled, true);
assert.equal(adminAllowed.allowed, true);
assert.equal(adminAllowed.reason, "authorized");
assert.equal(adminAllowed.result?.decision.source, "admin");

const memberDenied = checkCustomTaskCommandAuthorization({
  cfg,
  auth,
  tasks,
  message: memberMessage,
  rawContent: `/bot-task add ${taskId} extra member requirement`,
  now: 3_000,
});
assert.equal(memberDenied.handled, true);
assert.equal(memberDenied.allowed, false);
assert.equal(memberDenied.reason, "denied");
assert.equal(memberDenied.result?.decision.requestId, "authreq-3000-1");
assert.equal(memberDenied.result?.intents[0]?.kind, "request-approval");
assert.equal(memberDenied.result?.intents[0]?.kind === "request-approval" && memberDenied.result.intents[0].request.taskId, taskId);

const request = memberDenied.result?.intents[0];
if (!request || request.kind !== "request-approval") throw new Error("expected task auth request");
const approved = auth.resolveApproval({
  requestId: request.request.id,
  approved: true,
  resolvedBy: "ADMIN_OPENID",
  grantUse: "task",
  now: 3_500,
});
assert.equal(approved?.kind, "approval-resolved");
assert.equal(approved?.kind === "approval-resolved" && approved.grant?.taskId, taskId);

const memberAllowedByTaskGrant = checkCustomTaskCommandAuthorization({
  cfg,
  auth,
  tasks,
  message: memberMessage,
  rawContent: `/bot-task add ${taskId} after approval`,
  now: 4_000,
});
assert.equal(memberAllowedByTaskGrant.allowed, true);
assert.equal(memberAllowedByTaskGrant.result?.decision.source, "temporary-grant");
assert.equal(memberAllowedByTaskGrant.result?.decision.grantId, approved?.kind === "approval-resolved" ? approved.grant?.id : undefined);

const otherTask = tasks.createTask({
  accountId: "default",
  peer: { kind: "group", id: "GROUP_OPENID" },
  actor: { id: "OWNER_OPENID", label: "Owner" },
  prompt: "Other task",
  now: 4_500,
});
const memberDeniedOtherTask = checkCustomTaskCommandAuthorization({
  cfg,
  auth,
  tasks,
  message: memberMessage,
  rawContent: `/bot-task add ${otherTask.task!.id} should not reuse task grant`,
  now: 5_000,
});
assert.equal(memberDeniedOtherTask.allowed, false);
assert.equal(memberDeniedOtherTask.result?.decision.requestId, "authreq-5000-2");

console.log("custom task auth gateway adapter tests passed");
