import assert from "node:assert";
import { applyCustomSlashGatewayEffects } from "../src/custom/slash-effects-gateway-adapter.js";

const sourceCfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        scenes: {
          "qqbot:group:OLD": { scene: "chat" },
        },
      },
    },
  },
} as any;

const infoLogs: string[] = [];
const errorLogs: string[] = [];
const sentTexts: string[] = [];
const sentTaskTexts: string[] = [];
const persistCounts: Record<string, number> = {
  auth: 0,
  tasks: 0,
  polls: 0,
  games: 0,
  deploy: 0,
};
let writtenConfig: any = null;

const result = await applyCustomSlashGatewayEffects({
  accountId: "default",
  cfg: sourceCfg,
  result: {
    handled: true,
    logs: [
      { level: "info", message: "custom info" },
      { level: "error", message: "custom error" },
    ],
    persist: {
      auth: true,
      config: {
        sceneKey: "qqbot:group:GROUP_OPENID",
        sceneConfig: { scene: "dev-lab", label: "Dev Lab" },
      },
      tasks: true,
      polls: true,
      games: true,
      deployConfirmations: true,
    },
    reply: { kind: "text", text: "done" },
    taskNotificationDeliveries: [
      {
        target: {
          type: "group",
          senderId: "OWNER_OPENID",
          groupOpenid: "GROUP_OPENID",
          messageId: "msg-1",
        },
        text: "task sent",
        taskId: "task-1",
        audience: "peer",
      },
      {
        target: {
          type: "group",
          senderId: "OWNER_OPENID",
          groupOpenid: "GROUP_OPENID",
          messageId: "",
        },
        text: "task skipped",
        taskId: "task-2",
        audience: "peer",
      },
    ],
  },
  getConfigApi: () => ({
    loadConfig: () => sourceCfg,
    writeConfigFile: async (cfg) => { writtenConfig = cfg; },
  }),
  persistAuthState: () => { persistCounts.auth += 1; },
  persistTaskState: () => { persistCounts.tasks += 1; },
  persistPollState: () => { persistCounts.polls += 1; },
  persistGameState: () => { persistCounts.games += 1; },
  persistDeployConfirmationState: () => { persistCounts.deploy += 1; },
  sendText: async (text) => { sentTexts.push(text); },
  sendKeyboard: async () => { throw new Error("unexpected keyboard"); },
  sendTaskNotificationText: async (delivery) => { sentTaskTexts.push(delivery.text); },
  log: {
    info: (message) => infoLogs.push(message),
    error: (message) => errorLogs.push(message),
  },
});

assert.deepEqual(persistCounts, { auth: 1, tasks: 1, polls: 1, games: 1, deploy: 1 });
assert.equal(result.authPersisted, true);
assert.equal(result.configPersisted, true);
assert.equal(result.tasksPersisted, true);
assert.equal(result.pollsPersisted, true);
assert.equal(result.gamesPersisted, true);
assert.equal(result.deployConfirmationsPersisted, true);
assert.equal(result.replyDelivered, true);
assert.equal(result.replyFailed, false);
assert.deepEqual(sentTexts, ["done"]);
assert.deepEqual(sentTaskTexts, ["task sent"]);
assert.equal(result.taskNotificationResults[0]?.status, "sent");
assert.equal(result.taskNotificationResults[1]?.status, "skipped");
assert.equal(writtenConfig.channels.qqbot.customRuntime.scenes["qqbot:group:GROUP_OPENID"].scene, "dev-lab");
assert.equal(writtenConfig.channels.qqbot.customRuntime.scenes["qqbot:group:OLD"].scene, "chat");
assert.equal(sourceCfg.channels.qqbot.customRuntime.scenes["qqbot:group:GROUP_OPENID"], undefined);
assert.equal(infoLogs.some((line) => line.includes("custom info")), true);
assert.equal(errorLogs.some((line) => line.includes("custom error")), true);
assert.equal(infoLogs.some((line) => line.includes("custom runtime config persisted")), true);
assert.equal(infoLogs.some((line) => line.includes("custom task notification sent")), true);
assert.equal(infoLogs.some((line) => line.includes("custom task notification skipped")), true);

let initBindWrittenConfig: any = null;
const initBindLogs: string[] = [];
const initBindCfg = {
  channels: {
    qqbot: {
      customRuntime: {
        enabled: false,
        initBind: { code: "BIND123", expiresAt: 2_000, enableRuntimeOnComplete: true },
      },
    },
  },
} as any;
const initBindEffect = await applyCustomSlashGatewayEffects({
  accountId: "default",
  cfg: initBindCfg,
  result: {
    handled: true,
    persist: {
      initBind: {
        admins: ["MEMBER_OPENID"],
        adminGroup: "GROUP_OPENID",
        clearInitBind: true,
        enableRuntime: true,
      },
    },
  },
  getConfigApi: () => ({
    loadConfig: () => initBindCfg,
    writeConfigFile: async (cfg) => { initBindWrittenConfig = cfg; },
  }),
  sendText: async () => {},
  sendKeyboard: async () => { throw new Error("unexpected keyboard"); },
  log: {
    info: (message) => initBindLogs.push(message),
    error: () => {},
  },
});
assert.equal(initBindEffect.configPersisted, true);
assert.deepEqual(initBindWrittenConfig.channels.qqbot.customRuntime.admins, ["MEMBER_OPENID"]);
assert.equal(initBindWrittenConfig.channels.qqbot.customRuntime.adminGroup, "qqbot:group:GROUP_OPENID");
assert.equal(initBindWrittenConfig.channels.qqbot.customRuntime.enabled, true);
assert.equal(initBindWrittenConfig.channels.qqbot.customRuntime.initBind, undefined);
assert.equal(initBindWrittenConfig.channels.qqbot.customRuntime.scenes["qqbot:group:GROUP_OPENID"].scene, "system-admin");
assert.equal(initBindLogs.some((line) => line.includes("custom runtime init binding persisted")), true);

const failedReplyTaskTexts: string[] = [];
const failedReplyErrors: string[] = [];
const failedReply = await applyCustomSlashGatewayEffects({
  accountId: "default",
  cfg: sourceCfg,
  result: {
    handled: true,
    reply: { kind: "text", text: "will fail" },
    taskNotificationDeliveries: [
      {
        target: {
          type: "c2c",
          senderId: "USER_OPENID",
          messageId: "msg-2",
        },
        text: "still sent",
        taskId: "task-3",
        audience: "owner",
      },
    ],
  },
  sendText: async () => { throw new Error("reply failed"); },
  sendKeyboard: async () => { throw new Error("unexpected keyboard"); },
  sendTaskNotificationText: async (delivery) => { failedReplyTaskTexts.push(delivery.text); },
  log: {
    info: () => {},
    error: (message) => failedReplyErrors.push(message),
  },
});

assert.equal(failedReply.replyDelivered, false);
assert.equal(failedReply.replyFailed, true);
assert.deepEqual(failedReplyTaskTexts, ["still sent"]);
assert.equal(failedReply.taskNotificationResults[0]?.status, "sent");
assert.equal(failedReplyErrors.some((line) => line.includes("Failed to send custom slash command reply")), true);

await assert.rejects(
  () => applyCustomSlashGatewayEffects({
    accountId: "default",
    cfg: sourceCfg,
    result: {
      handled: true,
      persist: {
        config: {
          sceneKey: "qqbot:group:MISSING_API",
          sceneConfig: { scene: "chat" },
        },
      },
    },
    sendText: async () => {},
    sendKeyboard: async () => {},
  }),
  /getConfigApi is required/,
);

console.log("custom slash effects gateway adapter tests passed");
