import assert from "node:assert";
import { handleQQBotWebSocketMessageGateway } from "../src/custom/websocket-message-gateway-adapter.js";

function createHarness(initial?: { sessionId?: string | null; lastSeq?: number | null; lastConnectTime?: number; pendingFirstReady?: boolean }) {
  let sessionId = initial?.sessionId ?? null;
  let lastSeq = initial?.lastSeq ?? null;
  let lastConnectTime = initial?.lastConnectTime ?? 500;
  let pendingFirstReady = initial?.pendingFirstReady ?? true;
  let shouldRefreshToken = false;
  let heartbeat: (() => void) | null = null;
  const sent: unknown[] = [];
  const saved: unknown[] = [];
  const cleared: string[] = [];
  const ready: unknown[] = [];
  const greetings: string[] = [];
  const inbound: Array<{ eventType: string; data: unknown }> = [];
  const reconnects: Array<number | undefined> = [];
  const logs: string[] = [];
  let cleanupCalls = 0;

  const params = {
    accountId: "default",
    appId: "APP",
    accessToken: "TOKEN",
    intents: 123,
    intentsDesc: "full",
    rawData: "",
    getSessionState: () => ({ sessionId, lastSeq, lastConnectTime }),
    setLastSeq: (next: number | null) => { lastSeq = next; },
    setSessionId: (next: string | null) => { sessionId = next; },
    setShouldRefreshToken: (next: boolean) => { shouldRefreshToken = next; },
    saveSession: (input: unknown) => { saved.push(input); },
    clearSession: (accountId: string) => { cleared.push(accountId); },
    sendJson: (payload: unknown) => { sent.push(payload); },
    resetHeartbeat: (_intervalMs: number, onHeartbeat: () => void) => { heartbeat = onHeartbeat; },
    isPendingFirstReady: () => pendingFirstReady,
    markFirstReadyConsumed: () => { pendingFirstReady = false; },
    onReady: (data: unknown) => { ready.push(data); },
    sendStartupGreeting: (event: "READY" | "RESUMED") => { greetings.push(event); },
    dispatchInboundEvent: (eventType: string, data: unknown) => { inbound.push({ eventType, data }); },
    cleanup: () => { cleanupCalls += 1; },
    scheduleReconnect: (delayMs?: number) => { reconnects.push(delayMs); },
    now: () => 1000,
    log: {
      info: (msg: string) => logs.push(`info:${msg}`),
      debug: (msg: string) => logs.push(`debug:${msg}`),
      error: (msg: string) => logs.push(`error:${msg}`),
    },
  };

  return {
    params,
    state: () => ({ sessionId, lastSeq, lastConnectTime, pendingFirstReady, shouldRefreshToken, cleanupCalls }),
    sent,
    saved,
    cleared,
    ready,
    greetings,
    inbound,
    reconnects,
    logs,
    runHeartbeat: () => heartbeat?.(),
  };
}

{
  const h = createHarness();
  const result = await handleQQBotWebSocketMessageGateway({
    ...h.params,
    rawData: JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }),
  });
  assert.deepEqual(result, { kind: "hello" });
  assert.deepEqual(h.sent[0], {
    op: 2,
    d: { token: "QQBot TOKEN", intents: 123, shard: [0, 1] },
  });
  h.runHeartbeat();
  assert.deepEqual(h.sent[1], { op: 1, d: null });
  assert.equal(h.logs.some((line) => line.includes("Hello received")), true);
}

{
  const h = createHarness({ sessionId: "SESSION_ID", lastSeq: 42 });
  await handleQQBotWebSocketMessageGateway({
    ...h.params,
    rawData: JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }),
  });
  assert.deepEqual(h.sent[0], {
    op: 6,
    d: { token: "QQBot TOKEN", session_id: "SESSION_ID", seq: 42 },
  });
}

{
  const h = createHarness({ pendingFirstReady: true });
  const result = await handleQQBotWebSocketMessageGateway({
    ...h.params,
    rawData: JSON.stringify({ op: 0, t: "READY", s: 10, d: { session_id: "NEW_SESSION" } }),
  });
  assert.deepEqual(result, { kind: "dispatch-ready", sessionId: "NEW_SESSION" });
  assert.equal(h.state().sessionId, "NEW_SESSION");
  assert.equal(h.state().lastSeq, 10);
  assert.deepEqual(h.ready, [{ session_id: "NEW_SESSION" }]);
  assert.deepEqual(h.greetings, ["READY"]);
  assert.equal(h.state().pendingFirstReady, false);
  assert.equal((h.saved.at(-1) as any).sessionId, "NEW_SESSION");
  assert.equal((h.saved.at(-1) as any).lastSeq, 10);
}

{
  const h = createHarness({ sessionId: "SESSION_ID", lastSeq: 20, pendingFirstReady: true });
  const result = await handleQQBotWebSocketMessageGateway({
    ...h.params,
    rawData: JSON.stringify({ op: 0, t: "RESUMED", d: {} }),
  });
  assert.deepEqual(result, { kind: "dispatch-resumed" });
  assert.deepEqual(h.greetings, ["RESUMED"]);
  assert.equal((h.saved.at(-1) as any).sessionId, "SESSION_ID");
}

{
  const h = createHarness({ pendingFirstReady: false });
  const result = await handleQQBotWebSocketMessageGateway({
    ...h.params,
    rawData: JSON.stringify({ op: 0, t: "GROUP_MESSAGE_CREATE", d: { id: "msg" } }),
  });
  assert.deepEqual(result, { kind: "dispatch-event", eventType: "GROUP_MESSAGE_CREATE" });
  assert.deepEqual(h.inbound, [{ eventType: "GROUP_MESSAGE_CREATE", data: { id: "msg" } }]);
  assert.deepEqual(h.greetings, []);
}

{
  const h = createHarness({ sessionId: "BAD_SESSION", lastSeq: 99 });
  const result = await handleQQBotWebSocketMessageGateway({
    ...h.params,
    rawData: JSON.stringify({ op: 9, d: false }),
  });
  assert.deepEqual(result, { kind: "invalid-session" });
  assert.equal(h.state().sessionId, null);
  assert.equal(h.state().lastSeq, null);
  assert.equal(h.state().shouldRefreshToken, true);
  assert.deepEqual(h.cleared, ["default"]);
  assert.equal(h.state().cleanupCalls, 1);
  assert.deepEqual(h.reconnects, [3000]);
}

{
  const h = createHarness();
  const result = await handleQQBotWebSocketMessageGateway({
    ...h.params,
    rawData: "not json",
  });
  assert.equal(result.kind, "parse-error");
  assert.equal(h.logs.some((line) => line.includes("Message parse error")), true);
}

console.log("custom websocket message gateway adapter tests passed");
