import assert from "node:assert";
import { createCustomInteractionCreateHandlerGateway } from "../src/custom/interaction-create-handler-gateway-adapter.js";
import type { InteractionEvent } from "../src/types.js";

const interaction: InteractionEvent = {
  id: "interaction-1",
  type: 11,
  scene: "group",
  chat_type: 1,
  group_openid: "GROUP_OPENID",
  group_member_openid: "MEMBER_OPENID",
  version: 1,
  data: {
    type: 1,
    resolved: {
      button_data: "custom-poll:poll-1:vote:2",
    },
  },
};

const tokenCalls: string[] = [];
const acknowledgements: unknown[] = [];
const replies: string[] = [];

const handler = createCustomInteractionCreateHandlerGateway({
  account: {
    accountId: "default",
    appId: "APP",
    clientSecret: "SECRET",
  },
  cfg: { channels: { qqbot: {} } },
  runtime: {
    auth: {} as any,
    polls: {} as any,
    games: {} as any,
    deployConfirmations: {} as any,
  },
  persistAuthState: () => {},
  persistPollState: () => {},
  persistGameState: () => {},
  persistDeployConfirmationState: () => {},
  getConfigApi: () => ({ loadConfig: () => ({}), writeConfigFile: async () => {} }),
  getRouting: () => ({ resolveAgentRoute: () => ({}) }) as any,
  getLegacyApprovalHandler: (accountId) => {
    assert.equal(accountId, "default");
    return undefined;
  },
  getAccessToken: async (appId, clientSecret) => {
    tokenCalls.push(`${appId}:${clientSecret}`);
    return "TOKEN";
  },
  acknowledgeInteraction: async (token, interactionId, code, data) => {
    acknowledgements.push({ token, interactionId, code, data });
  },
  sendGroupMessage: async (token, groupOpenid, text) => {
    replies.push(`group:${token}:${groupOpenid}:${text}`);
  },
  sendC2CMessage: async (token, userOpenid, text) => {
    replies.push(`c2c:${token}:${userOpenid}:${text}`);
  },
  sendChannelMessage: async (token, channelId, text) => {
    replies.push(`channel:${token}:${channelId}:${text}`);
  },
  getApiPluginVersion: () => "plugin-1.0.0",
  getFrameworkVersion: () => "framework-1.0.0",
  handleInteractionCreate: async (params) => {
    assert.equal(params.accountId, "default");
    assert.equal(params.event.id, "interaction-1");
    assert.equal(params.pluginVersion, "plugin-1.0.0");
    assert.equal(params.frameworkVersion, "framework-1.0.0");
    assert.deepEqual(params.routing, { resolveAgentRoute: params.routing?.resolveAgentRoute });
    await params.acknowledge(0, { claw_cfg: { require_mention: "always" } });
    await params.sendReply({ kind: "group", groupOpenid: "GROUP_OPENID" }, "group reply");
    await params.sendReply({ kind: "c2c", userOpenid: "USER_OPENID" }, "c2c reply");
    await params.sendReply({ kind: "channel", channelId: "CHANNEL_ID" }, "channel reply");
    return { kind: "ack-only", interactionId: params.event.id };
  },
});

const result = await handler(interaction);

assert.deepEqual(result, { kind: "ack-only", interactionId: "interaction-1" });
assert.deepEqual(tokenCalls, ["APP:SECRET"]);
assert.deepEqual(acknowledgements, [{
  token: "TOKEN",
  interactionId: "interaction-1",
  code: 0,
  data: { claw_cfg: { require_mention: "always" } },
}]);
assert.deepEqual(replies, [
  "group:TOKEN:GROUP_OPENID:group reply",
  "c2c:TOKEN:USER_OPENID:c2c reply",
  "channel:TOKEN:CHANNEL_ID:channel reply",
]);

console.log("custom interaction create handler gateway adapter tests passed");
