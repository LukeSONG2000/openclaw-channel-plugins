import assert from "node:assert";
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
assert.deepEqual(defaultSceneCapabilities("chat"), ["chat.send"]);
assert.equal(getCustomSceneProfile("dev-lab").capabilities.includes("codex.longTask"), true);

const defaultGroup = resolveCustomScene({ enabled: true }, groupPeer);
assert.equal(defaultGroup.source, "default");
assert.equal(defaultGroup.config.scene, "chat");
assert.deepEqual(defaultGroup.capabilities, ["chat.send"]);
assert.equal(defaultGroup.profile.allowAutonomousReply, false);

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
assert.deepEqual(otherGroup.capabilities, ["codex.run", "codex.longTask"]);

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

console.log("custom scenes tests passed");
