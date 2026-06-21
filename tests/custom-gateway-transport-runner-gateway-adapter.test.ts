import assert from "node:assert";
import { startQQBotGatewayTransportRunner } from "../src/custom/gateway-transport-runner-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

function createLifecycle(events: string[] = []) {
  return {
    isAborted: () => false,
    getSessionState: () => ({ sessionId: "SESSION", lastSeq: 10, lastConnectTime: 100 }),
    setLastSeq: (value: number | null) => { events.push(`last-seq:${value}`); },
    setSessionId: (value: string | null) => { events.push(`session:${value}`); },
    setShouldRefreshToken: (value: boolean) => { events.push(`refresh:${value}`); },
    setCurrentWebSocket: (value: unknown) => { events.push(`ws:${Boolean(value)}`); },
    setConnecting: (value: boolean) => { events.push(`connecting:${value}`); },
    setReconnectAttempts: (value: number) => { events.push(`attempts:${value}`); },
    setLastConnectTime: (value: number) => { events.push(`last-connect:${value}`); },
    getLastConnectTime: () => 100,
    getQuickDisconnectCount: () => 1,
    setQuickDisconnectCount: (value: number) => { events.push(`quick:${value}`); },
    resetHeartbeat: () => { events.push("heartbeat"); },
    cleanup: () => { events.push("cleanup"); },
  } as any;
}

const account = {
  accountId: "default",
  appId: "APP",
  clientSecret: "SECRET",
  config: { webhook: { path: "/qq" } },
} as any;
const message: QueuedMessage = {
  type: "c2c",
  senderId: "USER_OPENID",
  content: "hello",
  messageId: "MSG",
  timestamp: "2026-06-22T00:00:00.000Z",
};

{
  const events: string[] = [];
  const result = await startQQBotGatewayTransportRunner({
    account,
    abortSignal: {} as AbortSignal,
    transportMode: "webhook",
    lifecycle: createLifecycle(events),
    messageQueue: {
      startProcessor: async (handler) => {
        events.push("start-processor");
        await handler(message);
      },
    } as any,
    handleMessage: async (queued) => { events.push(`handle:${queued.messageId}`); },
    dispatchInboundEvent: async (eventType, data) => { events.push(`dispatch:${eventType}:${(data as any).id}`); },
    adminContext: { accountId: "default", appId: "APP", clientSecret: "SECRET" },
    isPendingFirstReady: () => true,
    markFirstReadyConsumed: () => { events.push("ready-consumed"); },
    unregisterApprovalHandler: (accountId) => { events.push(`unregister:${accountId}`); },
    scheduleReconnect: () => { events.push("reconnect"); },
    onReady: (payload) => { events.push(`ready:${(payload as any).transport}`); },
    onError: (error) => { events.push(`error:${error.message}`); },
    intents: 123,
    intentsDesc: "full",
    quickDisconnectThresholdMs: 5,
    maxQuickDisconnectCount: 3,
    rateLimitDelayMs: 60,
    sendStartupGreeting: (_ctx, event) => { events.push(`greeting:${event}`); },
    startWebhookTransport: async (params) => {
      events.push(`webhook:${params.account.accountId}`);
      params.startMessageProcessor();
      await params.dispatchInboundEvent("INTERACTION_CREATE", { id: "EVT" });
      params.markFirstReadyConsumed();
      params.sendStartupGreeting("READY");
      params.onReady?.({ transport: "webhook" });
      params.unregisterApprovalHandler(params.account.accountId);
      return { action: "completed" } as any;
    },
  });

  assert.deepEqual(result, { transport: "webhook", result: { action: "completed" } });
  assert.deepEqual(events, [
    "connecting:false",
    "webhook:default",
    "start-processor",
    "handle:MSG",
    "dispatch:INTERACTION_CREATE:EVT",
    "ready-consumed",
    "greeting:READY",
    "ready:webhook",
    "unregister:default",
  ]);
}

{
  const events: string[] = [];
  const result = await startQQBotGatewayTransportRunner({
    account,
    abortSignal: {} as AbortSignal,
    transportMode: "websocket",
    lifecycle: createLifecycle(events),
    messageQueue: {
      startProcessor: (handler) => {
        events.push("start-processor");
        void handler(message);
      },
    } as any,
    handleMessage: async (queued) => { events.push(`handle:${queued.messageId}`); },
    dispatchInboundEvent: (eventType, data) => { events.push(`dispatch:${eventType}:${(data as any).id}`); },
    adminContext: { accountId: "default", appId: "APP", clientSecret: "SECRET" },
    isPendingFirstReady: () => true,
    markFirstReadyConsumed: () => { events.push("ready-consumed"); },
    unregisterApprovalHandler: () => {},
    scheduleReconnect: (delay) => { events.push(`reconnect:${delay}`); },
    onReady: (payload) => { events.push(`ready:${(payload as any).transport}`); },
    onError: (error) => { events.push(`error:${error.message}`); },
    intents: 123,
    intentsDesc: "full",
    quickDisconnectThresholdMs: 5,
    maxQuickDisconnectCount: 3,
    rateLimitDelayMs: 60,
    sendStartupGreeting: (_ctx, event) => { events.push(`greeting:${event}`); },
    startWebSocketConnection: async (params) => {
      events.push(`ws-start:${params.accountId}:${params.intents}:${params.intentsDesc}`);
      assert.equal(params.appId, "APP");
      assert.equal(params.clientSecret, "SECRET");
      assert.equal(params.quickDisconnectThresholdMs, 5);
      assert.equal(params.maxQuickDisconnectCount, 3);
      assert.equal(params.rateLimitDelayMs, 60);
      params.setConnecting(false);
      params.startMessageProcessor();
      params.markFirstReadyConsumed();
      params.sendStartupGreeting("RESUMED");
      params.onReady?.({ transport: "websocket" });
      await params.dispatchInboundEvent("GROUP_MESSAGE_CREATE", { id: "EVT" });
      params.scheduleReconnect(250);
      return { action: "started", accessToken: "TOKEN", gatewayUrl: "wss://gateway", ws: {} } as any;
    },
  });

  assert.equal(result.transport, "websocket");
  assert.deepEqual(events, [
    "ws-start:default:123:full",
    "connecting:false",
    "start-processor",
    "handle:MSG",
    "ready-consumed",
    "greeting:RESUMED",
    "ready:websocket",
    "dispatch:GROUP_MESSAGE_CREATE:EVT",
    "reconnect:250",
  ]);
}

console.log("custom gateway transport runner gateway adapter tests passed");
