import assert from "node:assert";
import {
  isQQBotGatewayWebSocketClosable,
  startQQBotWebSocketConnectionGateway,
  type QQBotGatewayWebSocketLike,
} from "../src/custom/websocket-connection-gateway-adapter.js";

class FakeWebSocket implements QQBotGatewayWebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private handlers = new Map<string, Array<(...args: any[]) => unknown>>();

  on(event: string, listener: (...args: any[]) => void): unknown {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  async emit(event: string, ...args: unknown[]): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(...args);
    }
  }
}

function baseParams(fake: FakeWebSocket) {
  let currentWs: QQBotGatewayWebSocketLike | null = null;
  return {
    accountId: "default",
    appId: "APP",
    clientSecret: "SECRET",
    intents: 123,
    intentsDesc: "full",
    isAborted: () => false,
    getSessionState: () => ({ sessionId: null, lastSeq: null, lastConnectTime: 0 }),
    setLastSeq: () => {},
    setSessionId: () => {},
    setShouldRefreshToken: () => {},
    setCurrentWebSocket: (ws: QQBotGatewayWebSocketLike | null) => { currentWs = ws; },
    setConnecting: () => {},
    setReconnectAttempts: () => {},
    setLastConnectTime: () => {},
    getLastConnectTime: () => 0,
    getQuickDisconnectCount: () => 0,
    setQuickDisconnectCount: () => {},
    quickDisconnectThresholdMs: 5_000,
    maxQuickDisconnectCount: 3,
    rateLimitDelayMs: 60_000,
    startMessageProcessor: () => {},
    resetHeartbeat: () => {},
    isPendingFirstReady: () => true,
    markFirstReadyConsumed: () => {},
    sendStartupGreeting: () => {},
    dispatchInboundEvent: () => {},
    cleanup: () => {},
    scheduleReconnect: () => {},
    getAccessToken: async () => "ACCESS_TOKEN",
    getGatewayUrl: async (token: string) => {
      assert.equal(token, "ACCESS_TOKEN");
      return "wss://gateway.example";
    },
    getPluginUserAgent: () => "qqbot-test-agent",
    createWebSocket: (url: string, options: { headers: Record<string, string> }) => {
      assert.equal(url, "wss://gateway.example");
      assert.equal(options.headers["User-Agent"], "qqbot-test-agent");
      return fake;
    },
    startBackgroundTokenRefresh: () => {},
    handleWebSocketMessage: async () => ({ kind: "ignored", op: 99 }) as any,
    handleWebSocketClose: () => ({
      shouldRefreshToken: false,
      shouldClearSession: false,
      nextQuickDisconnectCount: 0,
      cleanupCalled: false,
      reconnectScheduled: false,
    }),
    handleWebSocketConnectionFailure: () => ({ rateLimited: false }),
    get currentWs() {
      return currentWs;
    },
  };
}

{
  const fake = new FakeWebSocket();
  let connecting = true;
  let reconnectAttempts = 2;
  let lastConnectTime = 0;
  let processorStarted = false;
  let tokenRefreshStarted = false;
  const params = Object.assign(baseParams(fake), {
    setConnecting: (value: boolean) => { connecting = value; },
    setReconnectAttempts: (value: number) => { reconnectAttempts = value; },
    setLastConnectTime: (value: number) => { lastConnectTime = value; },
    startMessageProcessor: () => { processorStarted = true; },
    startBackgroundTokenRefresh: (appId: string, clientSecret: string) => {
      tokenRefreshStarted = true;
      assert.equal(appId, "APP");
      assert.equal(clientSecret, "SECRET");
    },
    now: () => 12_345,
  });

  const result = await startQQBotWebSocketConnectionGateway(params);
  assert.equal(result.action, "started");
  assert.equal(params.currentWs, fake);
  fake.readyState = 1;
  await fake.emit("open");
  assert.equal(connecting, false);
  assert.equal(reconnectAttempts, 0);
  assert.equal(lastConnectTime, 12_345);
  assert.equal(processorStarted, true);
  assert.equal(tokenRefreshStarted, true);
  assert.equal(isQQBotGatewayWebSocketClosable(fake), true);
}

{
  const fake = new FakeWebSocket();
  let rawData = "";
  let heartbeatOpen = false;
  const params = {
    ...baseParams(fake),
    resetHeartbeat: (_intervalMs: number, onHeartbeat: () => void, isSocketOpen: () => boolean) => {
      heartbeatOpen = isSocketOpen();
      onHeartbeat();
    },
    handleWebSocketMessage: async (input: any) => {
      rawData = input.rawData;
      input.sendJson({ op: 1 });
      input.resetHeartbeat(100, () => input.sendJson({ op: 2 }));
      return { kind: "hello" };
    },
  };

  await startQQBotWebSocketConnectionGateway(params);
  fake.readyState = 1;
  await fake.emit("message", Buffer.from("payload"));
  assert.equal(rawData, "payload");
  assert.equal(heartbeatOpen, true);
  assert.deepEqual(fake.sent, [JSON.stringify({ op: 1 }), JSON.stringify({ op: 2 })]);
}

{
  const fake = new FakeWebSocket();
  let connecting = true;
  let closeCode = 0;
  let closeReason = "";
  let closeLastConnectTime = 0;
  let quickCount = 0;
  const params = {
    ...baseParams(fake),
    setConnecting: (value: boolean) => { connecting = value; },
    getLastConnectTime: () => 99_999,
    getQuickDisconnectCount: () => 7,
    handleWebSocketClose: (input: any) => {
      closeCode = input.code;
      closeReason = input.reason;
      closeLastConnectTime = input.lastConnectTime;
      quickCount = input.quickDisconnectCount;
      return {
        shouldRefreshToken: false,
        shouldClearSession: false,
        nextQuickDisconnectCount: quickCount,
        cleanupCalled: false,
        reconnectScheduled: false,
      };
    },
  };

  await startQQBotWebSocketConnectionGateway(params);
  await fake.emit("close", 4009, Buffer.from("session timeout"));
  assert.equal(connecting, false);
  assert.equal(closeCode, 4009);
  assert.equal(closeReason, "session timeout");
  assert.equal(closeLastConnectTime, 99_999);
  assert.equal(quickCount, 7);
}

console.log("custom websocket connection gateway adapter tests passed");
