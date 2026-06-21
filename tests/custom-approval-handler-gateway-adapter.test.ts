import assert from "node:assert";
import { startQQBotApprovalHandlerGateway } from "../src/custom/approval-handler-gateway-adapter.js";

{
  const events: string[] = [];
  const errors: string[] = [];
  const handle = startQQBotApprovalHandlerGateway({
    account: {
      accountId: "default",
      appId: "APP",
      clientSecret: "SECRET",
    },
    cfg: { enabled: true },
    log: {
      error: (message) => { errors.push(message); },
    },
    createHandler: (opts) => {
      events.push(`create:${opts.accountId}:${opts.appId}:${opts.clientSecret}`);
      return {
        start: async () => { events.push("start"); },
        stop: async () => { events.push("stop"); },
      };
    },
    registerApprovalHandler: (accountId, handler) => {
      assert.equal(typeof handler.start, "function");
      events.push(`register:${accountId}`);
    },
    unregisterApprovalHandler: (accountId) => {
      events.push(`unregister:${accountId}`);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await handle.stop();
  await handle.stop();
  handle.unregister();
  handle.unregister();

  assert.deepEqual(events, [
    "create:default:APP:SECRET",
    "register:default",
    "start",
    "stop",
    "unregister:default",
  ]);
  assert.deepEqual(errors, []);
}

{
  const events: string[] = [];
  const errors: string[] = [];
  const handle = startQQBotApprovalHandlerGateway({
    account: {
      accountId: "default",
      appId: "APP",
      clientSecret: "SECRET",
    },
    cfg: {},
    log: {
      error: (message) => { errors.push(message); },
    },
    createHandler: () => ({
      start: async () => { throw new Error("boom"); },
      stop: async () => { events.push("stop"); },
    }),
    registerApprovalHandler: (accountId) => { events.push(`register:${accountId}`); },
    unregisterApprovalHandler: (accountId) => { events.push(`unregister:${accountId}`); },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  handle.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  handle.dispose();

  assert.equal(errors.some((line) => line.includes("approval-handler: uncaught start error: Error: boom")), true);
  assert.deepEqual(events, ["register:default", "stop", "unregister:default"]);
}

console.log("custom approval handler gateway adapter tests passed");
