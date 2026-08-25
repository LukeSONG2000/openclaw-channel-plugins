import assert from "node:assert";
import { registerQQBotGatewayUncaughtExceptionGuard, startQQBotGatewayStartup } from "../src/custom/gateway-startup-gateway-adapter.js";

function createAbortSignal() {
  let abortHandler: (() => void) | null = null;
  return {
    signal: {
      addEventListener: (_event: "abort", handler: () => void, options?: { once?: boolean }) => {
        assert.equal(options?.once, true);
        abortHandler = handler;
      },
    },
    abort: () => abortHandler?.(),
  };
}

function createProcessLike(events: string[]) {
  let currentHandler: ((err: Error) => void) | null = null;
  return {
    processLike: {
      on: (event: "uncaughtException", handler: (err: Error) => void) => {
        events.push(`on:${event}`);
        currentHandler = handler;
      },
      removeListener: (event: "uncaughtException", handler: (err: Error) => void) => {
        events.push(`remove:${event}:${handler === currentHandler}`);
        if (handler === currentHandler) currentHandler = null;
      },
    },
    emit: (err: Error) => currentHandler?.(err),
    hasHandler: () => Boolean(currentHandler),
  };
}

{
  const events: string[] = [];
  const logs: string[] = [];
  const abort = createAbortSignal();
  const process = createProcessLike(events);
  const session = {
    sessionId: "SESSION",
    lastSeq: 10,
    lastConnectedAt: 1,
    intentLevelIndex: 0,
    accountId: "default",
    savedAt: 1,
    appId: "APP",
  };

  const result = await startQQBotGatewayStartup({
    account: {
      accountId: "default",
      appId: "APP",
      clientSecret: "SECRET",
      config: { transport: "webhook" },
      markdownSupport: true,
    } as any,
    cfg: { channels: { qqbot: {} } },
    abortSignal: abort.signal,
    restoreSession: (loaded) => {
      assert.equal(loaded, session);
      events.push("restore-session");
    },
    markPendingFirstReady: () => { events.push("pending-ready"); },
    log: {
      info: (message) => { logs.push(message); },
      error: (message) => { logs.push(message); },
    },
    getRuntime: () => ({ runtime: true }),
    loadSession: (accountId, appId) => {
      events.push(`load-session:${accountId}:${appId}`);
      return session;
    },
    runStartupPreflight: async (params) => {
      events.push(`preflight:${params.account.accountId}:${Boolean(params.getRuntime())}`);
      assert.equal(params.account.markdownSupport, true);
      return { imageServerBaseUrl: null, hasTTS: false };
    },
    registerOutboundRefIndex: (params) => {
      events.push(`ref-index:${params.accountId}`);
      params.setRefEntry("REF", {
        content: "hello",
        senderId: "bot",
        timestamp: 1,
      });
    },
    setRefEntry: (refIdx, entry) => {
      events.push(`set-ref:${refIdx}:${entry.content}`);
    },
    processLike: process.processLike,
  });

  assert.equal(result.transportMode, "webhook");
  assert.deepEqual(result.adminContext, {
    accountId: "default",
    appId: "APP",
    clientSecret: "SECRET",
    log: result.adminContext.log,
  });
  assert.equal(logs.some((line) => line.includes("Using webhook transport mode")), true);
  process.emit(new Error("Unexpected server response: 403"));
  assert.equal(logs.some((line) => line.includes("Caught WS handshake error")), true);
  abort.abort();
  result.disposeProcessGuard();
  assert.equal(process.hasHandler(), false);
  assert.deepEqual(events, [
    "on:uncaughtException",
    "preflight:default:true",
    "ref-index:default",
    "set-ref:REF:hello",
    "pending-ready",
    "load-session:default:APP",
    "restore-session",
    "remove:uncaughtException:true",
  ]);
}

{
  const abort = createAbortSignal();
  await assert.rejects(
    startQQBotGatewayStartup({
      account: {
        accountId: "default",
        appId: "",
        clientSecret: "SECRET",
        config: {},
      } as any,
      cfg: {},
      abortSignal: abort.signal,
      restoreSession: () => {},
      markPendingFirstReady: () => {},
    }),
    /missing appId or clientSecret/,
  );
}

{
  const events: string[] = [];
  const logs: string[] = [];
  const abort = createAbortSignal();
  const process = createProcessLike(events);
  const dispose = registerQQBotGatewayUncaughtExceptionGuard({
    accountId: "default",
    abortSignal: abort.signal,
    log: { error: (message) => { logs.push(message); } },
    processLike: process.processLike,
  });
  assert.throws(() => process.emit(new Error("ordinary failure")), /ordinary failure/);
  dispose();
  abort.abort();
  assert.deepEqual(events, ["on:uncaughtException", "remove:uncaughtException:true"]);
  assert.deepEqual(logs, []);
}

console.log("custom gateway startup gateway adapter tests passed");
