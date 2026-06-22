import assert from "node:assert";
import { createCustomMessageFlowRuntime } from "../src/custom/runtime.js";
import { handleCustomSlashGatewayCommand } from "../src/custom/slash-gateway-adapter.js";
import {
  handleCustomInteractionGatewayButton,
  resolveCustomInteractionSourcePeer,
} from "../src/custom/interaction-gateway-adapter.js";
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
            capabilities: ["chat.send", "system.status", "game.interact", "codex.longTask", "deploy.check", "deploy.apply"],
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

const timedRuntime = createCustomMessageFlowRuntime();
const timedDenied = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: timedRuntime,
  message,
  rawContent: "/bot-streaming on",
  now: 3_500,
  applyTaskWorkspaceEffects: false,
});
assert.equal(timedDenied.handled, true);
const timedAuth = handleCustomInteractionGatewayButton({
  cfg,
  runtime: timedRuntime,
  buttonData: "custom-auth:authreq-3500-1:allow-timed",
  actor: { id: "ADMIN_OPENID", label: "Admin" },
  now: 3_600,
});
assert.equal(timedAuth.handled, true);
assert.equal(timedAuth.persist?.auth, true);
assert.equal(timedAuth.reply?.includes("已批准临时授权"), true);

const taskRuntime = createCustomMessageFlowRuntime();
const taskCreate = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: taskRuntime,
  message: { ...message, senderId: "ADMIN_OPENID", senderName: "Admin", content: "/bot-task create Long job" },
  rawContent: "/bot-task create Long job",
  now: 3_700,
  applyTaskWorkspaceEffects: false,
});
assert.equal(taskCreate.handled, true);
const taskId = Object.keys(taskRuntime.tasks.getState().tasks)[0]!;
const taskDenied = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: taskRuntime,
  message: { ...message, content: `/bot-task add ${taskId} extra detail` },
  rawContent: `/bot-task add ${taskId} extra detail`,
  now: 3_800,
  applyTaskWorkspaceEffects: false,
});
assert.equal(taskDenied.handled, true);
assert.equal(taskDenied.reply?.kind, "auth-approval");
const taskAuth = handleCustomInteractionGatewayButton({
  cfg,
  runtime: taskRuntime,
  buttonData: "custom-auth:authreq-3800-1:allow-task",
  actor: { id: "ADMIN_OPENID", label: "Admin" },
  now: 3_900,
});
assert.equal(taskAuth.handled, true);
assert.equal(taskAuth.persist?.auth, true);
assert.equal(Object.values(taskRuntime.auth.getState().grants).some((grant) => grant.taskId === taskId), true);

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
  accountId: "default",
  runtime: pollRuntime,
  buttonData: `custom-poll:${pollId}:vote:2`,
  actor: { id: "VOTER_OPENID", label: "Voter" },
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 5_000,
});
assert.equal(vote.handled, true);
assert.equal(vote.persist?.polls, true);
assert.equal(vote.reply?.includes("Voter 已投票"), true);
assert.equal(vote.reply?.includes("B"), false);

const crossPeerVote = handleCustomInteractionGatewayButton({
  cfg,
  accountId: "default",
  runtime: pollRuntime,
  buttonData: `custom-poll:${pollId}:vote:1`,
  actor: { id: "OTHER_MEMBER_OPENID", label: "Other" },
  sourcePeer: { kind: "group", id: "OTHER_GROUP_OPENID" },
  now: 5_100,
});
assert.equal(crossPeerVote.handled, true);
assert.equal(crossPeerVote.persist, undefined);
assert.equal(crossPeerVote.reply?.includes("不属于当前会话"), true);
assert.equal(pollRuntime.polls.getPoll(pollId)?.votes.OTHER_MEMBER_OPENID, undefined);

const gameRuntime = createCustomMessageFlowRuntime();
const game = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: gameRuntime,
  message: { ...message, content: "/bot-game guess" },
  rawContent: "/bot-game guess",
  now: 5_500,
  applyTaskWorkspaceEffects: false,
});
assert.equal(game.handled, true);
const gameId = Object.keys(gameRuntime.games.getState().guessGames)[0]!;
assert.equal(gameId, "guess-default-group-GROUP_OPENID-5500-1");
const secret = gameRuntime.games.getGuessGame(gameId)!.secret;
const gameGuess = handleCustomInteractionGatewayButton({
  cfg,
  accountId: "default",
  runtime: gameRuntime,
  buttonData: `custom-game:${gameId}:guess:${secret}`,
  actor: { id: "PLAYER_OPENID", label: "Player" },
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 5_600,
});
assert.equal(gameGuess.handled, true);
assert.equal(gameGuess.persist?.games, true);
assert.equal(gameGuess.reply?.includes("猜对了"), true);
assert.equal(gameRuntime.games.getGuessGame(gameId)?.winner?.id, "PLAYER_OPENID");

const deployRuntime = createCustomMessageFlowRuntime();
const deployCreate = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: deployRuntime,
  message: { ...message, senderId: "ADMIN_OPENID", senderName: "Admin", content: "/bot-deploy confirm /bot-upgrade --latest" },
  rawContent: "/bot-deploy confirm /bot-upgrade --latest",
  now: 5_800,
  applyTaskWorkspaceEffects: false,
});
assert.equal(deployCreate.handled, true);
const confirmationId = Object.keys(deployRuntime.deployConfirmations.getState().confirmations)[0]!;
assert.equal(confirmationId, "deploy-default-group-GROUP_OPENID-5800-1");
const deployConfirm = handleCustomInteractionGatewayButton({
  cfg,
  accountId: "default",
  runtime: deployRuntime,
  buttonData: `custom-deploy:${confirmationId}:confirm`,
  actor: { id: "ADMIN_OPENID", label: "Admin" },
  sourcePeer: { kind: "group", id: "GROUP_OPENID" },
  now: 5_900,
});
assert.equal(deployConfirm.handled, true);
assert.equal(deployConfirm.persist?.deployConfirmations, true);
assert.equal(deployConfirm.reply?.includes("请管理员在私聊中手动发送该命令"), true);
assert.equal(deployRuntime.deployConfirmations.get(confirmationId)?.status, "confirmed");

assert.deepEqual(resolveCustomInteractionSourcePeer({ groupOpenid: "GROUP_OPENID" }), {
  kind: "group",
  id: "GROUP_OPENID",
});
assert.deepEqual(resolveCustomInteractionSourcePeer({ userOpenid: "USER_OPENID" }), {
  kind: "c2c",
  id: "USER_OPENID",
});

const unknown = handleCustomInteractionGatewayButton({
  cfg,
  runtime: pollRuntime,
  buttonData: "approve:legacy:allow-once",
  actor: { id: "VOTER_OPENID" },
  now: 6_000,
});
assert.deepEqual(unknown, { handled: false });

console.log("custom interaction gateway adapter tests passed");
