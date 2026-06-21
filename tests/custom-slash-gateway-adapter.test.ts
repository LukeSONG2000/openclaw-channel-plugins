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
        adminGroup: "GROUP_OPENID",
        tasks: {
          workspaceRoot: "/tmp/global-slash-tasks",
          maxActiveTasksPerPeer: 4,
        },
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "chat",
            capabilities: ["chat.send", "system.status", "codex.longTask", "game.interact", "config.write"],
            tasks: {
              workspaceRoot: "/tmp/group-slash-tasks",
              maxActiveTasksPerPeer: 1,
            },
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
assert.equal(denied.reply.approvalText?.includes("管理群：qqbot:group:GROUP_OPENID"), true);
assert.equal(denied.reply.keyboard?.content?.rows[0]?.buttons[0]?.action?.data, "custom-auth:authreq-2000-1:allow-once");
assert.equal(denied.reply.adminGroupNotification, null);
assert.equal(denied.logs?.some((item) => item.message.includes("Slash command denied by custom auth")), true);

const dmDeniedRuntime = createCustomMessageFlowRuntime();
const dmDenied = handleCustomSlashGatewayCommand({
  cfg: deniedCfg,
  accountId: "default",
  runtime: dmDeniedRuntime,
  message: {
    ...baseMessage,
    type: "c2c",
    groupOpenid: undefined,
    content: "/bot-streaming on",
  },
  rawContent: "/bot-streaming on",
  now: 2_500,
  applyTaskWorkspaceEffects: false,
});
assert.equal(dmDenied.handled, true);
assert.equal(dmDenied.reply?.kind, "auth-approval");
if (dmDenied.reply?.kind !== "auth-approval") throw new Error("expected dm auth approval reply");
assert.equal(dmDenied.reply.adminGroupNotification?.groupOpenid, "GROUP_OPENID");
assert.equal(dmDenied.reply.adminGroupNotification?.requestId, "authreq-2500-1");

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
assert.equal(taskRuntime.tasks.getTask("qqbot-default-group-GROUP_OPENID-3000-1")?.workspace, "/tmp/group-slash-tasks/qqbot-default-group-GROUP_OPENID-3000-1");

const taskOverSceneLimit = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: taskRuntime,
  message: { ...baseMessage, content: "/bot-task create second scene task" },
  rawContent: "/bot-task create second scene task",
  now: 3_100,
  applyTaskWorkspaceEffects: false,
});
assert.equal(taskOverSceneLimit.handled, true);
assert.equal(taskOverSceneLimit.persist?.tasks, undefined);
assert.equal(taskOverSceneLimit.reply?.kind === "text" && taskOverSceneLimit.reply.text.includes("活跃长任务过多"), true);

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

const taskAuthRuntime = createCustomMessageFlowRuntime();
const ownerTask = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: taskAuthRuntime,
  message: { ...baseMessage, senderId: "OWNER_OPENID", senderName: "Owner", content: "/bot-task create Owner task" },
  rawContent: "/bot-task create Owner task",
  now: 3_600,
  applyTaskWorkspaceEffects: false,
});
assert.equal(ownerTask.handled, true);
const ownerTaskId = Object.keys(taskAuthRuntime.tasks.getState().tasks)[0]!;

const deniedTaskAdd = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: taskAuthRuntime,
  message: { ...baseMessage, senderId: "MEMBER_OPENID", senderName: "Member", content: `/bot-task add ${ownerTaskId} member idea` },
  rawContent: `/bot-task add ${ownerTaskId} member idea`,
  now: 3_700,
  applyTaskWorkspaceEffects: false,
});
assert.equal(deniedTaskAdd.handled, true);
assert.equal(deniedTaskAdd.persist?.auth, true);
assert.equal(deniedTaskAdd.persist?.tasks, undefined);
assert.equal(deniedTaskAdd.reply?.kind, "auth-approval");
if (deniedTaskAdd.reply?.kind !== "auth-approval") throw new Error("expected task auth approval reply");
assert.equal(deniedTaskAdd.reply.denialText.includes("需要能力：codex.longTask"), true);
assert.equal(deniedTaskAdd.reply.approvalText?.includes(`任务：${ownerTaskId}`), true);
assert.equal(deniedTaskAdd.reply.approvalText?.includes("管理群：qqbot:group:GROUP_OPENID"), true);
assert.equal(deniedTaskAdd.reply.adminGroupNotification, null);
assert.equal(deniedTaskAdd.reply.keyboard?.content?.rows[0]?.buttons[0]?.render_data?.label, "允许此任务");

