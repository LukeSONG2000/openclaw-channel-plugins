import assert from "node:assert";
import { createCustomMessageFlowRuntime } from "../src/custom/runtime.js";
import { handleCustomSlashGatewayCommand } from "../src/custom/slash-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const baseMessage: QueuedMessage = {
  type: "group",
  senderId: "MEMBER_OPENID",
  senderName: "Member",
  content: "/bot-ping",
  messageId: "msg-1",
  timestamp: "2026-06-21T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
};

const cfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        admins: ["ADMIN_OPENID"],
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "chat",
            capabilities: ["chat.send", "system.status", "codex.longTask", "game.interact", "config.write"],
          },
        },
      },
    },
  },
} as any;

const deniedCfg = {
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
} as any;

const noMatch = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: createCustomMessageFlowRuntime(),
  message: baseMessage,
  rawContent: "/bot-ping",
  now: 1_000,
  applyTaskWorkspaceEffects: false,
});
assert.deepEqual(noMatch, { handled: false });

const deniedRuntime = createCustomMessageFlowRuntime();
const denied = handleCustomSlashGatewayCommand({
  cfg: deniedCfg,
  accountId: "default",
  runtime: deniedRuntime,
  message: { ...baseMessage, content: "/bot-streaming on" },
  rawContent: "/bot-streaming on",
  now: 2_000,
  applyTaskWorkspaceEffects: false,
});
assert.equal(denied.handled, true);
assert.equal(denied.persist?.auth, true);
assert.equal(denied.reply?.kind, "auth-approval");
if (denied.reply?.kind !== "auth-approval") throw new Error("expected auth approval reply");
assert.equal(denied.reply.denialText.includes("需要能力：config.write"), true);
assert.equal(denied.reply.keyboard?.content?.rows[0]?.buttons[0]?.action?.data, "custom-auth:authreq-2000-1:allow-once");
assert.equal(denied.logs?.some((item) => item.message.includes("Slash command denied by custom auth")), true);

const taskRuntime = createCustomMessageFlowRuntime();
const task = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: taskRuntime,
  message: { ...baseMessage, content: "/bot-task create Build custom slash adapter" },
  rawContent: "/bot-task create Build custom slash adapter",
  now: 3_000,
  applyTaskWorkspaceEffects: false,
});
assert.equal(task.handled, true);
assert.equal(task.persist?.tasks, true);
assert.equal(task.reply?.kind, "text");
assert.equal(task.reply?.kind === "text" && task.reply.text.includes("长任务已创建"), true);
assert.equal(Object.keys(taskRuntime.tasks.getState().tasks)[0], "qqbot-default-group-GROUP_OPENID-3000-1");

const taskId = Object.keys(taskRuntime.tasks.getState().tasks)[0]!;
const cancelTask = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: taskRuntime,
  message: { ...baseMessage, content: `/bot-task cancel ${taskId}`, messageId: "msg-cancel" },
  rawContent: `/bot-task cancel ${taskId}`,
  now: 3_500,
  applyTaskWorkspaceEffects: false,
});
assert.equal(cancelTask.handled, true);
assert.equal(cancelTask.persist?.tasks, true);
assert.equal(cancelTask.reply?.kind, "text");
assert.equal(cancelTask.taskNotificationDeliveries?.length, 1);
assert.equal(cancelTask.taskNotificationDeliveries?.[0]?.target.type, "group");
assert.equal(cancelTask.taskNotificationDeliveries?.[0]?.target.messageId, "msg-cancel");
assert.equal(cancelTask.taskNotificationDeliveries?.[0]?.text.includes("长任务已取消"), true);

const pollRuntime = createCustomMessageFlowRuntime();
const poll = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: pollRuntime,
  message: { ...baseMessage, content: "/bot-poll create Pick one | A | B" },
  rawContent: "/bot-poll create Pick one | A | B",
  now: 4_000,
  applyTaskWorkspaceEffects: false,
});
assert.equal(poll.handled, true);
assert.equal(poll.persist?.polls, true);
assert.equal(poll.reply?.kind, "keyboard");
assert.equal(poll.reply?.kind === "keyboard" && poll.reply.keyboard.content?.rows.length, 2);
assert.equal(Object.keys(pollRuntime.polls.getState().polls)[0], "poll-default-group-GROUP_OPENID-4000-1");

const sceneRuntime = createCustomMessageFlowRuntime();
const sceneStatus = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: sceneRuntime,
  message: { ...baseMessage, content: "/bot-scene status" },
  rawContent: "/bot-scene status",
  now: 5_000,
  applyTaskWorkspaceEffects: false,
});
assert.equal(sceneStatus.handled, true);
assert.equal(sceneStatus.persist, undefined);
assert.equal(sceneStatus.reply?.kind, "text");
assert.equal(sceneStatus.reply?.kind === "text" && sceneStatus.reply.text.includes("场景：chat"), true);

const sceneSet = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: sceneRuntime,
  message: { ...baseMessage, content: "/bot-scene set dev-lab" },
  rawContent: "/bot-scene set dev-lab",
  now: 5_500,
  applyTaskWorkspaceEffects: false,
});
assert.equal(sceneSet.handled, true);
assert.equal(sceneSet.persist?.config?.sceneKey, "qqbot:group:GROUP_OPENID");
assert.equal(sceneSet.persist?.config?.sceneConfig.scene, "dev-lab");
assert.equal(sceneSet.reply?.kind, "text");
assert.equal(sceneSet.reply?.kind === "text" && sceneSet.reply.text.includes("场景：dev-lab"), true);
assert.equal(cfg.channels.qqbot.customRuntime.scenes["qqbot:group:GROUP_OPENID"].scene, "dev-lab");
assert.equal(sceneSet.logs?.some((item) => item.message.includes("custom scene updated")), true);

console.log("custom slash gateway adapter tests passed");
