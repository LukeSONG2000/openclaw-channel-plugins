import assert from "node:assert";
import { startQQBotWebhookTransportGateway } from "../src/custom/webhook-transport-gateway-adapter.js";

{
  const abortController = new AbortController();
  const events: string[] = [];
  const dispatched: Array<{ eventType: string; data: unknown }> = [];
  const readyPayloads: unknown[] = [];
  const errors: string[] = [];

  const result = await startQQBotWebhookTransportGateway({
    account: {
      accountId: "default",
      appId: "APP",
      clientSecret: "SECRET",
      config: { webhook: { path: "/qqbot/custom" } },
    } as any,
    abortSignal: abortController.signal,
    startMessageProcessor: () => { events.push("processor"); },
    dispatchInboundEvent: (eventType, data) => {
      dispatched.push({ eventType, data });
    },
    onReady: (payload) => { readyPayloads.push(payload); },
    onError: (error) => { errors.push(error.message); },
    isPendingFirstReady: () => true,
    markFirstReadyConsumed: () => { events.push("first-ready-consumed"); },
    sendStartupGreeting: (event) => { events.push(`greeting:${event}`); },
    unregisterApprovalHandler: (accountId) => { events.push(`unregister:${accountId}`); },
    startBackgroundTokenRefresh: (appId, clientSecret) => {
      events.push(`refresh:${appId}:${clientSecret}`);
    },
    stopBackgroundTokenRefresh: () => { events.push("stop-refresh"); },
    startWebhookTransport: async (params) => {
      events.push(`transport:${params.account.accountId}:${params.account.config.webhook?.path}`);
      await params.onEvent({ eventType: "GROUP_AT_MESSAGE_CREATE", data: { id: "msg-1" } });
      params.onReady?.();
      params.onError?.(new Error("webhook-failed"));
    },
  });

  assert.deepEqual(result, { action: "completed" });
  assert.deepEqual(dispatched, [{ eventType: "GROUP_AT_MESSAGE_CREATE", data: { id: "msg-1" } }]);
  assert.deepEqual(readyPayloads, [{ transport: "webhook" }]);
  assert.deepEqual(errors, ["webhook-failed"]);
  assert.deepEqual(events, [
    "processor",
    "refresh:APP:SECRET",
    "transport:default:/qqbot/custom",
    "first-ready-consumed",
    "greeting:READY",
    "stop-refresh",
    "unregister:default",
  ]);
}

console.log("custom webhook transport gateway adapter tests passed");
