import assert from "node:assert";
import { createCustomDispatchFallbackSession } from "../src/custom/dispatch-fallback-session-gateway-adapter.js";
import type { CustomToolOnlyTimerHandle } from "../src/custom/tool-deliver-gateway-adapter.js";

const message = {
  type: "group",
  senderId: "MEMBER_OPENID",
  content: "hello",
  messageId: "MSG_ID",
  timestamp: "2026-06-22T00:00:00.000Z",
  groupOpenid: "GROUP_OPENID",
} as any;

function makeSession(overrides: Record<string, unknown> = {}) {
  return createCustomDispatchFallbackSession({
    accountId: "default",
    message,
    sessionKey: "agent:main:qqbot:group:GROUP_OPENID",
    getRuntime: () => ({ enabled: true }),
    getQueueSnapshot: () => ({ peerId: "GROUP_OPENID" }) as any,
    sendGuardedMediaAuto: async () => ({ channel: "qqbot" }),
    sendErrorMessage: async () => {},
    ...overrides,
  });
}

{
  let scheduledCallback: (() => void) | null = null;
  const timer = { id: "response" } as unknown as CustomToolOnlyTimerHandle;
  const session = makeSession({
    responseTimeoutMs: 123,
    scheduleResponseTimeout: (callback: () => void, delayMs: number) => {
      assert.equal(delayMs, 123);
      scheduledCallback = callback;
      return timer;
    },
  });

  const timeoutPromise = session.createResponseTimeoutPromise();
  scheduledCallback?.();
  await assert.rejects(timeoutPromise, /Response timeout/);
  assert.equal(session.responseTimeoutMs, 123);
}

{
  let scheduledCallback: (() => void) | null = null;
  let cleared = 0;
  const timer = { id: "response" } as unknown as CustomToolOnlyTimerHandle;
  const session = makeSession({
    scheduleResponseTimeout: (callback: () => void) => {
      scheduledCallback = callback;
      return timer;
    },
    clearResponseTimeout: (handle: CustomToolOnlyTimerHandle) => {
      assert.equal(handle, timer);
      cleared += 1;
    },
  });

  const timeoutPromise = session.createResponseTimeoutPromise()
    .then(() => "resolved", () => "rejected");
  session.state.markBlockResponse();
  scheduledCallback?.();
  const result = await Promise.race([
    timeoutPromise,
    new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  assert.equal(result, "pending");
  session.clearResponseTimeout();
  session.clearResponseTimeout();
  assert.equal(cleared, 1);
}

{
  const session = makeSession({
    toolOnlyTimeoutMs: 456,
    maxToolRenewals: 7,
  });
  const timer = { id: "tool" } as unknown as CustomToolOnlyTimerHandle;
  assert.equal(session.toolOnlyTimeoutMs, 456);
  assert.equal(session.maxToolRenewals, 7);
  assert.equal(session.getToolOnlyTimer(), null);
  session.setToolOnlyTimer(timer);
  assert.equal(session.getToolOnlyTimer(), timer);
  session.setToolOnlyTimer(null);
  assert.equal(session.getToolOnlyTimer(), null);
}

{
  let fallbackCalled = 0;
  const session = makeSession({
    sendToolFallback: async (params: any) => {
      fallbackCalled += 1;
      assert.equal(params.accountId, "default");
      assert.equal(params.state, session.state);
      assert.equal(typeof params.recordFallbackEvent, "function");
      return { kind: "no-output" };
    },
  });

  await session.sendToolFallback();
  assert.equal(fallbackCalled, 1);
}

console.log("custom dispatch fallback session gateway adapter tests passed");