const taskRequestId = Object.keys(taskAuthRuntime.auth.getState().requests)[0]!;
const approveTask = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: taskAuthRuntime,
  message: { ...baseMessage, senderId: "ADMIN_OPENID", senderName: "Admin", content: `/bot-auth approve ${taskRequestId}` },
  rawContent: `/bot-auth approve ${taskRequestId}`,
  now: 3_800,
  applyTaskWorkspaceEffects: false,
});
assert.equal(approveTask.handled, true);
assert.equal(approveTask.persist?.auth, true);
assert.equal(taskAuthRuntime.auth.getState().grants[Object.keys(taskAuthRuntime.auth.getState().grants)[0]!]!.taskId, ownerTaskId);

const allowedTaskAdd = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: taskAuthRuntime,
  message: { ...baseMessage, senderId: "MEMBER_OPENID", senderName: "Member", content: `/bot-task add ${ownerTaskId} member idea after approval` },
  rawContent: `/bot-task add ${ownerTaskId} member idea after approval`,
  now: 3_900,
  applyTaskWorkspaceEffects: false,
});
assert.equal(allowedTaskAdd.handled, true);
assert.equal(allowedTaskAdd.persist?.tasks, true);
assert.equal(allowedTaskAdd.reply?.kind === "text" && allowedTaskAdd.reply.text.includes("当前追加需求数：1"), true);

const crossPeerTaskAdd = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: taskAuthRuntime,
  message: {
    ...baseMessage,
    groupOpenid: "OTHER_GROUP_OPENID",
    senderId: "MEMBER_OPENID",
    senderName: "Member",
    content: `/bot-task add ${ownerTaskId} cross peer idea`,
  },
  rawContent: `/bot-task add ${ownerTaskId} cross peer idea`,
  now: 3_950,
  applyTaskWorkspaceEffects: false,
});
assert.equal(crossPeerTaskAdd.handled, true);
assert.equal(crossPeerTaskAdd.persist?.auth, undefined);
assert.equal(crossPeerTaskAdd.persist?.tasks, undefined);
assert.equal(crossPeerTaskAdd.reply?.kind, "text");
assert.equal(crossPeerTaskAdd.reply?.kind === "text" && crossPeerTaskAdd.reply.text.includes("不属于当前会话"), true);
assert.equal(Object.values(taskAuthRuntime.auth.getState().requests).filter((request) => request.status === "pending").length, 0);

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

const sceneBindings = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: sceneRuntime,
  message: { ...baseMessage, content: "/bot-scene bindings" },
  rawContent: "/bot-scene bindings",
  now: 5_700,
  applyTaskWorkspaceEffects: false,
});
assert.equal(sceneBindings.handled, true);
assert.equal(sceneBindings.persist, undefined);
assert.equal(sceneBindings.reply?.kind, "text");
assert.equal(sceneBindings.reply?.kind === "text" && sceneBindings.reply.text.includes("已配置自定义场景绑定"), true);
assert.equal(sceneBindings.reply?.kind === "text" && sceneBindings.reply.text.includes("qqbot:group:GROUP_OPENID"), true);

