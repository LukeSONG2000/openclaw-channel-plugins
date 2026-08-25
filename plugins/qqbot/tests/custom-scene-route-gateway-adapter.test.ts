import assert from "node:assert";
import { applyCustomSceneRouteGateway } from "../src/custom/scene-route-gateway-adapter.js";
import type { CustomAgentRoute } from "../src/custom/route.js";

const baseRoute: CustomAgentRoute = {
  agentId: "main",
  channel: "qqbot",
  accountId: "default",
  sessionKey: "agent:main:qqbot:group:GROUP_OPENID",
  mainSessionKey: "agent:main:main",
  lastRoutePolicy: "session",
  matchedBy: "default",
};

const cfg = {
  agents: {
    list: [{ id: "dev-agent" }, { id: "main" }],
  },
  channels: {
    qqbot: {
      customRuntime: {
        enabled: true,
        scenes: {
          "qqbot:group:GROUP_OPENID": {
            scene: "dev-lab",
            agentId: "dev-agent",
            systemPrompt: "自定义 dev lab prompt",
          },
          "qqbot:group:DISABLED_GROUP": {
            scene: "chat",
            enabled: false,
          },
        },
      },
    },
  },
} as any;

{
  const logs: string[] = [];
  const result = applyCustomSceneRouteGateway({
    cfg,
    accountId: "default",
    senderId: "MEMBER_OPENID",
    baseRoute,
    routePeer: { kind: "group", id: "GROUP_OPENID" },
    customScenePeer: { kind: "group", id: "GROUP_OPENID" },
    customRuntimeEnabled: true,
    accountSystemPrompt: "account prompt",
    routing: {
      buildAgentSessionKey: ({ agentId, peer }) => `custom:${agentId}:${peer?.kind}:${peer?.id}`,
    },
    log: { info: (msg) => logs.push(msg) },
  });

  assert.equal(result.action, "continue");
  assert.equal(result.scene?.key, "qqbot:group:GROUP_OPENID");
  assert.equal(result.route.agentId, "dev-agent");
  assert.equal(result.route.sessionKey, "custom:dev-agent:group:GROUP_OPENID");
  assert.equal(result.route.matchedBy, "custom.scene.exact");
  assert.equal(result.systemPrompts[0], "account prompt");
  assert.equal(result.systemPrompts[1]?.includes("自定义 dev lab prompt"), true);
  assert.equal(logs.some((line) => line.includes("Custom scene route")), true);
}

{
  const logs: string[] = [];
  const result = applyCustomSceneRouteGateway({
    cfg,
    accountId: "default",
    senderId: "MEMBER_OPENID",
    baseRoute,
    routePeer: { kind: "group", id: "DISABLED_GROUP" },
    customScenePeer: { kind: "group", id: "DISABLED_GROUP" },
    customRuntimeEnabled: true,
    accountSystemPrompt: "account prompt",
    log: { info: (msg) => logs.push(msg) },
  });

  assert.equal(result.action, "stop");
  assert.equal(result.reason, "scene_disabled");
  assert.equal(result.route, baseRoute);
  assert.deepEqual(result.systemPrompts, ["account prompt"]);
  assert.equal(logs.some((line) => line.includes("Custom scene disabled")), true);
}

{
  const result = applyCustomSceneRouteGateway({
    cfg,
    accountId: "default",
    senderId: "USER_OPENID",
    baseRoute,
    routePeer: { kind: "direct", id: "USER_OPENID" },
    customScenePeer: { kind: "c2c", id: "USER_OPENID" },
    customRuntimeEnabled: false,
  });

  assert.equal(result.action, "continue");
  assert.equal(result.scene, null);
  assert.equal(result.route, baseRoute);
  assert.deepEqual(result.systemPrompts, []);
}

console.log("custom scene route gateway adapter tests passed");
