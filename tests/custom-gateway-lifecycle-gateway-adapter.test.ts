import assert from "node:assert";
import { createQQBotGatewayLifecycle } from "../src/custom/gateway-lifecycle-gateway-adapter.js";
import type { QQBotGatewayWebSocketLike } from "../src/custom/websocket-connection-gateway-adapter.js";

class FakeWebSocket implements QQBotGatewayWebSocketLike {
  readyState = 1;
  closed = false;
  sent: string[] = [];
  on(): unknown { return this; }
  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

{
  const logs: string[] = [];
  const lifecycle = createQQBotGatewayLifecycle({
    accountId: "default",
    reconnectDelays: [10, 20],
    maxReconnectAttempts: 3,
    isWebSocketClosable: (ws) => ws.readyState === 1,
    log: {
      info: (msg) => logs.push(`info:${msg}`),
      error: (msg) => logs.push(`error:${msg}`),
      debug: (msg) => logs.push(`debug:${msg}`),
    },
  });

  lifecycle.restoreSession({ sessionId: "session-1", lastSeq: 42 });
  assert.deepEqual(lifecycle.getSessionState(), {
    sessionId: "session-1",
    lastSeq: 42,
    lastConnectTime: 0,
  });
  assert.equal(logs.some((line) => line.includes("Restored session")), true);

  assert.equal(lifecycle.beginConnect(), true);
  assert.equal(lifecycle.beginConnect(), false);
  assert.equal(logs.some((line) => line.includes("Already connecting")), true);
}

{
  let disposed = 0;
  let clearedToken = 0;
  let intervalCleared = 0;
  let intervalCallback: (() => void) | null = null;
  const ws = new FakeWebSocket();
  const lifecycle = createQQBotGatewayLifecycle({
    accountId: "default",
    reconnectDelays: [10],
    maxReconnectAttempts: 1,
    isWebSocketClosable: () => true,
    disposeRuntimeServices: () => { disposed += 1; },
    setIntervalFn: (callback) => {
      intervalCallback = callback;
      return { timer: "interval" } as any;
    },
    clearIntervalFn: () => { intervalCleared += 1; },
  });

  let heartbeats = 0;
  lifecycle.setCurrentWebSocket(ws);
  lifecycle.setShouldRefreshToken(true);
  lifecycle.resetHeartbeat(100, () => { heartbeats += 1; }, () => true);
  intervalCallback?.();
  assert.equal(heartbeats, 1);

  lifecycle.prepareConnection({ clearTokenCache: () => { clearedToken += 1; } });
  assert.equal(disposed, 1);
  assert.equal(intervalCleared, 1);
  assert.equal(ws.closed, true);
  assert.equal(clearedToken, 1);
  assert.equal(lifecycle.snapshot().shouldRefreshToken, false);
}

{
  let timeoutCallback: (() => void) | null = null;
  let timeoutCleared = 0;
  let connectCalls = 0;
  const lifecycle = createQQBotGatewayLifecycle({
    accountId: "default",
    reconnectDelays: [10, 20],
    maxReconnectAttempts: 2,
    isWebSocketClosable: () => false,
    setTimeoutFn: (callback, delayMs) => {
      timeoutCallback = callback;
      return { delayMs } as any;
    },
    clearTimeoutFn: () => { timeoutCleared += 1; },
  });

  lifecycle.scheduleReconnect(() => { connectCalls += 1; });
  assert.equal(lifecycle.snapshot().reconnectAttempts, 1);
  assert.equal(lifecycle.snapshot().reconnectTimerActive, true);
  lifecycle.scheduleReconnect(() => { connectCalls += 1; }, 99);
  assert.equal(timeoutCleared, 1);
  assert.equal(lifecycle.snapshot().reconnectAttempts, 2);
  timeoutCallback?.();
  assert.equal(connectCalls, 1);
  assert.equal(lifecycle.snapshot().reconnectTimerActive, false);
  lifecycle.scheduleReconnect(() => { connectCalls += 1; });
  assert.equal(connectCalls, 1);
}

{
  const abortController = new AbortController();
  let aborted = 0;
  let timeoutCleared = 0;
  const ws = new FakeWebSocket();
  const lifecycle = createQQBotGatewayLifecycle({
    accountId: "default",
    reconnectDelays: [10],
    maxReconnectAttempts: 3,
    isWebSocketClosable: () => true,
    setTimeoutFn: (callback) => ({ callback }) as any,
    clearTimeoutFn: () => { timeoutCleared += 1; },
  });
  lifecycle.setCurrentWebSocket(ws);
  lifecycle.scheduleReconnect(() => {});
  lifecycle.registerAbort(abortController.signal, () => { aborted += 1; });
  abortController.abort();
  assert.equal(aborted, 1);
  assert.equal(timeoutCleared, 1);
  assert.equal(ws.closed, true);
  assert.equal(lifecycle.isAborted(), true);
  assert.equal(lifecycle.snapshot().reconnectTimerActive, false);
}

console.log("custom gateway lifecycle gateway adapter tests passed");
