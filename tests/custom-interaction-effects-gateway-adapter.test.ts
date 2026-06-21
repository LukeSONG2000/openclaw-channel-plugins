import assert from "node:assert";
import { applyCustomInteractionGatewayEffects } from "../src/custom/interaction-effects-gateway-adapter.js";

const infoLogs: string[] = [];
const errorLogs: string[] = [];
const persistCounts: Record<string, number> = {
  auth: 0,
  polls: 0,
  games: 0,
  deploy: 0,
};
const sentReplies: Array<{ target: unknown; text: string }> = [];

const allEffects = await applyCustomInteractionGatewayEffects({
  accountId: "default",
  result: {
    handled: true,
    reply: "done",
    persist: {
      auth: true,
      polls: true,
      games: true,
      deployConfirmations: true,
    },
    logs: [
      { level: "info", message: "custom info" },
      { level: "error", message: "custom error" },
    ],
  },
  replyTarget: { kind: "group", groupOpenid: "GROUP_OPENID" },
  persistAuthState: () => { persistCounts.auth += 1; },
  persistPollState: () => { persistCounts.polls += 1; },
  persistGameState: () => { persistCounts.games += 1; },
  persistDeployConfirmationState: () => { persistCounts.deploy += 1; },
  sendReply: async (target, text) => { sentReplies.push({ target, text }); },
  log: {
    info: (message) => { infoLogs.push(message); },
    error: (message) => { errorLogs.push(message); },
  },
});

assert.deepEqual(persistCounts, { auth: 1, polls: 1, games: 1, deploy: 1 });
assert.equal(allEffects.authPersisted, true);
assert.equal(allEffects.pollsPersisted, true);
assert.equal(allEffects.gamesPersisted, true);
assert.equal(allEffects.deployConfirmationsPersisted, true);
assert.equal(allEffects.replyDelivered, true);
assert.equal(allEffects.replySkipped, false);
assert.equal(allEffects.replyFailed, false);
assert.deepEqual(sentReplies[0], { target: { kind: "group", groupOpenid: "GROUP_OPENID" }, text: "done" });
assert.equal(infoLogs.some((line) => line.includes("custom info")), true);
assert.equal(errorLogs.some((line) => line.includes("custom error")), true);

const c2cReply = await applyCustomInteractionGatewayEffects({
  accountId: "default",
  result: { handled: true, reply: "c2c done" },
  replyTarget: { kind: "c2c", userOpenid: "USER_OPENID" },
  sendReply: async (target, text) => { sentReplies.push({ target, text }); },
});
assert.equal(c2cReply.replyDelivered, true);
assert.deepEqual(sentReplies.at(-1), { target: { kind: "c2c", userOpenid: "USER_OPENID" }, text: "c2c done" });

const channelReply = await applyCustomInteractionGatewayEffects({
  accountId: "default",
  result: { handled: true, reply: "channel done" },
  replyTarget: { kind: "channel", channelId: "CHANNEL_ID" },
  sendReply: async (target, text) => { sentReplies.push({ target, text }); },
});
assert.equal(channelReply.replyDelivered, true);
assert.deepEqual(sentReplies.at(-1), { target: { kind: "channel", channelId: "CHANNEL_ID" }, text: "channel done" });

const skipped = await applyCustomInteractionGatewayEffects({
  accountId: "default",
  result: { handled: true, reply: "no target" },
  sendReply: async () => { throw new Error("should not send"); },
});
assert.equal(skipped.replySkipped, true);
assert.equal(skipped.replyDelivered, false);

const failedErrors: string[] = [];
const failed = await applyCustomInteractionGatewayEffects({
  accountId: "default",
  result: { handled: true, reply: "will fail" },
  replyTarget: { kind: "group", groupOpenid: "GROUP_OPENID" },
  sendReply: async () => { throw new Error("send failed"); },
  log: { error: (message) => { failedErrors.push(message); } },
});
assert.equal(failed.replyFailed, true);
assert.equal(failed.replyDelivered, false);
assert.equal(failedErrors.some((line) => line.includes("Failed to send custom interaction reply")), true);

const missingCallbacks = await applyCustomInteractionGatewayEffects({
  accountId: "default",
  result: {
    handled: true,
    persist: {
      auth: true,
      polls: true,
      games: true,
      deployConfirmations: true,
    },
  },
});
assert.equal(missingCallbacks.authPersisted, false);
assert.equal(missingCallbacks.pollsPersisted, false);
assert.equal(missingCallbacks.gamesPersisted, false);
assert.equal(missingCallbacks.deployConfirmationsPersisted, false);

console.log("custom interaction effects gateway adapter tests passed");
