import assert from "node:assert";
import { dispatchCustomInboundGatewayEvent } from "../src/custom/inbound-event-gateway-adapter.js";
import type { QueuedMessage } from "../src/message-queue.js";

const knownUsers: unknown[] = [];
const enqueued: QueuedMessage[] = [];
const acceptances: unknown[] = [];
const infoLogs: string[] = [];
const errorLogs: string[] = [];
let persistCount = 0;
const baseCallbacks = {
  recordKnownUser: (user: unknown) => { knownUsers.push(user); },
  enqueueMessage: async (message: QueuedMessage) => { enqueued.push(message); },
  setProactiveAcceptance: (acceptance: unknown) => { acceptances.push(acceptance); },
  persistProactiveBudgetState: () => { persistCount += 1; },
  handleInteraction: async () => {},
  log: {
    info: (message: string) => { infoLogs.push(message); },
    error: (message: string) => { errorLogs.push(message); },
  },
};

const messageResult = await dispatchCustomInboundGatewayEvent({
  accountId: "default",
  eventType: "C2C_MESSAGE_CREATE",
  data: {
    id: "MSG_C2C",
    content: "hello",
    timestamp: "2026-06-21T00:00:00.000Z",
    author: { user_openid: "USER_OPENID" },
  },
  ...baseCallbacks,
});
assert.deepEqual(messageResult, { kind: "message", knownUsers: 1 });
assert.equal((knownUsers.at(-1) as any)?.openid, "USER_OPENID");
assert.equal(enqueued.at(-1)?.type, "c2c");
assert.equal(enqueued.at(-1)?.senderId, "USER_OPENID");

const proactiveResult = await dispatchCustomInboundGatewayEvent({
  accountId: "default",
  eventType: "GROUP_MSG_RECEIVE",
  data: {
    timestamp: 1_000,
    group_openid: "GROUP_OPENID",
    op_member_openid: "MEMBER_OPENID",
  },
  ...baseCallbacks,
});
assert.deepEqual(proactiveResult, { kind: "proactive-acceptance", accepted: true });
assert.equal((acceptances.at(-1) as any)?.peer.id, "GROUP_OPENID");
assert.equal((acceptances.at(-1) as any)?.updatedBy, "MEMBER_OPENID");
assert.equal((acceptances.at(-1) as any)?.now, 1_000_000);
assert.equal(persistCount, 1);
assert.equal(infoLogs.some((line) => line.includes("accepted bot proactive messages")), true);

const robotResult = await dispatchCustomInboundGatewayEvent({
  accountId: "default",
  eventType: "GROUP_ADD_ROBOT",
  data: {
    timestamp: "2026-06-21T00:00:00.000Z",
    group_openid: "GROUP_OPENID",
    op_member_openid: "OP_MEMBER_OPENID",
  },
  ...baseCallbacks,
});
assert.deepEqual(robotResult, { kind: "group-robot", knownUsers: 1 });
assert.equal((knownUsers.at(-1) as any)?.openid, "OP_MEMBER_OPENID");
assert.equal(infoLogs.some((line) => line.includes("Bot added to group")), true);

const deleteResult = await dispatchCustomInboundGatewayEvent({
  accountId: "default",
  eventType: "MESSAGE_DELETE",
  data: {
    message: {
      id: "MSG_DELETE",
      channel_id: "CHANNEL_ID",
      guild_id: "GUILD_ID",
      author: { id: "AUTHOR_ID" },
      timestamp: "2026-06-21T00:00:00.000Z",
    },
    op_user_id: "OPERATOR_ID",
  },
  ...baseCallbacks,
});
assert.deepEqual(deleteResult, { kind: "delete-diagnostics", logged: true });
assert.equal(infoLogs.some((line) => line.includes("Message delete diagnostics")), true);
assert.equal(infoLogs.some((line) => line.includes("message=MSG_DELETE")), true);
assert.equal(infoLogs.some((line) => line.includes("operator=OPERATOR_ID")), true);

const handledInteractions: unknown[] = [];
const interactionResult = await dispatchCustomInboundGatewayEvent({
  accountId: "default",
  eventType: "INTERACTION_CREATE",
  data: {
    id: "INTERACTION_1",
    scene: "group",
    data: {
      type: 11,
      resolved: {
        button_id: "button-1",
        button_data: "custom-auth:req:allow-once",
      },
    },
    group_openid: "GROUP_OPENID",
    group_member_openid: "MEMBER_OPENID",
  },
  ...baseCallbacks,
  handleInteraction: async (event) => { handledInteractions.push(event); },
});
assert.deepEqual(interactionResult, { kind: "interaction", id: "INTERACTION_1" });
assert.equal((handledInteractions.at(-1) as any)?.id, "INTERACTION_1");
assert.equal(infoLogs.some((line) => line.includes("Interaction: scene=group")), true);
assert.equal(infoLogs.some((line) => line.includes("button_data=custom-auth:req:allow-once")), true);

await dispatchCustomInboundGatewayEvent({
  accountId: "default",
  eventType: "INTERACTION_CREATE",
  data: {
    id: "INTERACTION_FAIL",
    data: { type: 11, resolved: { button_data: "boom" } },
  },
  ...baseCallbacks,
  handleInteraction: async () => { throw new Error("interaction failed"); },
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(errorLogs.some((line) => line.includes("Failed to handle interaction INTERACTION_FAIL")), true);

const unsupported = await dispatchCustomInboundGatewayEvent({
  accountId: "default",
  eventType: "UNKNOWN_EVENT",
  data: {},
  ...baseCallbacks,
});
assert.deepEqual(unsupported, { kind: "unsupported" });

console.log("custom inbound event gateway adapter tests passed");
