import assert from "node:assert";
import {
  handleQQBotWebSocketCloseGateway,
  handleQQBotWebSocketConnectionFailureGateway,
} from "../src/custom/websocket-close-gateway-adapter.js";

function createHarness() {
  let sessionId: string | null = "SESSION_ID";
  let lastSeq: number | null = 42;
  let shouldRefreshToken = false;
  let quickDisconnectCount = 0;
  let cleanupCalls = 0;
  const cleared: string[] = [];
  const reconnects: Array<number | undefined> = [];
  const logs: string[] = [];

  const baseParams = {
    accountId: "default",
    isAborted: false,
    lastConnectTime: 10_000,
    quickDisconnectCount,
    quickDisconnectThresholdMs: 5_000,
    maxQuickDisconnectCount: 3,
    rateLimitDelayMs: 60_000,
    setSessionId: (next: string | null) => { sessionId = next; },
    setLastSeq: (next: number | null) => { lastSeq = next; },
    setShouldRefreshToken: (next: boolean) => { shouldRefreshToken = next; },
    setQuickDisconnectCount: (next: number) => { quickDisconnectCount = next; },
    clearSession: (accountId: string) => { cleared.push(accountId); },
    cleanup: () => { cleanupCalls += 1; },
    scheduleReconnect: (delayMs?: number) => { reconnects.push(delayMs); },
    now: 20_000,
    log: {
      info: (msg: string) => logs.push(`info:${msg}`),
      error: (msg: string) => logs.push(`error:${msg}`),
    },
  };

  return {
    baseParams,
    state: () => ({ sessionId, lastSeq, shouldRefreshToken, quickDisconnectCount, cleanupCalls }),
    cleared,
    reconnects,
    logs,
  };
}

{
  const h = createHarness();
  const result = handleQQBotWebSocketCloseGateway({
    ...h.baseParams,
    code: 4004,
    reason: "invalid token",
  });
  assert.equal(result.shouldRefreshToken, true);
  assert.equal(h.state().shouldRefreshToken, true);
  assert.equal(h.state().sessionId, "SESSION_ID");
  assert.equal(h.state().cleanupCalls, 1);
  assert.deepEqual(h.reconnects, [undefined]);
  assert.equal(h.logs.some((line) => line.includes("WebSocket closed: 4004 invalid token")), true);
}

{
  const h = createHarness();
  const result = handleQQBotWebSocketCloseGateway({
    ...h.baseParams,
    code: 4007,
    reason: "invalid seq",
  });
  assert.equal(result.shouldClearSession, true);
  assert.equal(result.shouldRefreshToken, true);
  assert.equal(h.state().sessionId, null);
  assert.equal(h.state().lastSeq, null);
  assert.equal(h.state().shouldRefreshToken, true);
  assert.deepEqual(h.cleared, ["default"]);
  assert.deepEqual(h.reconnects, [undefined]);
}

{
  const h = createHarness();
  const result = handleQQBotWebSocketCloseGateway({
    ...h.baseParams,
    code: 4008,
    reason: "rate limited",
  });
  assert.equal(result.reconnectDelayMs, 60_000);
  assert.deepEqual(h.reconnects, [60_000]);
  assert.equal(h.state().shouldRefreshToken, false);
}

{
  const h = createHarness();
  const result = handleQQBotWebSocketCloseGateway({
    ...h.baseParams,
    code: 4914,
    reason: "offline",
  });
  assert.equal(result.reconnectScheduled, false);
  assert.equal(h.reconnects.length, 0);
  assert.equal(h.state().cleanupCalls, 1);
  assert.equal(h.logs.some((line) => line.includes("offline/sandbox-only")), true);
}

{
  const h = createHarness();
  const result = handleQQBotWebSocketCloseGateway({
    ...h.baseParams,
    code: 4006,
    reason: "quick",
    quickDisconnectCount: 2,
    now: 11_000,
  });
  assert.equal(result.nextQuickDisconnectCount, 0);
  assert.equal(result.reconnectDelayMs, 60_000);
  assert.equal(h.state().quickDisconnectCount, 0);
  assert.deepEqual(h.reconnects, [60_000]);
}

{
  const reconnects: Array<number | undefined> = [];
  const logs: string[] = [];
  const result = handleQQBotWebSocketConnectionFailureGateway({
    accountId: "default",
    err: new Error("Too many requests"),
    rateLimitDelayMs: 60_000,
    scheduleReconnect: (delayMs) => reconnects.push(delayMs),
    log: {
      info: (msg) => logs.push(`info:${msg}`),
      error: (msg) => logs.push(`error:${msg}`),
    },
  });
  assert.deepEqual(result, { reconnectDelayMs: 60_000, rateLimited: true });
  assert.deepEqual(reconnects, [60_000]);
  assert.equal(logs.some((line) => line.includes("Rate limited")), true);
}

{
  const reconnects: Array<number | undefined> = [];
  const result = handleQQBotWebSocketConnectionFailureGateway({
    accountId: "default",
    err: new Error("ECONNRESET"),
    rateLimitDelayMs: 60_000,
    scheduleReconnect: (delayMs) => reconnects.push(delayMs),
  });
  assert.deepEqual(result, { rateLimited: false });
  assert.deepEqual(reconnects, [undefined]);
}

console.log("custom websocket close gateway adapter tests passed");
