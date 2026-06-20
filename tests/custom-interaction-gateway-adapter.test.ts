import assert from "node:assert";
import { createCustomMessageFlowRuntime } from "../src/custom/runtime.js";
import { handleCustomSlashGatewayCommand } from "../src/custom/slash-gateway-adapter.js";
import { handleCustomInteractionGatewayButton } from "../src/custom/interaction-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const cfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        admins: ["ADMIN_OPENID"],
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "chat",
            capabilities: ["chat.send", "system.status", "game.interact"],
          },
        },
      },
    },
  },
} as any;

const message: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/bot-streaming on",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

const authRuntime = createCustomMessageFlowRuntime();
const denied = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: authRuntime,
  message,
  rawContent: "/bot-streaming on",
  now: 1_000,
  applyTaskWorkspaceEffects: false,
});
assert.equal(denied.handled, true);
assert.equal(denied.reply?.kind, "auth-approval");

const nonAdminAuth = handleCustomInteractionGatewayButton({
  cfg,
  runtime: authRuntime,
  buttonData: "custom-auth:authreq-1000-1:allow-once",
  actor: { id: "MEMBER_OPENID", label: "Member" },
  now: 2_000,
});
assert.equal(nonAdminAuth.handled, true);
assert.equal(nonAdminAuth.persist, undefined);
assert.equal(nonAdminAuth.reply?.includes("只有 customRuntime.admins"), true);

const adminAuth = handleCustomInteractionGatewayButton({
  cfg,
  runtime: authRuntime,
  buttonData: "custom-auth:authreq-1000-1:allow-count",
  actor: { id: "ADMIN_OPENID", label: "Admin" },
  now: 3_000,
});
assert.equal(adminAuth.handled, true);
assert.equal(adminAuth.persist?.auth, true);
assert.equal(adminAuth.reply?.includes("已批准临时授权"), true);
assert.equal(adminAuth.logs?.some((item) => item.message.includes("approval-resolved")), true);

const pollRuntime = createCustomMessageFlowRuntime();
const poll = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: pollRuntime,
  message: { ...message, content: "/bot-poll create Pick one | A | B" },
  rawContent: "/bot-poll create Pick one | A | B",
  now: 4_000,
  applyTaskWorkspaceEffects: false,
});
assert.equal(poll.handled, true);
const pollId = Object.keys(pollRuntime.polls.getState().polls)[0]!;
assert.equal(pollId, "poll-default-group-GROUP_OPENID-4000-1");

const vote = handleCustomInteractionGatewayButton({
  cfg,
  runtime: pollRuntime,
  buttonData: `custom-poll:${pollId}:vote:2`,
  actor: { id: "VOTER_OPENID", label: "Voter" },
  now: 5_000,
});
assert.equal(vote.handled, true);
assert.equal(vote.persist?.polls, true);
assert.equal(vote.reply?.includes("已记录投票：B"), true);

const unknown = handleCustomInteractionGatewayButton({
  cfg,
  runtime: pollRuntime,
  buttonData: "approve:legacy:allow-once",
  actor: { id: "VOTER_OPENID" },
  now: 6_000,
});
assert.deepEqual(unknown, { handled: false });

console.log("custom interaction gateway adapter tests passed");
