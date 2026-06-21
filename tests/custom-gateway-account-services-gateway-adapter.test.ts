import assert from "node:assert";
import { createCustomGatewayAccountServices } from "../src/custom/gateway-account-services-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const events: string[] = [];
const message: QueuedMessage = {
  type: "c2c",
  senderId: "USER_OPENID",
  content: "/bot-auth status",
  messageId: "MSG_1",
  timestamp: "2026-06-22T00:00:00.000Z",
};
const runtime = {
  auth: { id: "auth" },
  unread: { id: "unread" },
  proactiveBudget: { id: "budget" },
  tasks: { id: "tasks" },
  polls: { id: "polls" },
  games: { id: "games" },
  deployConfirmations: { id: "deploy" },
} as any;
const state = {
  runtime,
  restoredAuthIntents: [{ kind: "grant-expired", grantId: "grant-1" }],
  persistAuthState: () => { events.push("persist-auth"); },
  persistProactiveBudgetState: () => { events.push("persist-proactive"); },
  persistTaskState: () => { events.push("persist-task"); },
  persistPollState: () => { events.push("persist-poll"); },
  persistGameState: () => { events.push("persist-game"); },
  persistDeployConfirmationState: () => { events.push("persist-deploy"); },
  persistUnreadState: () => { events.push("persist-unread"); },
  persistAllState: () => { events.push("persist-all"); },
} as any;
const queue = {
  enqueue: () => {},
  startProcessor: () => {},
  getSnapshot: () => ({}),
  getMessagePeerId: () => "USER_OPENID",
  clearUserQueue: () => 0,
  executeImmediate: () => {},
} as any;
const adminNotifications = {
  sendDelivery: async () => {},
  sendAuthAdminGroupNotification: async (notification: any) => {
    events.push(`admin-auth:${notification.source}:${notification.requestId}`);
  },
  sendFallbackAdminGroupAlert: async () => {},
  sendUpdateAvailableNotification: async () => { events.push("admin-update"); },
};
const updateCheck = {
  checkNow: async () => ({ status: "up-to-date", packageName: "pkg", checkedAt: 1 }) as any,
  stop: () => { events.push("update-stop"); },
  getLastResult: () => null,
};
const taskExecutor = { id: "task-executor" } as any;
const logs: string[] = [];

const services = createCustomGatewayAccountServices({
  account: {
    accountId: "default",
    appId: "APP",
    clientSecret: "SECRET",
    config: { customUpdateCheck: { enabled: true } },
  } as any,
  cfg: { channels: { qqbot: { customRuntime: { enabled: true } } } },
  isAborted: () => false,
  getTaskExecutor: () => taskExecutor,
  stripMentionText: (text) => text,
  getConfigApi: () => ({ loadConfig: () => ({}), writeConfigFile: async () => {} }),
  log: {
    info: (message) => { logs.push(message); },
    error: (message) => { logs.push(message); },
  },
  createMessageQueue: (params) => {
    events.push(`queue:${params.accountId}:${params.isAborted()}`);
    return queue;
  },
  createStateController: (params) => {
    events.push(`state:${params.accountId}`);
    return state;
  },
  describeAuthorizationIntents: (intents) => {
    assert.equal(intents, state.restoredAuthIntents);
    return ["expired grant-1"];
  },
  resolveCustomRuntimeConfig: () => ({ enabled: true, adminGroup: "GROUP_OPENID" }) as any,
  createProactiveGatewayGuard: (params) => {
    events.push(`guard:${params.accountId}:${params.sourceMessageId ?? "none"}`);
    assert.equal(params.budget, runtime.proactiveBudget);
    params.persistBudgetState();
    return (() => ({ allowed: true, reason: "allowed" })) as any;
  },
  createAdminGroupNotificationService: (params) => {
    events.push(`admin-service:${params.accountId}:${params.getRuntime().enabled}`);
    params.buildProactiveGuard();
    return adminNotifications as any;
  },
  startUpdateCheckLoop: (params) => {
    events.push(`update:${params.accountId}:${params.accountConfig?.customUpdateCheck?.enabled}`);
    assert.equal(params.onUpdateAvailable, adminNotifications.sendUpdateAvailableNotification);
    return updateCheck;
  },
  createSlashPrequeueHandler: (params) => {
    events.push(`slash:${params.account.accountId}:${params.getTaskExecutor?.()?.id}`);
    assert.equal(params.runtime, runtime);
    assert.equal(params.queue, queue);
    return async (queued) => {
      events.push(`slash-run:${queued.messageId}`);
      params.persistAuthState();
      await params.sendAdminGroupNotification({
        groupOpenid: "GROUP_OPENID",
        text: "auth",
        requestId: "req-1",
      } as any);
      return { handled: true } as any;
    };
  },
});

assert.equal(services.queue, queue);
assert.equal(services.state, state);
assert.equal(services.runtime, runtime);
assert.equal(services.adminGroupNotifications, adminNotifications);
assert.equal(services.updateCheck, updateCheck);
assert.equal(services.isCustomRuntimeEnabled(), true);
services.buildProactiveGuard({ messageId: "MSG_SOURCE" });
await services.trySlashCommandOrEnqueue(message);

assert.equal(logs.some((line) => line.includes("custom auth restore: expired grant-1")), true);
assert.deepEqual(events, [
  "queue:default:false",
  "state:default",
  "admin-service:default:true",
  "guard:default:none",
  "persist-proactive",
  "update:default:true",
  "slash:default:task-executor",
  "guard:default:MSG_SOURCE",
  "persist-proactive",
  "slash-run:MSG_1",
  "persist-auth",
  "admin-auth:slash:req-1",
]);

console.log("custom gateway account services gateway adapter tests passed");
