import assert from "node:assert";
import { applyCustomSceneAgentRoute } from "../src/custom/route.js";
import {
  buildCustomSceneSystemPrompt,
  defaultSceneCapabilities,
  formatCustomPeerKey,
  formatCustomPeerKindWildcard,
  getCustomSceneProfile,
  resolveCustomScene,
} from "../src/custom/scenes.js";
import type { CustomPeer, CustomRuntimeConfig } from "../src/custom/types.js";

const groupPeer: CustomPeer = { kind: "group", id: "GROUP_OPENID", label: "Master Luke" };
const dmPeer: CustomPeer = { kind: "c2c", id: "USER_OPENID", label: "Luke" };

assert.equal(formatCustomPeerKey(groupPeer), "qqbot:group:GROUP_OPENID");
assert.equal(formatCustomPeerKindWildcard(groupPeer), "qqbot:group:*");
assert.deepEqual(defaultSceneCapabilities("chat"), ["chat.send", "web.search"]);
assert.equal(getCustomSceneProfile("dev-lab").capabilities.includes("codex.longTask"), true);

const defaultGroup = resolveCustomScene({ enabled: true }, groupPeer);
assert.equal(defaultGroup.source, "default");
assert.equal(defaultGroup.config.scene, "chat");
assert.deepEqual(defaultGroup.capabilities, ["chat.send", "web.search"]);
assert.equal(defaultGroup.profile.allowAutonomousReply, true);
assert.equal(defaultGroup.profile.allowProactiveSend, true);

const defaultDm = resolveCustomScene({ enabled: true }, dmPeer);
assert.equal(defaultDm.config.scene, "default-dm");
assert.equal(defaultDm.capabilities.includes("codex.run"), true);

const runtime: CustomRuntimeConfig = {
  enabled: true,
  defaultScene: "default-dm",
  scenes: {
    "qqbot:group:*": {
      scene: "codex-only",
      label: "all groups",
    },
    "qqbot:group:GROUP_OPENID": {
      scene: "dev-lab",
      label: "dev group",
      capabilities: ["chat.send", "codex.run", "codex.run", "deploy.check"],
      allowAutonomousReply: true,
      systemPrompt: "只处理二开开发上下文。",
    },
    "*": {
      scene: "chat",
      label: "fallback",
    },
  },
};

const exact = resolveCustomScene(runtime, groupPeer);
assert.equal(exact.source, "exact");
assert.equal(exact.key, "qqbot:group:GROUP_OPENID");
assert.equal(exact.config.scene, "dev-lab");
assert.equal(exact.profile.label, "dev group");
assert.deepEqual(exact.capabilities, ["chat.send", "codex.run", "deploy.check"]);
assert.equal(exact.profile.allowAutonomousReply, true);
assert.equal(exact.profile.allowProactiveSend, false);
assert.equal(buildCustomSceneSystemPrompt(exact).includes("只处理二开开发上下文。"), true);

const otherGroup = resolveCustomScene(runtime, { kind: "group", id: "OTHER_GROUP" });
assert.equal(otherGroup.source, "kind-wildcard");
assert.equal(otherGroup.config.scene, "codex-only");
assert.deepEqual(otherGroup.capabilities, ["web.search", "codex.run", "codex.longTask"]);

const fallback = resolveCustomScene(runtime, { kind: "dm", id: "GUILD_DM" });
assert.equal(fallback.source, "wildcard");
assert.equal(fallback.config.scene, "chat");

const disabled = resolveCustomScene({
  enabled: true,
  scenes: {
    "qqbot:group:GROUP_OPENID": {
      scene: "chat",
      enabled: false,
    },
  },
}, groupPeer);
assert.equal(disabled.enabled, false);
assert.equal(buildCustomSceneSystemPrompt(disabled).includes("当前场景已禁用"), true);

const routedScene = resolveCustomScene({
  enabled: true,
  scenes: {
    "qqbot:group:GROUP_OPENID": {
      scene: "dev-lab",
      agentId: "Dev-Agent",
    },
  },
}, groupPeer);
const route = applyCustomSceneAgentRoute({
  route: {
    agentId: "main",
    channel: "qqbot",
    accountId: "default",
    sessionKey: "agent:main:qqbot:group:group_openid",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session",
    matchedBy: "default",
  },
  scene: routedScene,
  routing: {
    buildAgentSessionKey: ({ agentId, channel, accountId, peer }) =>
      `agent:${agentId.toLowerCase()}:${channel}:${accountId}:${peer?.kind}:${peer?.id.toLowerCase()}`,
  },
  peer: { kind: "group", id: "GROUP_OPENID" },
});
assert.equal(route.agentId, "dev-agent");
assert.equal(route.sessionKey, "agent:dev-agent:qqbot:default:group:group_openid");
assert.equal(route.mainSessionKey, "agent:dev-agent:main");
assert.equal(route.matchedBy, "custom.scene.exact");
assert.equal(route.lastRoutePolicy, "session");

const routeFallsBackWhenAgentListDoesNotContainSceneAgent = applyCustomSceneAgentRoute({
  route: {
    agentId: "main",
    channel: "qqbot",
    accountId: "default",
    sessionKey: "agent:main:qqbot:group:group_openid",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session",
    matchedBy: "default",
  },
  scene: routedScene,
  routing: {
    buildAgentSessionKey: ({ agentId, channel, accountId, peer }) =>
      `agent:${agentId}:${channel}:${accountId}:${peer?.kind}:${peer?.id.toLowerCase()}`,
  },
  peer: { kind: "group", id: "GROUP_OPENID" },
  cfg: {
    agents: {
      list: [{ id: "main" }],
    },
  },
});
assert.equal(routeFallsBackWhenAgentListDoesNotContainSceneAgent.agentId, "main");
assert.equal(routeFallsBackWhenAgentListDoesNotContainSceneAgent.sessionKey, "agent:main:qqbot:group:group_openid");

console.log("custom scenes tests passed");
