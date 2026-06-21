import assert from "node:assert";
import { createCustomConnectionHandlersGateway } from "../src/custom/connection-handlers-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const events: string[] = [];
const groupHistories = new Map();
const fakeTaskExecutor = { dispose: () => events.push("task-dispose") } as any;
const fakeUnreadScheduler = {
  restore: () => {},
  apply: () => {},
  dispose: () => events.push("unread-dispose"),
} as any;
const runtime = {
  auth: { id: "auth" },
  unread: { id: "unread" },
  proactiveBudget: { id: "proactive" },
  tasks: { id: "tasks" },
  polls: { id: "polls" },
  games: { id: "games" },
  deployConfirmations: { id: "deploy" },
} as any;
const account = {
  accountId: "default",
  appId: "APP",
  clientSecret: "SECRET",
  config: {},
} as any;
const message: QueuedMessage = {
  type: "c2c",
  senderId: "USER_OPENID",
  content: "hello",
  messageId: "MSG",
  timestamp: "2026-06-22T00:00:00.000Z",
};

const result = createCustomConnectionHandlersGateway({
  account,
  cfg: { channels: { qqbot: {} } },
  pluginRuntime: { channel: {} },
  runtime,
  previousTaskExecutor: fakeTaskExecutor,
  enqueueMessage: async (queued) => { events.push(`enqueue:${queued.messageId}`); },
  getQueueSnapshot: (peerId) => ({ peerId }),
  persistAuthState: () => { events.push("persist-auth"); },
  persistProactiveBudgetState: () => { events.push("persist-proactive"); },
  persistTaskState: () => { events.push("persist-task"); },
  persistPollState: () => { events.push("persist-poll"); },
  persistGameState: () => { events.push("persist-game"); },
  persistDeployConfirmationState: () => { events.push("persist-deploy"); },
  persistUnreadState: () => { events.push("persist-unread"); },
  sendTaskStatusText: async () => { events.push("send-task-status"); },
  buildProactiveGuard: () => ({ proactiveGuard: () => ({ allowed: true }) }),
  sendMedia: async () => ({ ok: true }) as any,
  createDebouncer: () => ({ run: async (_key: string, fn: () => Promise<unknown>) => fn() }) as any,
  parseAndSendMediaTags: async () => ({ text: "" }) as any,
  handleStructuredPayload: async () => false as any,
  sendPlainReply: async () => {},
  adminGroupNotifications: {
    sendFallbackAdminGroupAlert: async () => {},
    sendAuthAdminGroupNotification: async () => {},
  },
  isCustomRuntimeEnabled: () => true,
  isControlCommand: () => false,
  stripMentionText: (text) => text,
  detectWasMentioned: () => true,
  resolveRequireMention: () => true,
  resolveGroupIntroHint: () => undefined,
  getConfigApi: () => ({ loadConfig: () => ({}), writeConfigFile: async () => {} }),
  getRouting: () => ({ resolveAgentRoute: () => ({}) }) as any,
  getLegacyApprovalHandler: () => undefined,
  groupHistories,
  createRuntimeServices: (params) => {
    events.push(`runtime-services:${params.accountId}`);
    assert.equal(params.previousTaskExecutor, fakeTaskExecutor);
    assert.equal(params.runtime, runtime);
    void params.enqueueMessage(message);
    return {
      taskExecutor: fakeTaskExecutor,
      unreadScheduler: fakeUnreadScheduler,
      resolveUnreadForEvent: () => ({ enabled: true }) as any,
      resolveUnreadForPeer: () => ({ enabled: true }) as any,
    } as any;
  },
  createMessageHandler: (params) => {
    events.push(`message-handler:${params.account.accountId}`);
    assert.equal(params.groupHistories, groupHistories);
    assert.equal(params.getUnreadScheduler(), fakeUnreadScheduler);
    assert.deepEqual(params.customRuntimeServices.resolveUnreadForEvent({ ...message, _customUnreadSnapshotId: "s" }), { enabled: true });
    return async (queued) => { events.push(`handle-message:${queued.messageId}`); };
  },
  createInteractionHandler: (params) => {
    events.push(`interaction-handler:${params.account.accountId}`);
    assert.equal(params.runtime.auth, runtime.auth);
    assert.equal(params.runtime.polls, runtime.polls);
    assert.equal(params.runtime.games, runtime.games);
    assert.equal(params.runtime.deployConfirmations, runtime.deployConfirmations);
    return async (event) => {
      events.push(`handle-interaction:${event.id}`);
      return { kind: "custom", handled: true } as any;
    };
  },
  createInboundEventHandler: (params) => {
    events.push(`inbound-handler:${params.accountId}`);
    assert.equal(params.runtime, runtime);
    return async (eventType, data) => {
      events.push(`dispatch-inbound:${eventType}:${(data as any).id}`);
      await params.handleInteraction({ id: "INTERACTION_FROM_INBOUND" } as any);
      return { kind: "unsupported" } as any;
    };
  },
});

assert.equal(result.taskExecutor, fakeTaskExecutor);
assert.equal(result.unreadScheduler, fakeUnreadScheduler);
assert.equal(result.groupHistories, groupHistories);
await result.handleMessage(message);
await result.dispatchInboundEvent("INTERACTION_CREATE", { id: "RAW" });

assert.deepEqual(events, [
  "runtime-services:default",
  "enqueue:MSG",
  "message-handler:default",
  "interaction-handler:default",
  "inbound-handler:default",
  "handle-message:MSG",
  "dispatch-inbound:INTERACTION_CREATE:RAW",
  "handle-interaction:INTERACTION_FROM_INBOUND",
]);

console.log("custom connection handlers gateway adapter tests passed");
