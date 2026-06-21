import assert from "node:assert";
import {
  registerQQBotGatewayAbortCleanup,
  runQQBotGatewayAbortCleanup,
} from "../src/custom/gateway-abort-cleanup-gateway-adapter.js";

function baseParams(events: string[], overrides: Record<string, unknown> = {}) {
  return {
    account: { accountId: "default", appId: "APP" },
    customState: { persistAllState: () => { events.push("persist-custom-state"); } },
    updateCheck: { stop: () => { events.push("stop-update-check"); } },
    approvalHandler: { dispose: () => { events.push("dispose-approval-handler"); } },
    stopBackgroundTokenRefresh: (appId: string) => { events.push(`stop-token:${appId}`); },
    flushKnownUsers: () => { events.push("flush-known-users"); },
    flushRefIndex: () => { events.push("flush-ref-index"); },
    log: { error: (message: string) => { events.push(`log:${message}`); } },
    ...overrides,
  } as any;
}

{
  const events: string[] = [];
  const results = runQQBotGatewayAbortCleanup(baseParams(events));
  assert.deepEqual(events, [
    "stop-token:APP",
    "flush-known-users",
    "flush-ref-index",
    "persist-custom-state",
    "stop-update-check",
    "dispose-approval-handler",
  ]);
  assert.deepEqual(results.map((result) => `${result.step}:${result.status}`), [
    "stop-background-token-refresh:completed",
    "flush-known-users:completed",
    "flush-ref-index:completed",
    "persist-custom-state:completed",
    "stop-update-check:completed",
    "dispose-approval-handler:completed",
  ]);
}

{
  const events: string[] = [];
  const results = runQQBotGatewayAbortCleanup(baseParams(events, {
    flushKnownUsers: () => {
      events.push("flush-known-users");
      throw new Error("known failed");
    },
    customState: {
      persistAllState: () => {
        events.push("persist-custom-state");
        throw new Error("persist failed");
      },
    },
  }));
  assert.deepEqual(events, [
    "stop-token:APP",
    "flush-known-users",
    "log:[qqbot:default] abort cleanup failed at flush-known-users: known failed",
    "flush-ref-index",
    "persist-custom-state",
    "log:[qqbot:default] abort cleanup failed at persist-custom-state: persist failed",
    "stop-update-check",
    "dispose-approval-handler",
  ]);
  assert.deepEqual(results.map((result) => `${result.step}:${result.status}`), [
    "stop-background-token-refresh:completed",
    "flush-known-users:failed",
    "flush-ref-index:completed",
    "persist-custom-state:failed",
    "stop-update-check:completed",
    "dispose-approval-handler:completed",
  ]);
}

{
  const events: string[] = [];
  let registered: (() => void) | undefined;
  const lifecycle = {
    registerAbort: (signal: AbortSignal, onAbort: () => void) => {
      events.push(`register:${Boolean(signal)}`);
      registered = onAbort;
    },
  };
  const abortSignal = {} as AbortSignal;
  registerQQBotGatewayAbortCleanup({
    ...baseParams(events),
    abortSignal,
    lifecycle,
  });
  assert.deepEqual(events, ["register:true"]);
  registered?.();
  assert.deepEqual(events, [
    "register:true",
    "stop-token:APP",
    "flush-known-users",
    "flush-ref-index",
    "persist-custom-state",
    "stop-update-check",
    "dispose-approval-handler",
  ]);
}

console.log("custom gateway abort cleanup gateway adapter tests passed");
