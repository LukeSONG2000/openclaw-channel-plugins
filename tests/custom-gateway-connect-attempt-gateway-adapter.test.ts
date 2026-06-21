import assert from "node:assert";
import { runQQBotGatewayConnectAttempt } from "../src/custom/gateway-connect-attempt-gateway-adapter.js";

function baseLifecycle(events: string[], begin = true) {
  return {
    beginConnect: () => {
      events.push("begin");
      return begin;
    },
    prepareConnection: (params?: { clearTokenCache?: () => void }) => {
      events.push("prepare");
      params?.clearTokenCache?.();
    },
    setConnecting: (value: boolean) => { events.push(`connecting:${value}`); },
    isAborted: () => false,
    setAborted: () => {},
    registerAbort: () => {},
    cleanup: () => {},
    scheduleReconnect: () => {},
    waitForAbort: async () => {},
    restoreSession: () => {},
    getSessionState: () => ({ sessionId: null, lastSeq: null, lastConnectTime: 0 }),
    setLastSeq: () => {},
    setSessionId: () => {},
    setShouldRefreshToken: () => {},
    setCurrentWebSocket: () => {},
    setReconnectAttempts: () => {},
    setLastConnectTime: () => {},
    getLastConnectTime: () => 0,
    getQuickDisconnectCount: () => 0,
    setQuickDisconnectCount: () => {},
    resetHeartbeat: () => {},
    snapshot: () => ({}),
  } as any;
}

function baseParams(events: string[], overrides: Record<string, unknown> = {}) {
  const taskExecutor = { id: "task" } as any;
  const unreadScheduler = { id: "unread" } as any;
  const params = {
    account: { accountId: "default", appId: "APP", clientSecret: "SECRET", config: {} } as any,
    cfg: {},
    transportMode: "websocket" as const,
    abortSignal: {} as AbortSignal,
    lifecycle: baseLifecycle(events),
    messageQueue: { startProcessor: () => {} } as any,
    runtime: { auth: {}, unread: {}, proactiveBudget: {}, tasks: {}, polls: {}, games: {}, deployConfirmations: {} } as any,
    getPreviousTaskExecutor: () => ({ id: "previous" }) as any,
    setTaskExecutor: (executor: any) => { events.push(`set-task:${executor.id}`); },
    setUnreadScheduler: (scheduler: any) => { events.push(`set-unread:${scheduler.id}`); },
    enqueueMessage: async () => {},
    getQueueSnapshot: () => ({}),
    persistAuthState: () => {},
    persistProactiveBudgetState: () => {},
    persistTaskState: () => {},
    persistPollState: () => {},
    persistGameState: () => {},
    persistDeployConfirmationState: () => {},
    persistUnreadState: () => {},
    sendTaskStatusText: async () => {},
    buildProactiveGuard: () => ({ proactiveGuard: () => ({ allowed: true }) }),
    sendMedia: async () => ({ ok: true }) as any,
    createDebouncer: () => ({}) as any,
    parseAndSendMediaTags: async () => ({}) as any,
    handleStructuredPayload: async () => false as any,
    sendPlainReply: async () => {},
    adminGroupNotifications: {
      sendFallbackAdminGroupAlert: async () => {},
      sendAuthAdminGroupNotification: async () => {},
    },
    isCustomRuntimeEnabled: () => true,
    isControlCommand: () => false,
    stripMentionText: (text: string) => text,
    detectWasMentioned: () => true,
    resolveRequireMention: () => true,
    getConfigApi: () => ({ writeConfigFile: async () => {} }),
    adminContext: { accountId: "default", appId: "APP", clientSecret: "SECRET" },
    isPendingFirstReady: () => true,
    markFirstReadyConsumed: () => {},
    unregisterApprovalHandler: () => {},
    scheduleReconnect: (delay?: number) => { events.push(`reconnect:${delay ?? "default"}`); },
    intents: 123,
    intentsDesc: "full",
    quickDisconnectThresholdMs: 5,
    maxQuickDisconnectCount: 3,
    rateLimitDelayMs: 60,
    getRuntime: () => {
      events.push("runtime");
      return { plugin: true };
    },
    clearTokenCache: (appId: string) => { events.push(`clear:${appId}`); },
    createConnectionHandlers: (input: any) => {
      events.push(`handlers:${input.account.accountId}:${input.previousTaskExecutor.id}:${Boolean(input.pluginRuntime.plugin)}`);
      return {
        taskExecutor,
        unreadScheduler,
        handleMessage: async () => { events.push("handle-message"); },
        dispatchInboundEvent: async () => { events.push("dispatch-event"); },
      } as any;
    },
    startTransportRunner: async (input: any) => {
      events.push(`transport:${input.transportMode}:${input.intents}:${input.intentsDesc}`);
      await input.handleMessage({} as any);
      await input.dispatchInboundEvent("EVENT", {});
      input.scheduleReconnect(250);
      return { transport: "websocket", result: { action: "started" } } as any;
    },
    handleConnectionFailure: (input: any) => {
      events.push(`failure:${input.accountId}:${input.err.message}:${input.rateLimitDelayMs}`);
      input.scheduleReconnect();
    },
    ...overrides,
  };
  return params as any;
}

{
  const events: string[] = [];
  const result = await runQQBotGatewayConnectAttempt(baseParams(events));
  assert.deepEqual(result, { action: "completed" });
  assert.deepEqual(events, [
    "begin",
    "prepare",
    "clear:APP",
    "runtime",
    "handlers:default:previous:true",
    "set-task:task",
    "set-unread:unread",
    "transport:websocket:123:full",
    "handle-message",
    "dispatch-event",
    "reconnect:250",
  ]);
}

{
  const events: string[] = [];
  const result = await runQQBotGatewayConnectAttempt(baseParams(events, {
    lifecycle: baseLifecycle(events, false),
  }));
  assert.deepEqual(result, { action: "skipped" });
  assert.deepEqual(events, ["begin"]);
}

{
  const events: string[] = [];
  const result = await runQQBotGatewayConnectAttempt(baseParams(events, {
    createConnectionHandlers: () => {
      events.push("handlers-throw");
      throw new Error("handler failed");
    },
  }));
  assert.equal(result.action, "failed");
  assert.deepEqual(events, [
    "begin",
    "prepare",
    "clear:APP",
    "runtime",
    "handlers-throw",
    "connecting:false",
    "failure:default:handler failed:60",
    "reconnect:default",
  ]);
}

console.log("custom gateway connect attempt gateway adapter tests passed");