const fallbackStatus = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: createCustomMessageFlowRuntime(),
  message: { ...baseMessage, content: "/bot-fallback" },
  rawContent: "/bot-fallback",
  now: 6_000,
  applyTaskWorkspaceEffects: false,
});
assert.equal(fallbackStatus.handled, true);
assert.equal(fallbackStatus.persist, undefined);
assert.equal(fallbackStatus.reply?.kind, "text");
assert.equal(fallbackStatus.reply?.kind === "text" && fallbackStatus.reply.text.includes("最近兜底事件"), true);

const queueStatus = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: createCustomMessageFlowRuntime(),
  message: { ...baseMessage, content: "/bot-queue" },
  rawContent: "/bot-queue",
  now: 6_100,
  queueStatus: {
    peerId: "group:GROUP_OPENID",
    snapshot: {
      totalPending: 7,
      activeUsers: 2,
      maxConcurrentUsers: 10,
      senderPending: 3,
      senderActiveMs: 12_000,
      maxActiveMs: 44_000,
    },
  },
  applyTaskWorkspaceEffects: false,
});
assert.equal(queueStatus.handled, true);
assert.equal(queueStatus.persist, undefined);
assert.equal(queueStatus.reply?.kind, "text");
assert.equal(queueStatus.reply?.kind === "text" && queueStatus.reply.text.includes("当前会话：group:GROUP_OPENID"), true);
assert.equal(queueStatus.reply?.kind === "text" && queueStatus.reply.text.includes("本会话待处理：3"), true);
assert.equal(queueStatus.reply?.kind === "text" && queueStatus.reply.text.includes("全局待处理：7"), true);
assert.equal(queueStatus.reply?.kind === "text" && queueStatus.reply.text.includes("本会话活跃：12s"), true);
assert.equal(queueStatus.reply?.kind === "text" && queueStatus.reply.text.includes(`<qqbot-cmd-input text="/compact" show="压缩上下文"/>`), true);

const unreadRuntime = createCustomMessageFlowRuntime();
unreadRuntime.unread.recordNonMention({
  message: {
    accountId: "default",
    peer: { kind: "group", id: "GROUP_OPENID" },
    actor: { id: "MEMBER_OPENID", label: "Member" },
    content: "hidden unread content",
    messageId: "unread-1",
    timestamp: 6_100,
    mentionedBot: false,
  },
  cfg: {
    enabled: true,
    historyLimit: 10,
    followupDelayMs: 1_000,
    sleepDelayMs: 10_000,
    allowAutonomousReply: false,
    allowProactiveSend: false,
  },
  now: 6_100,
});
const unreadStatus = handleCustomSlashGatewayCommand({
  cfg,
  accountId: "default",
  runtime: unreadRuntime,
  message: { ...baseMessage, content: "/bot-unread" },
  rawContent: "/bot-unread",
  now: 6_200,
  applyTaskWorkspaceEffects: false,
});
assert.equal(unreadStatus.handled, true);
assert.equal(unreadStatus.persist, undefined);
assert.equal(unreadStatus.reply?.kind, "text");
assert.equal(unreadStatus.reply?.kind === "text" && unreadStatus.reply.text.includes("自定义未读状态"), true);
assert.equal(unreadStatus.reply?.kind === "text" && unreadStatus.reply.text.includes("hidden unread content"), false);

const deniedFallbackClear = handleCustomSlashGatewayCommand({
  cfg: deniedCfg,
  accountId: "default",
  runtime: createCustomMessageFlowRuntime(),
  message: { ...baseMessage, content: "/bot-fallback clear --force" },
  rawContent: "/bot-fallback clear --force",
  now: 6_500,
  applyTaskWorkspaceEffects: false,
});
assert.equal(deniedFallbackClear.handled, true);
assert.equal(deniedFallbackClear.persist?.auth, true);
assert.equal(deniedFallbackClear.reply?.kind, "auth-approval");
if (deniedFallbackClear.reply?.kind !== "auth-approval") throw new Error("expected fallback clear auth approval reply");
assert.equal(deniedFallbackClear.reply.denialText.includes("需要能力：config.write"), true);

console.log("custom slash gateway adapter tests passed");
