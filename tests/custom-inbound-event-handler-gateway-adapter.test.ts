import assert from "node:assert";
import { createCustomInboundEventHandlerGateway } from "../src/custom/inbound-event-handler-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

{
  const knownUsers: unknown[] = [];
  const enqueued: QueuedMessage[] = [];
  const acceptances: unknown[] = [];
  const logs: string[] = [];
  let persistCount = 0;

  const handler = createCustomInboundEventHandlerGateway({
    accountId: "default",
    runtime: {
      proactiveBudget: {
        setAcceptance: (acceptance: unknown) => { acceptances.push(acceptance); },
      } as any,
    },
    recordKnownUser: (user) => { knownUsers.push(user); },
    enqueueMessage: async (message) => { enqueued.push(message); },
    persistProactiveBudgetState: () => { persistCount += 1; },
    handleInteraction: async () => {},
    log: {
      info: (message) => { logs.push(message); },
      error: (message) => { logs.push(message); },
    },
  });

  const messageResult = await handler("C2C_MESSAGE_CREATE", {
    id: "MSG_C2C",
    content: "hello",
    timestamp: "2026-06-22T00:00:00.000Z",
    author: { user_openid: "USER_OPENID" },
  });

  assert.deepEqual(messageResult, { kind: "message", knownUsers: 1 });
  assert.equal((knownUsers.at(-1) as any)?.openid, "USER_OPENID");
  assert.equal(enqueued.at(-1)?.type, "c2c");

  const acceptanceResult = await handler("GROUP_MSG_REJECT", {
    timestamp: 2_000,
    group_openid: "GROUP_OPENID",
    op_member_openid: "MEMBER_OPENID",
  });

  assert.deepEqual(acceptanceResult, { kind: "proactive-acceptance", accepted: false });
  assert.equal((acceptances.at(-1) as any)?.peer.id, "GROUP_OPENID");
  assert.equal((acceptances.at(-1) as any)?.accepted, false);
  assert.equal((acceptances.at(-1) as any)?.updatedBy, "MEMBER_OPENID");
  assert.equal(persistCount, 1);
  assert.equal(logs.some((line) => line.includes("rejected bot proactive messages")), true);
}

{
  const calls: unknown[] = [];
  const handler = createCustomInboundEventHandlerGateway({
    accountId: "default",
    runtime: { proactiveBudget: { setAcceptance: () => {} } as any },
    enqueueMessage: async () => {},
    persistProactiveBudgetState: () => {},
    handleInteraction: async () => {},
    dispatchInboundEvent: async (params) => {
      calls.push(params);
      params.setProactiveAcceptance({
        accountId: params.accountId,
        peer: { kind: "c2c", id: "USER_OPENID" },
        accepted: true,
        now: 1,
      });
      return { kind: "unsupported" } as any;
    },
  });

  const result = await handler("UNKNOWN", { raw: true });
  assert.deepEqual(result, { kind: "unsupported" });
  assert.equal((calls.at(-1) as any)?.eventType, "UNKNOWN");
  assert.deepEqual((calls.at(-1) as any)?.data, { raw: true });
}

console.log("custom inbound event handler gateway adapter tests passed");
